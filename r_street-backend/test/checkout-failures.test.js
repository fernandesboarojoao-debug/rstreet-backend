const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/services/db');
const mp = require('../src/services/mercadopago');
const { criarPagamento } = require('../src/controllers/pagamentoController');

function setup(t) {
  const calls = { releases: 0, creates: 0, updates: [], preferences: 0 };
  const input = {
    checkout_token: '123e4567-e89b-42d3-a456-426614174000',
    cliente: { nome: 'Teste Local', email: 'teste@example.com', telefone: '19999999999' },
    endereco: { cep: '13720000', rua: 'Rua teste', numero: '1', bairro: 'Centro', cidade: 'Sao Jose do Rio Pardo', estado: 'SP' },
    itens: [{ id: 1, quantidade: 1 }],
    frete: { tipo: 'Entrega local', valor: 0 }, metodo_pagamento: 'credit_card', total: 100,
  };
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ localidade: 'Sao Jose do Rio Pardo', uf: 'SP' }) }));
  t.mock.method(db, 'buscarPedidoPorCheckoutToken', async () => null);
  t.mock.method(db, 'buscarProdutosPorIds', async () => [{ id: 1, nome: 'Produto', preco: 100, estoque: 1, ativo: true }]);
  t.mock.method(db, 'buscarVariantesPorIds', async () => []);
  t.mock.method(db, 'buscarVariantesPorProdutoIds', async () => []);
  t.mock.method(db, 'criarPedido', async () => { calls.creates++; return { id: 42 }; });
  t.mock.method(db, 'criarItensPedido', async () => {});
  t.mock.method(db, 'reservarEstoquePedido', async () => ({ reserva_expira_em: new Date(Date.now() + 600000).toISOString() }));
  t.mock.method(db, 'liberarReservaPedido', async () => { calls.releases++; return true; });
  t.mock.method(db, 'atualizarPedido', async (_id, data) => { calls.updates.push(data); });
  t.mock.method(mp, 'criarPreferencia', async () => {
    calls.preferences++;
    return { id: 'pref-42', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=42' };
  });
  return { calls, input, run: () => criarPagamento({ body: input }, { json: data => data }) };
}

test('validation failure before order creation lets the customer refresh prices and stock', async t => {
  const { calls, input, run } = setup(t);
  input.total = 1;
  await assert.rejects(run(), err => err.code === 'CHECKOUT_REVALIDATE' && err.status === 409);
  assert.equal(calls.creates, 0);
  assert.equal(calls.preferences, 0);
});

test('validation failure does not retire a checkout created concurrently', async t => {
  const { input, run } = setup(t);
  let lookups = 0;
  db.buscarPedidoPorCheckoutToken.mock.mockImplementation(async () => ++lookups === 1 ? null : { id: 42 });
  input.total = 1;
  await assert.rejects(run(), err => err.status === 409 && !err.code);
});

test('reservation conflict before contacting Mercado Pago is cleaned up and can be revalidated', async t => {
  const { calls, run } = setup(t);
  db.reservarEstoquePedido.mock.mockImplementation(async () => { throw new Error('estoque insuficiente'); });
  await assert.rejects(run(), err => err.code === 'CHECKOUT_REVALIDATE');
  assert.equal(calls.preferences, 0);
  assert.equal(calls.releases, 1);
  assert.equal(calls.updates[0].checkout_token, null);
});

test('uncertain preference creation keeps the reservation and checkout token', async t => {
  const { calls, run } = setup(t);
  mp.criarPreferencia.mock.mockImplementation(async () => { throw new Error('network timeout'); });
  await assert.rejects(run(), err => err.code === 'CHECKOUT_PROCESSING');
  assert.equal(calls.releases, 0);
  assert.deepEqual(calls.updates, []);
});

test('database failure after preference creation cannot release reserved stock or cancel the order', async t => {
  const { calls, run } = setup(t);
  db.atualizarPedido.mock.mockImplementation(async (_id, data) => {
    calls.updates.push(data);
    throw new Error('database unavailable');
  });
  await assert.rejects(run(), err => err.code === 'CHECKOUT_PROCESSING');
  assert.equal(calls.preferences, 1);
  assert.equal(calls.releases, 0);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].mp_preference_id, 'pref-42');
});
