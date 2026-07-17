// src/services/mercadopago.js
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

const preferenceClient = new Preference(client);
const paymentClient    = new Payment(client);

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
      payment_methods: {
        excluded_payment_types: [],
        installments: 6,
      },
      back_urls: {
        success: `${FRONTEND_URL}/confirmacao.html?status=approved`,
        failure: `${FRONTEND_URL}/confirmacao.html?status=failure`,
        pending: `${FRONTEND_URL}/confirmacao.html?status=pending`,
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
