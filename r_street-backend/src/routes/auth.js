// src/routes/auth.js
const express = require('express');
const crypto = require('crypto');
const router  = express.Router();
const { createAdminToken, getAdminPassword, isAdminAuthConfigured } = require('../middleware/adminAuth');

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
  res.set('Cache-Control', 'no-store');
  if (!isAdminAuthConfigured()) {
    console.error('Autenticacao administrativa sem SENHA_ADMIN ou segredo para assinatura.');
    return res.status(503).json({ erro: 'Acesso administrativo temporariamente indisponivel.' });
  }
  if (senha && safeEquals(senha, getAdminPassword())) {
    const session = createAdminToken();
    res.json({ ok: true, token: session.token, expires_at: session.expiresAt });
  } else {
    res.status(401).json({ erro: 'Senha incorreta.' });
  }
});

module.exports = router;
