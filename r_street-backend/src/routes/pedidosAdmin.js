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

// GET /api/admin/home-destaques — lista cards editaveis da home
router.get('/home-destaques', async (req, res) => {
  const data = await sb('/home_destaques?select=*&order=id.asc');
  res.json(data || []);
});

function cleanHomeHighlight(item, index) {
  const id = Number(item?.id || index + 1);
  if (!Number.isInteger(id) || id < 1 || id > 3) {
    const err = new Error('Destaque invalido.');
    err.status = 400;
    throw err;
  }

  const midiaTipo = item?.midia_tipo === 'video' ? 'video' : 'image';
  const midias = (Array.isArray(item?.midias) ? item.midias : [])
    .map(media => ({
      url: String(media?.url || '').trim(),
      tipo: media?.tipo === 'video' ? 'video' : 'image',
    }))
    .filter(media => media.url)
    .slice(0, 8);
  if (!midias.length && item?.midia_url) {
    midias.push({
      url: String(item.midia_url || '').trim(),
      tipo: midiaTipo,
    });
  }
  const principal = midias[0] || { url: String(item?.midia_url || '').trim(), tipo: midiaTipo };

  return {
    id,
    marca: String(item?.marca || '').trim().slice(0, 80),
    titulo: String(item?.titulo || '').trim().slice(0, 120),
    midia_url: principal.url,
    midia_tipo: principal.tipo,
    midias,
    link_url: String(item?.link_url || 'catalogo.html').trim().slice(0, 500) || 'catalogo.html',
    ativo: item?.ativo !== false,
    atualizado_em: new Date().toISOString(),
  };
}

// PUT /api/admin/home-destaques — salva os 3 cards da home
router.put('/home-destaques', async (req, res) => {
  const entrada = Array.isArray(req.body?.destaques) ? req.body.destaques : [];
  const destaques = entrada.slice(0, 3).map(cleanHomeHighlight);
  if (destaques.length !== 3) return res.status(400).json({ erro: 'Envie os 3 destaques da home.' });

  const data = await sb('/home_destaques?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(destaques),
  });
  res.json(data || []);
});

module.exports = router;
