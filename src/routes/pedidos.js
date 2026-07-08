// src/routes/pedidos.js
const express = require('express');
const db      = require('../services/db');
const router  = express.Router();

// GET /api/pedidos/:id — consulta status do pedido
router.get('/:id', async (req, res) => {
  const pedido = await db.buscarPedido(req.params.id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(pedido);
});

module.exports = router;
