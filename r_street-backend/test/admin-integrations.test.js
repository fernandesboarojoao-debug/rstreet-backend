const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(order) {
  const routes = new Map();
  let protectedRouter = false, sends = 0;
  const auth = () => {};
  const router = { use: fn => { protectedRouter = fn === auth; } };
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) router[method] = (path, handler) => routes.set(`${method} ${path}`, handler);
  const notifications = { currentOrderEvent: require('../src/services/notificacoes').currentOrderEvent,
    isConfigured: () => false, EVENTS: {}, notificarPedido: async () => { sends++; return { sent: true }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/pedidosAdmin.js'), 'utf8'), {
    module: { exports: {} }, process: { env: {} }, URL, URLSearchParams, Date,
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name.includes('adminAuth')) return { requireAdmin: auth };
      if (name.includes('notificacoes')) return notifications;
      if (name.includes('reservas')) return { reservasAtivadas: () => true };
      if (name.endsWith('/db')) return { buscarPedido: async () => order, buscarItensPedido: async () => [{ produto_id: 1, produto_variante_id: 11, nome_produto: 'Cinto', cor: 'Preto', tamanho: 'M', quantidade: 2 }] };
      return {};
    },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify([{ id: 1, referencia: 'REF-1' }]) })
  });
  return { routes, protectedRouter, notifications, sends: () => sends };
}
function response() { return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
  set(name, value) { this.headers[name] = value; return this; }, json(data) { this.data = data; return this; } }; }

test('integration export is admin-only, paid-only and excludes customer data', async () => {
  const fixture = setup({ id: 1, status: 'pago', total: 20, cliente_email: 'private@example.test', cliente_cpf: 'secret' });
  assert.equal(fixture.protectedRouter, true);
  const res = response();
  await fixture.routes.get('get /pedidos/:id/integracao')({ params: { id: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.evento_id, 'rstreet:pedido:1:pago');
  assert.equal(res.data.itens[0].variante_id, 11);
  assert.equal(res.data.itens[0].referencia, 'REF-1');
  assert.doesNotMatch(JSON.stringify(res.data), /private|secret/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const pending = setup({ id: 1, status: 'pendente' }), blocked = response();
  await pending.routes.get('get /pedidos/:id/integracao')({ params: { id: '1' } }, blocked);
  assert.equal(blocked.statusCode, 409);
});

test('notification action blocks pending orders and missing mail configuration', async () => {
  for (const status of ['pendente', 'pago']) {
    const fixture = setup({ id: 1, status }), res = response();
    await fixture.routes.get('post /pedidos/:id/aviso')({ params: { id: '1' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(fixture.sends(), 0);
  }
});
