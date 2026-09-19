// src/services/mercadopago.js
const { MercadoPagoConfig, Preference, Payment, MerchantOrder } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceClient = new Preference(client);
const paymentClient    = new Payment(client);
const merchantOrderClient = new MerchantOrder(client);

function montarPaymentMethods(metodoPagamento) {
  const metodo = String(metodoPagamento || 'credit_card');
  const configPorMetodo = {
    credit_card: {
      excluded_payment_types: ['debit_card', 'ticket', 'bank_transfer', 'atm'],
    },
    debit_card: {
      excluded_payment_types: ['credit_card', 'ticket', 'bank_transfer', 'atm'],
    },
    pix: {
      default_payment_method_id: 'pix',
      excluded_payment_types: ['credit_card', 'debit_card', 'ticket', 'atm'],
    },
  };

  const config = configPorMetodo[metodo];
  if (!config) throw new Error('Meio de pagamento indisponivel.');
  return {
    excluded_payment_types: config.excluded_payment_types.map(id => ({ id })),
    installments: 6,
    ...(config.default_payment_method_id && { default_payment_method_id: config.default_payment_method_id }),
    ...(config.purpose && { purpose: config.purpose }),
  };
}

// ── CRIAR PREFERÊNCIA DE PAGAMENTO ───────────────────────
async function criarPreferencia(pedido, pedidoId) {
  const BACKEND_URL  = process.env.BACKEND_URL;
  const FRONTEND_URL = process.env.FRONTEND_URL;

  const items = pedido.itens.map(item => ({
    id:          String(item.id),
    title:       [item.nome, item.cor, item.tamanho].filter(Boolean).join(' - '),
    quantity:    item.quantidade,
    unit_price:  Number(item.preco_pagamento ?? item.preco_unitario),
    currency_id: 'BRL',
  }));

  // Adiciona frete como item se maior que zero
  if (pedido.frete.valor > 0) {
    items.push({
      id:          'frete',
      title:       `Frete - ${pedido.frete.tipo}`,
      quantity:    1,
      unit_price:  Number(pedido.frete.valor),
      currency_id: 'BRL',
    });
  }

  const preference = await preferenceClient.create({
    body: {
      items,
      payer: {
        name:  pedido.cliente.nome,
        email: pedido.cliente.email,
        phone: { number: pedido.cliente.telefone },
        ...(pedido.cliente.cpf && {
          identification: { type: 'CPF', number: pedido.cliente.cpf.replace(/\D/g,'') }
        }),
        address: {
          zip_code:      pedido.endereco.cep.replace(/\D/g,''),
          street_name:   pedido.endereco.rua,
          street_number: pedido.endereco.numero,
        },
      },
      payment_methods: montarPaymentMethods(pedido.metodo_pagamento),
      ...(pedido.reserva_expira_em && {
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: pedido.reserva_expira_em,
      }),
      back_urls: {
        success: `${FRONTEND_URL}/confirmacao.html?status=approved&pedido_id=${pedidoId}`,
        failure: `${FRONTEND_URL}/confirmacao.html?status=cancelled&pedido_id=${pedidoId}`,
        pending: `${FRONTEND_URL}/confirmacao.html?status=pending&pedido_id=${pedidoId}`,
      },
      auto_return:         'approved',
      external_reference:  String(pedidoId),
      notification_url:    `${BACKEND_URL}/api/webhook/mercadopago`,
      statement_descriptor:'R STREET MODA',
    },
  });

  return preference;
}

// ── BUSCAR PAGAMENTO ─────────────────────────────────────
async function buscarPagamento(paymentId) {
  return paymentClient.get({ id: paymentId });
}

async function buscarPedidoComercial(merchantOrderId) {
  return merchantOrderClient.get({ merchantOrderId });
}

async function buscarPreferencia(preferenceId) {
  return preferenceClient.get({ preferenceId });
}

async function buscarPagamentosPedido(pedidoId) {
  const pagamentos = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await paymentClient.search({ options: { external_reference: String(pedidoId), limit: 100, offset } });
    if (!Array.isArray(page.results) || !Number.isInteger(page.paging?.total)) throw new Error('Consulta incompleta de pagamentos.');
    pagamentos.push(...page.results);
    if (pagamentos.length >= page.paging.total) return pagamentos;
    if (!page.results.length) break;
  }
  throw new Error('Nao foi possivel verificar todas as tentativas de pagamento.');
}

module.exports = { criarPreferencia, buscarPagamento, buscarPedidoComercial, buscarPreferencia, buscarPagamentosPedido, montarPaymentMethods };
