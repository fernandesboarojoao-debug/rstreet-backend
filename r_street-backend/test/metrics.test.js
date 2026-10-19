const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, readPages, loadMetrics } = require('../src/services/metricas');

test('metrics use paid orders, not client purchase events, for sales and revenue', () => {
  const data = summarize([
    { tipo: 'view_item', sessao_id: 'a', produto_id: 1 },
    { tipo: 'add_to_cart', sessao_id: 'a', produto_id: 1 },
    { tipo: 'begin_checkout', sessao_id: 'a' },
    { tipo: 'purchase', sessao_id: 'b', valor: 999999 },
  ], [{ total: 99.9 }, { total: 80 }], [{ produto_id: 1, quantidade: 3 }], [{ id: 1, nome: 'Cinto', marca: 'Freeway' }]);
  assert.equal(data.totais.purchase, 2);
  assert.equal(data.receita, 179.9);
  assert.equal(data.ticket_medio, 89.95);
  assert.equal(data.sessoes.checkout_sem_confirmacao, 1);
  assert.equal(data.produtos[0].compras, 3);
  assert.equal(data.produtos[0].nome, 'Cinto');
});

test('metrics read past the first API page and reject invalid responses', async () => {
  const urls = [];
  const result = await readPages(async url => {
    urls.push(new URL(url, 'https://fixture.test'));
    return urls.length === 1 ? Array.from({ length: 500 }, (_, id) => ({ id })) : [{ id: 501 }];
  }, 'metricas_eventos', { order: 'id.asc' });
  assert.equal(result.rows.length, 501);
  assert.equal(urls[1].searchParams.get('offset'), '500');
  assert.equal(result.limited, false);
  await assert.rejects(readPages(async () => ({}), 'metricas_eventos', {}));
});

test('metrics restrict both revenue and quantities to the paid period', async () => {
  const calls = [];
  const data = await loadMetrics(async path => { calls.push(new URL(path, 'https://fixture.test')); return []; }, 7);
  const orders = calls.find(url => url.pathname === '/pedidos');
  const items = calls.find(url => url.pathname === '/itens_pedido');
  assert.equal(orders.searchParams.get('status'), 'eq.pago');
  assert.equal(items.searchParams.get('pedidos.status'), 'eq.pago');
  assert.equal(items.searchParams.get('pedidos.pago_em'), orders.searchParams.get('pago_em'));
  assert.match(items.searchParams.get('select'), /pedidos!inner/);
  assert.equal(data.periodo_dias, 7);
  assert.equal(data.receita, 0);
  assert.equal(data.ticket_medio, 0);
});
