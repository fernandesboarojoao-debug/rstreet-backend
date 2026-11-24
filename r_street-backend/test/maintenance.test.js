'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { maintenanceGuard, operationStatus } = require('../src/middleware/maintenance');

test('migration diagnostics preserve the existing admin operation response', async () => {
  const router = require('../src/routes/pedidosAdmin');
  const routes = router.stack.filter(layer => layer.route?.path === '/operacao');
  assert.equal(routes.length, 1);
  let body;
  await routes[0].route.stack[0].handle({}, { json(value) { body = value; } });
  assert.ok(body.email && body.estoque && Array.isArray(body.eventos_email));
  assert.equal(body.versao, 1);
  assert.equal(typeof body.checkoutMaintenance, 'boolean');
  assert.equal(typeof body.migrationWriteLock, 'boolean');
  assert.ok(!Object.hasOwn(body, 'SUPABASE_KEY'));
});

test('maintenance blocks new sales and migrations without blocking existing payments', () => {
  const old = { checkout: process.env.CHECKOUT_MAINTENANCE, lock: process.env.MIGRATION_WRITE_LOCK };
  function run(method, path) {
    let allowed = false;
    const res = { set(headers) { this.headers = headers; }, status(value) { this.code = value; return this; }, json(body) { this.body = body; return this; } };
    maintenanceGuard({ method, path }, res, () => { allowed = true; });
    return { allowed, ...res };
  }
  try {
    process.env.CHECKOUT_MAINTENANCE = 'false'; process.env.MIGRATION_WRITE_LOCK = 'false';
    assert.equal(run('POST', '/api/pagamento/criar').allowed, true);
    process.env.CHECKOUT_MAINTENANCE = 'true';
    for (const path of ['/api/pagamento/criar', '/api/pagamento/criar/', '/API/Pagamento/CRIAR']) {
      const result = run('POST', path); assert.equal(result.code, 503);
      assert.equal(result.headers['Cache-Control'], 'no-store'); assert.equal(result.body.code, 'STORE_MAINTENANCE');
    }
    assert.equal(run('PATCH', '/api/produtos/30').allowed, true);
    process.env.MIGRATION_WRITE_LOCK = 'true';
    for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(run(method, '/api/admin/pedidos').allowed, true);
    for (const path of ['/api/auth/login', '/api/pedidos/acompanhar', '/api/pedidos/confirmacao', '/api/webhook/mercadopago/']) assert.equal(run('POST', path).allowed, true);
    for (const [method, path] of [['POST', '/api/pagamento/criar'], ['PATCH', '/api/produtos/30'], ['DELETE', '/api/produtos/30'], ['POST', '/api/engajamento/metricas'], ['POST', '/api/admin/pedidos/1/aviso'], ['POST', '/api/auth/login/other']]) assert.equal(run(method, path).code, 503);
    assert.deepEqual(operationStatus({ CHECKOUT_MAINTENANCE: 'TRUE' }), { checkoutMaintenance: false, migrationWriteLock: false });
  } finally {
    for (const [key, value] of [['CHECKOUT_MAINTENANCE', old.checkout], ['MIGRATION_WRITE_LOCK', old.lock]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
