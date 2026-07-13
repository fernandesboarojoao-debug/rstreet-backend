// src/routes/auth.js
const express = require('express');
const crypto = require('crypto');
const router  = express.Router();
const { createAdminToken } = require('../middleware/adminAuth');

function safeEquals(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// POST /api/auth/login
// Compara com a variável de ambiente SENHA_ADMIN
router.post('/login', (req, res) => {
  const { senha } = req.body;
  if (senha && process.env.SENHA_ADMIN && safeEquals(senha, process.env.SENHA_ADMIN)) {
    res.json({ ok: true, token: createAdminToken() });
  } else {
    res.status(401).json({ erro: 'Senha incorreta.' });
  }
});

module.exports = router;
