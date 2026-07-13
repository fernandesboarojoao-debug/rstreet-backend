// src/routes/pedidos.js
const express = require('express');
const db = require('../services/db');
const { requireAdmin } = require('../middleware/adminAuth');
const router = express.Router();

router.post('/acompanhar', async (req, res) => {
  const { id, email } = req.body || {};
  const pedido = await db.buscarPedidoPorIdEmail(id, email);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado para este e-mail.' });

  const itens = await db.buscarItensPedido(pedido.id);
  res.json({ pedido, itens });
});

router.use(requireAdmin);

// GET /api/pedidos/:id - consulta administrativa do pedido
router.get('/:id', async (req, res) => {
  const pedido = await db.buscarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido nao encontrado.' });
  res.json(pedido);
});

module.exports = router;
