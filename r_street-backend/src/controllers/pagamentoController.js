// src/controllers/pagamentoController.js
const db = require('../services/db');
const mp = require('../services/mercadopago');

async function criarPagamento(req, res) {
  const pedidoData = req.body;

  // Valida campos obrigatórios
  if (!pedidoData.cliente?.nome || !pedidoData.cliente?.email) {
    return res.status(400).json({ erro: 'Dados do cliente obrigatórios.' });
  }
  if (!pedidoData.itens?.length) {
    return res.status(400).json({ erro: 'Carrinho vazio.' });
  }

  // 1. Salva o pedido no banco
  const pedido = await db.criarPedido(pedidoData);
  console.log(`📦 Pedido criado: #${pedido.id}`);

  // 2. Salva os itens do pedido
  await db.criarItensPedido(pedido.id, pedidoData.itens);

  // 3. Cria a preferência no Mercado Pago
  const preferencia = await mp.criarPreferencia(pedidoData, pedido.id);
  console.log(`💳 Preferência MP criada: ${preferencia.id}`);

  // 4. Salva o ID da preferência no pedido
  await db.atualizarPedido(pedido.id, { mp_preference_id: preferencia.id });

  // 5. Retorna o link de pagamento para o frontend
  res.json({
    pedido_id:  pedido.id,
    init_point: preferencia.init_point, // link do MP para pagar
    sandbox_init_point: preferencia.sandbox_init_point,
  });
}

module.exports = { criarPagamento };
