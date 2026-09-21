const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRoute(currentOrder) {
  const routes = new Map();
  const calls = [];
  const notifications = [];
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/pedidosAdmin.js'), 'utf8'), {
    module: { exports: {} }, process: { env: {} }, URL, Date,
    require: name => {
      if (name === 'express') return { Router: () => router };
      if (name.includes('notificacoes')) return { notificarPedido: async (...args) => notifications.push(args) };
      return { requireAdmin() {} };
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      const data = options.method === 'PATCH' ? [{ id: 1, ...JSON.parse(options.body) }] : (currentOrder ? [currentOrder] : []);
      return { ok: true, text: async () => JSON.stringify(data) };
    },
  });
  return { route: routes.get('patch /pedidos/:id'), calls, notifications };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
}

test('admin cannot manually change payment state while stock is reserved', async () => {
  const { route, calls } = loadRoute({ id: 1, status: 'pendente', mp_preference_id: 'pref', reserva_estado: 'ativa' });
  const res = response();
  await route({ params: { id: '1' }, body: { status: 'pago' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.data.erro, /estoque reservado/i);
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
});

test('admin leaves Mercado Pago financial states to verified webhooks', async () => {
  const { route, calls } = loadRoute({ id: 1, status: 'pendente', mp_preference_id: 'pref', reserva_estado: null });
  const res = response();
  await route({ params: { id: '1' }, body: { status: 'reembolsado' } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.data.erro, /Mercado Pago/i);
  assert.equal(calls.some(call => call.method === 'PATCH'), false);
});

test('admin can still update shipping and manual orders safely', async () => {
  const linked = loadRoute({ id: 1, status: 'pago', envio_status: 'aguardando_envio', mp_preference_id: 'pref', reserva_estado: 'consumida' });
  const shipping = response();
  await linked.route({ params: { id: '1' }, body: { envio_status: 'enviado', codigo_rastreio: 'BR123' } }, shipping);
  assert.equal(shipping.statusCode, 200);
  assert.equal(linked.calls.filter(call => call.method === 'PATCH').length, 1);
  assert.deepEqual(linked.notifications, [[1, 'enviado']]);

  const manual = loadRoute({ id: 1, status: 'pendente', mp_preference_id: null, reserva_estado: null });
  const paid = response();
  await manual.route({ params: { id: '1' }, body: { status: 'pago' } }, paid);
  assert.equal(paid.statusCode, 200);
  assert.equal(manual.calls.filter(call => call.method === 'PATCH').length, 1);
});
