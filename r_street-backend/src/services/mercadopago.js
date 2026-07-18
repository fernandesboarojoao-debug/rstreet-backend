// src/services/mercadopago.js
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceClient = new Preference(client);
const paymentClient    = new Payment(client);

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
    bolbradesco: {
      default_payment_method_id: 'bolbradesco',
      excluded_payment_types: ['credit_card', 'debit_card', 'bank_transfer', 'atm'],
    },
    account_money: {
      default_payment_method_id: 'account_money',
      excluded_payment_types: ['ticket', 'bank_transfer', 'atm'],
      purpose: 'wallet_purchase',
    },
  };

  const config = configPorMetodo[metodo] || configPorMetodo.credit_card;
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
    unit_price:  Number(item.preco_unitario),
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

module.exports = { criarPreferencia, buscarPagamento };
