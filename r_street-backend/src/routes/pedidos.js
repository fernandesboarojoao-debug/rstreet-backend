// src/routes/pedidos.js
const express = require('express');
const db = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');
const { processarPagamentoMercadoPago } = require('../controllers/webhookController');
const router = express.Router();

router.post('/acompanhar', async (req, res) => {
  const { id, email } = req.body || {};
  const pedidoId = Number(id);
  const emailLimpo = String(email || '').trim();
  if (!Number.isInteger(pedidoId) || pedidoId <= 0 || !emailLimpo || emailLimpo.length > 254) {
    return res.status(400).json({ erro: 'Informe o numero do pedido e o e-mail da compra.' });
  }
  const pedido = await db.buscarPedidoPorIdEmail(pedidoId, emailLimpo);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado para este e-mail.' });

  const itens = await db.buscarItensPedido(pedido.id);
  res.json({ pedido, itens });
});

router.post('/confirmacao', async (req, res) => {
  const { pedido_id, payment_id } = req.body || {};
  const pedidoId = Number(pedido_id);
  const paymentId = String(payment_id || '').trim();

  if (!Number.isInteger(pedidoId) || pedidoId <= 0 || !paymentId) {
    return res.status(400).json({ erro: 'Informe pedido e pagamento para confirmar.' });
  }

  const resultado = await processarPagamentoMercadoPago(paymentId);
  if (!resultado || Number(resultado.pedidoId) !== pedidoId) {
    return res.status(404).json({ erro: 'Pagamento nao encontrado para este pedido.' });
  }

  const pedido = await db.buscarPedido(pedidoId);
  const itens = await db.buscarItensPedido(pedidoId);
  res.json({ pedido, itens, pagamento_status: resultado.pagamento.status });
});

router.use(requireAdmin);

// GET /api/pedidos/:id - consulta administrativa do pedido
router.get('/:id', async (req, res) => {
  const pedido = await db.buscarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
  res.json(pedido);
});

module.exports = router;
