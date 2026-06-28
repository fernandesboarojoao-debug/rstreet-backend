// src/routes/pagamento.js
const express = require('express');
const { criarPagamento } = require('../controllers/pagamentoController');
const router = express.Router();

// POST /api/pagamento/criar
router.post('/criar', criarPagamento);

module.exports = router;
