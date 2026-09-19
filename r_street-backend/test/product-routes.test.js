const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRoutes(reply = () => ({ ok: true, data: [] })) {
  const routes = new Map();
  const calls = [];
  const router = { use() {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (url, handler) => routes.set(`${method} ${url}`, handler);
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes/produtos.js'), 'utf8'), {
    module: { exports: {} }, process: { env: {} }, URL, Buffer,
    require: name => name === 'express' ? { Router: () => router } : { requireAdmin() {} },
    fetch: async (url, options = {}) => {
      calls.push({ url, ...options });
      const response = reply(url, options);
      return { ok: response.ok, text: async () => JSON.stringify(response.data) };
    },
  });
  return { routes, calls };
}

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
}

test('variant saving uses one atomic RPC and never deletes existing rows', async () => {
  const { routes, calls } = loadRoutes();
  const res = response();
  await routes.get('put /:id/variantes')({ params: { id: '1' }, body: { variantes: [
    { id: 10, cor: 'Azul', tamanho: 'M', estoque: 2, estoque_original: 3 },
  ] } }, res);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rpc\/salvar_variantes_seguras$/);
  assert.equal(calls[0].method, 'POST');
  const body = JSON.parse(calls[0].body);
  assert.equal(body.p_variantes[0].id, 10);
  assert.equal(body.p_variantes[0].estoque_original, 3);
});

test('invalid variant list never reaches the database and stock conflicts are readable', async () => {
  const { routes, calls } = loadRoutes(() => ({ ok: false, data: { code: 'P0001', message: 'Estoque mudou. Reabra o produto.' } }));
  const save = routes.get('put /:id/variantes');
  for (const variantes of [undefined, [{ cor: '', tamanho: 'M' }]]) {
    const res = response();
    await save({ params: { id: '1' }, body: { variantes } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(save({ params: { id: '1' }, body: { variantes: [] } }, response()), error => {
    assert.equal(error.status, 409);
    assert.equal(error.expose, true);
    return /Estoque mudou/.test(error.message);
  });
});

test('editing product details cannot overwrite the stock total of its variants', async () => {
  const { routes, calls } = loadRoutes(url => ({ ok: true, data: url.includes('produto_variantes') ? [{ id: 10 }] : [] }));
  await routes.get('patch /:id')({ params: { id: '1' }, body: { estoque: 99, nome: 'Produto atualizado' } }, response());
  const patch = calls.find(call => call.method === 'PATCH');
  assert.ok(patch);
  assert.equal(Object.hasOwn(JSON.parse(patch.body), 'estoque'), false);
  assert.equal(JSON.parse(patch.body).nome, 'Produto atualizado');
});
