const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'mercadopago') {
    class Client {
      create() { throw new Error('Nao usado neste teste.'); }
      get() { throw new Error('Nao usado neste teste.'); }
    }
    return { MercadoPagoConfig: Client, Preference: Client, Payment: Client };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const db = require('../src/services/db');
const mp = require('../src/services/mercadopago');
const { montarPedidoSeguro } = require('../src/controllers/pagamentoController');
const { processarPagamentoMercadoPago } = require('../src/controllers/webhookController');
Module._load = originalLoad;

function pedidoBase(itens) {
  return {
    cliente: { nome: 'Cliente Teste', email: 'teste@example.com' },
    endereco: { cidade: 'Sao Jose do Rio Pardo', estado: 'SP' },
    frete: { tipo: 'Entrega local', valor: 0 },
    metodo_pagamento: 'credit_card',
    itens,
  };
}

function stubCatalog({ estoque = 5, preco = 100, variantes = [] } = {}) {
  db.buscarProdutosPorIds = async () => [{ id: 1, nome: 'Produto Teste', preco, estoque, ativo: true }];
  db.buscarVariantesPorIds = async ids => variantes.filter(v => ids.map(Number).includes(Number(v.id)));
  db.buscarVariantesPorProdutoIds = async () => variantes;
}

test('consolida linhas repetidas antes de validar o estoque', async () => {
  stubCatalog({ estoque: 2 });
  const pedido = await montarPedidoSeguro(pedidoBase([
    { id: 1, quantidade: 1 },
    { id: 1, quantidade: 1 },
  ]));
  assert.equal(pedido.itens.length, 1);
  assert.equal(pedido.itens[0].quantidade, 2);
});

test('rejeita o total consolidado quando ultrapassa o estoque', async () => {
  stubCatalog({ estoque: 1 });
  await assert.rejects(
    montarPedidoSeguro(pedidoBase([
      { id: 1, quantidade: 1 },
      { id: 1, quantidade: 1 },
    ])),
    err => err.status === 409 && /Estoque insuficiente/.test(err.message)
  );
});

test('usa preco e dados da variacao vindos do banco', async () => {
  stubCatalog({
    estoque: 4,
    preco: 100,
    variantes: [{ id: 9, produto_id: 1, cor: 'Preto', tamanho: 'M', estoque: 3, ativo: true, preco: 89.9 }],
  });
  const pedido = await montarPedidoSeguro(pedidoBase([
    { id: 1, produto_variante_id: 9, quantidade: 2, preco: 1, cor: 'Branco', tamanho: 'G' },
  ]));
  assert.equal(pedido.itens[0].preco_unitario, 89.9);
  assert.equal(pedido.itens[0].cor, 'Preto');
  assert.equal(pedido.itens[0].tamanho, 'M');
});

test('pagamento aprovado usa finalizacao atomica', async () => {
  mp.buscarPagamento = async () => ({ status: 'approved', external_reference: '77' });
  db.buscarPedido = async () => ({ id: 77, status: 'pendente' });
  let chamada = null;
  db.finalizarPedidoPago = async (pedidoId, paymentId) => { chamada = { pedidoId, paymentId }; };
  const resultado = await processarPagamentoMercadoPago('mp-123');
  assert.deepEqual(chamada, { pedidoId: 77, paymentId: 'mp-123' });
  assert.equal(resultado.status, 'pago');
});

test('falha temporaria nao marca estoque como indisponivel', async () => {
  mp.buscarPagamento = async () => ({ status: 'approved', external_reference: '78' });
  db.buscarPedido = async () => ({ id: 78, status: 'pendente' });
  db.finalizarPedidoPago = async () => { throw new Error('Falha de rede'); };
  let atualizou = false;
  db.atualizarPedido = async () => { atualizou = true; };
  await assert.rejects(processarPagamentoMercadoPago('mp-124'), /Falha de rede/);
  assert.equal(atualizou, false);
});

test('retorno antigo nao rebaixa pedido ja pago por outra transacao', async () => {
  mp.buscarPagamento = async () => ({ status: 'cancelled', external_reference: '79' });
  db.buscarPedido = async () => ({ id: 79, status: 'pago', mp_payment_id: 'mp-aprovado' });
  let atualizou = false;
  db.atualizarPedido = async () => { atualizou = true; };
  const resultado = await processarPagamentoMercadoPago('mp-cancelado');
  assert.equal(resultado.status, 'pago');
  assert.equal(atualizou, false);
});

test('cancelamento tardio do mesmo pagamento nao rebaixa pedido pago', async () => {
  mp.buscarPagamento = async () => ({ status: 'cancelled', external_reference: '80' });
  db.buscarPedido = async () => ({ id: 80, status: 'pago', mp_payment_id: 'mp-126', pago_em: '2026-08-12T10:00:00.000Z' });
  let atualizou = false;
  db.atualizarPedido = async () => { atualizou = true; };
  const resultado = await processarPagamentoMercadoPago('mp-126');
  assert.equal(resultado.status, 'pago');
  assert.equal(atualizou, false);
});

test('reembolso preserva a data em que o pedido foi pago', async () => {
  mp.buscarPagamento = async () => ({ status: 'refunded', external_reference: '81' });
  db.buscarPedido = async () => ({ id: 81, status: 'pago', mp_payment_id: 'mp-127', pago_em: '2026-08-12T10:00:00.000Z' });
  let atualizacao;
  db.atualizarPedido = async (_id, dados) => { atualizacao = dados; };
  const resultado = await processarPagamentoMercadoPago('mp-127');
  assert.equal(resultado.status, 'reembolsado');
  assert.equal(atualizacao.status, 'reembolsado');
  assert.equal(atualizacao.pago_em, '2026-08-12T10:00:00.000Z');
});

test('notificacao aprovada atrasada nao reabre pedido reembolsado', async () => {
  mp.buscarPagamento = async () => ({ status: 'approved', external_reference: '82' });
  db.buscarPedido = async () => ({ id: 82, status: 'reembolsado', mp_payment_id: 'mp-128' });
  let finalizou = false;
  db.finalizarPedidoPago = async () => { finalizou = true; };
  const resultado = await processarPagamentoMercadoPago('mp-128');
  assert.equal(resultado.status, 'reembolsado');
  assert.equal(finalizou, false);
});

test('ignora referencia externa que nao seja um id de pedido valido', async () => {
  mp.buscarPagamento = async () => ({ status: 'approved', external_reference: 'pedido-invalido' });
  let buscouPedido = false;
  db.buscarPedido = async () => { buscouPedido = true; };
  const resultado = await processarPagamentoMercadoPago('mp-125');
  assert.equal(resultado, null);
  assert.equal(buscouPedido, false);
});
