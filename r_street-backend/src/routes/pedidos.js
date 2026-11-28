// src/routes/pedidos.js
const express = require('express');
const db = require('../services/db');
const { safeTrackingUrl } = require('../services/trackingUrl');
const { requireAdmin } = require('../middleware/adminAuth');
const { processarPagamentoMercadoPago } = require('../controllers/webhookController');
const router = express.Router();

function numericReference(value, maxDigits) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const digits = String(value).trim();
  return digits.length <= maxDigits && /^[1-9]\d*$/.test(digits) ? digits : '';
}

router.post('/acompanhar', async (req, res) => {
  const { id, email } = req.body || {};
  const pedidoId = Number(numericReference(id, 16));
  const emailLimpo = typeof email === 'string' ? email.trim() : '';
  if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0 || emailLimpo.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
    return res.status(400).json({ erro: 'Informe o numero do pedido e o e-mail da compra.' });
  }
  const pedido = await db.buscarPedidoPorIdEmail(pedidoId, emailLimpo);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado para este e-mail.' });

  const itens = await db.buscarItensPedido(pedido.id);
  const atualizacoes = await db.buscarAtualizacoesPedido(pedido.id);
  const { status, envio_status, total, codigo_rastreio, rastreio_url, criado_em } = pedido;
  res.json({ pedido: { id:pedido.id, status, envio_status, total, codigo_rastreio, rastreio_url: safeTrackingUrl(rastreio_url) || undefined, criado_em }, itens, atualizacoes: atualizacoes || [] });
});

router.post('/confirmacao', async (req, res) => {
  const { pedido_id, payment_id } = req.body || {};
  const pedidoId = Number(numericReference(pedido_id, 16));
  const paymentId = numericReference(payment_id, 30);

  if (!Number.isSafeInteger(pedidoId) || pedidoId <= 0 || !/^\d{1,30}$/.test(paymentId)) {
    return res.status(400).json({ erro: 'Informe pedido e pagamento para confirmar.' });
  }

  const resultado = await processarPagamentoMercadoPago(paymentId, pedidoId);
  if (!resultado || Number(resultado.pedidoId) !== pedidoId) {
    return res.status(404).json({ erro: 'Pagamento nao encontrado para este pedido.' });
  }

  const pedido = await db.buscarPedido(pedidoId);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
  const itens = await db.buscarItensPedido(pedidoId);
  const { id, status, frete_valor, frete_tipo, total, metodo_pagamento } = pedido;
  res.json({ pedido: { id, status, frete_valor, frete_tipo, total, metodo_pagamento }, itens, pagamento_status: resultado.pagamento.status });
});

router.use(requireAdmin);

// GET /api/pedidos/:id - consulta administrativa do pedido
router.get('/:id', async (req, res) => {
  const pedido = await db.buscarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
  res.json(pedido);
});

module.exports = router;
