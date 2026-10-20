const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(readPage) {
  const routes = new Map(), calls = [];
  const router = { get: (url, handler) => routes.set(url, handler), post() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/engajamento.js'), 'utf8'), {
    module: { exports: {} }, process: { env: { SUPABASE_URL: 'https://fixture.invalid' } }, Date, URL, AbortSignal,
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name.includes('metricas')) return require('../src/services/metricas');
      return {};
    },
    fetch: async (url, options) => { calls.push(url); assert.ok(options.signal); const data = await readPage(new URL(url)); return { ok: true, text: async () => JSON.stringify(data) }; },
  });
  const response = () => ({ data: null, set() {}, json(data) { this.data = data; } });
  return { route: routes.get('/vitrines'), calls, response };
}

test('best sellers use paginated paid items, real quantities and a short shared cache', async () => {
  const fixture = setup(async url => {
    assert.equal(url.pathname, '/rest/v1/itens_pedido');
    assert.equal(url.searchParams.get('pedidos.status'), 'eq.pago');
    assert.match(url.searchParams.get('pedidos.pago_em'), /^gte\./);
    if (url.searchParams.get('offset') === '0') return Array.from({ length: 500 }, (_, id) => ({ id, produto_id: 1, quantidade: 1 }));
    return [{ id: 501, produto_id: 2, quantidade: 600 }, { id: 502, produto_id: 3, quantidade: -99 }];
  });
  const first = fixture.response(), second = fixture.response();
  await Promise.all([fixture.route({}, first), fixture.route({}, second)]);
  assert.deepEqual(Array.from(first.data.mais_vendidos), [2, 1]);
  assert.equal(fixture.calls.length, 2);
  await fixture.route({}, fixture.response());
  assert.equal(fixture.calls.length, 2);
});

test('unavailable sales never fall back to untrusted client purchase events and can retry', async () => {
  let failing = true;
  const fixture = setup(async () => { if (failing) throw Error('offline'); return []; });
  await assert.rejects(fixture.route({}, fixture.response()), /offline/);
  assert.ok(fixture.calls.every(url => !url.includes('metricas_eventos')));
  failing = false;
  const res = fixture.response();
  await fixture.route({}, res);
  assert.equal(res.data.mais_vendidos.length, 0);
});
