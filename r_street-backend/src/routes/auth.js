// src/routes/auth.js
const express = require('express');
const router  = express.Router();
const { createAdminToken } = require('../middleware/adminAuth');

// POST /api/auth/login
// Compara com a variável de ambiente SENHA_ADMIN
router.post('/login', (req, res) => {
  const { senha } = req.body;
  if (senha && senha === process.env.SENHA_ADMIN) {
    res.json({ ok: true, token: createAdminToken() });
  } else {
    res.status(401).json({ erro: 'Senha incorreta.' });
  }
});

module.exports = router;
