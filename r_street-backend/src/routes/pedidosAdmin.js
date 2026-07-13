// src/routes/pedidosAdmin.js
const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/adminAuth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

router.use(requireAdmin);

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

// GET /api/admin/pedidos — lista todos os pedidos
router.get('/pedidos', async (req, res) => {
  const data = await sb('/pedidos?select=*&order=criado_em.desc');
  res.json(data);
});

// GET /api/admin/pedidos/:id/itens — itens de um pedido
router.get('/pedidos/:id/itens', async (req, res) => {
  const data = await sb(`/itens_pedido?pedido_id=eq.${req.params.id}&select=*`);
  res.json(data);
});

// PATCH /api/admin/pedidos/:id — atualiza status
router.patch('/pedidos/:id', async (req, res) => {
  const permitidos = ['status', 'envio_status', 'codigo_rastreio', 'rastreio_url'];
  const payload = {};
  for (const campo of permitidos) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, campo)) payload[campo] = req.body[campo] || null;
  }
  if (!Object.keys(payload).length) return res.status(400).json({ erro: 'Nenhum campo permitido para atualizar.' });
  payload.atualizado_em = new Date().toISOString();

  const data = await sb(`/pedidos?id=eq.${req.params.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
  res.json(data);
});

module.exports = router;
