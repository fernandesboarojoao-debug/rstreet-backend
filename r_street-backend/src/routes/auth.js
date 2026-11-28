// src/routes/auth.js
const express = require('express');
const crypto = require('crypto');
const router  = express.Router();
const { adminLoginWait } = require('../middleware/adminLoginLimit');
const { createAdminToken, getAdminPassword, isAdminAuthConfigured } = require('../middleware/adminAuth');

function safeEquals(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// POST /api/auth/login
// Compara com a variável de ambiente SENHA_ADMIN
router.post('/login', async (req, res) => {
  const senha = req.body?.senha;
  res.set('Cache-Control', 'no-store');
  if (!isAdminAuthConfigured()) {
    console.error('Autenticacao administrativa sem SENHA_ADMIN ou segredo para assinatura.');
    return res.status(503).json({ erro: 'Acesso administrativo temporariamente indisponivel.' });
  }
  if (typeof senha !== 'string' || !senha) return res.status(401).json({ erro: 'Senha incorreta.' });
  const secret = getAdminPassword();
  const correct = safeEquals(senha, secret);
  let retryAfter;
  try {
    retryAfter = await adminLoginWait(req.ip || req.socket.remoteAddress || 'unknown', secret, correct);
  } catch {
    return res.status(503).json({ erro: 'Acesso administrativo temporariamente indisponivel.' });
  }
  if (retryAfter) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ erro: 'Aguarde antes de tentar novamente.', retry_after: retryAfter });
  }
  if (correct) {
    const session = createAdminToken();
    res.json({ ok: true, token: session.token, expires_at: session.expiresAt });
  } else {
    res.status(401).json({ erro: 'Senha incorreta.' });
  }
});

module.exports = router;
