// src/routes/produtos.js
const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/adminAuth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const IMAGE_BUCKET = 'product-images';

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

function sanitizeFileName(name = 'produto.jpg') {
  const ext = (name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const base = name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'produto';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}.${ext}`;
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) {
    const err = new Error('Imagem inválida. Use JPG, PNG ou WEBP.');
    err.status = 400;
    throw err;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) {
    const err = new Error('Imagem muito grande. Máximo de 5MB.');
    err.status = 400;
    throw err;
  }
  return { mime: match[1], buffer };
}

async function uploadStorageObject(path, buffer, mime) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${IMAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': mime,
      'Cache-Control': '31536000',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return `${SUPABASE_URL}/storage/v1/object/public/${IMAGE_BUCKET}/${path}`;
}

// GET /api/produtos — lista todos
router.get('/', async (req, res) => {
  const data = await sb('/produtos?select=*&order=criado_em.desc');
  res.json(data);
});

// POST /api/produtos/upload-image — salva foto no Supabase Storage
router.post('/upload-image', async (req, res) => {
  const { dataUrl, name } = req.body || {};
  const { mime, buffer } = parseDataUrl(dataUrl);
  const path = sanitizeFileName(name);
  const url = await uploadStorageObject(path, buffer, mime);
  res.json({ url, path });
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
