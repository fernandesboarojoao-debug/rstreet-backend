// src/routes/produtos.js
const express = require('express');
const router  = express.Router();
const db      = require('../services/db');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text ? JSON.parse(text) : null;
}

// GET /api/produtos — lista todos
router.get('/', async (req, res) => {
  const data = await sb('/produtos?select=*&order=criado_em.desc');
  res.json(data);
});

// POST /api/produtos — cria novo
router.post('/', async (req, res) => {
  const data = await sb('/produtos', { method: 'POST', body: JSON.stringify(req.body) });
  res.json(data);
});

// PATCH /api/produtos/:id — atualiza
router.patch('/:id', async (req, res) => {
  const data = await sb(`/produtos?id=eq.${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body) });
  res.json(data);
});

// DELETE /api/produtos/:id — deleta
router.delete('/:id', async (req, res) => {
  await sb(`/produtos?id=eq.${req.params.id}`, { method: 'DELETE' });
  res.json({ ok: true });
});

module.exports = router;
