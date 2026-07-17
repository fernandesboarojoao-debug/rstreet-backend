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

function parseSbErrorMessage(message = '') {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}

function normalizeProductError(err) {
  const supabaseError = parseSbErrorMessage(err.message);
  if (supabaseError?.code === '23505' && String(supabaseError.message || '').includes('produtos_referencia_key')) {
    const friendly = new Error('Essa referência já está cadastrada em outro produto. Use uma referência diferente ou edite o produto existente.');
    friendly.status = 409;
    return friendly;
  }
  return err;
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

function inferMediaMime(mime, name = '') {
  const cleanMime = String(mime || '').toLowerCase();
  if (cleanMime === 'image/jpeg' || cleanMime === 'image/jpg' || cleanMime === 'image/pjpeg') return 'image/jpeg';
  if (cleanMime === 'image/png') return 'image/png';
  if (cleanMime === 'image/webp') return 'image/webp';
  if (cleanMime === 'video/mp4') return 'video/mp4';
  if (cleanMime === 'video/webm') return 'video/webm';
  if (cleanMime === 'video/quicktime' || cleanMime === 'video/mov') return 'video/quicktime';
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime'
  }[ext] || '';
}

function parseMediaDataUrl(dataUrl, name = '') {
  const match = /^data:([^;]*);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  const mime = inferMediaMime(match?.[1], name);
  if (!match) {
    const err = new Error('Arquivo invalido. Use JPG, PNG, WEBP, MP4, WEBM ou MOV.');
    err.status = 400;
    throw err;
  }
  if (!mime) {
    const err = new Error('Arquivo invalido. Use JPG, PNG, WEBP, MP4, WEBM ou MOV.');
    err.status = 400;
    throw err;
  }
  const buffer = Buffer.from(match[2], 'base64');
  const isVideo = mime.startsWith('video/');
  const maxSize = isVideo ? 30 * 1024 * 1024 : 5 * 1024 * 1024;
  if (buffer.length > maxSize) {
    const err = new Error(isVideo ? 'Video muito grande. Maximo de 30MB.' : 'Imagem muito grande. Maximo de 5MB.');
    err.status = 400;
    throw err;
  }
  return { mime, buffer };
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

router.get('/:id/variantes', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'Produto inválido' });

  const data = await sb(`/produto_variantes?produto_id=eq.${id}&select=*&order=ordem.asc,cor.asc,tamanho.asc`);
  res.json(data || []);
});

// POST /api/produtos/upload-image — salva foto no Supabase Storage
router.post('/upload-image', async (req, res) => {
  const { dataUrl, name } = req.body || {};
  const { mime, buffer } = parseMediaDataUrl(dataUrl, name);
  const path = sanitizeFileName(name);
  const url = await uploadStorageObject(path, buffer, mime);
  res.json({ url, path });
});

// POST /api/produtos — cria novo
router.post('/', async (req, res) => {
  try {
    const data = await sb('/produtos', { method: 'POST', body: JSON.stringify(req.body) });
    res.json(data);
  } catch (err) {
    throw normalizeProductError(err);
  }
});

router.put('/:id/variantes', async (req, res) => {
  const produtoId = Number(req.params.id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) return res.status(400).json({ erro: 'Produto inválido' });

  const entrada = Array.isArray(req.body?.variantes) ? req.body.variantes : [];
  const vistos = new Set();
  const variantes = [];

  for (const item of entrada) {
    const cor = String(item.cor || '').trim();
    const tamanho = String(item.tamanho || '').trim();
    const estoque = Math.max(0, parseInt(item.estoque, 10) || 0);
    const ativo = item.ativo !== false;
    const preco = item.preco === null || item.preco === '' || item.preco === undefined ? null : Math.max(0, Number(item.preco) || 0);
    const preco_antigo = item.preco_antigo === null || item.preco_antigo === '' || item.preco_antigo === undefined ? null : Math.max(0, Number(item.preco_antigo) || 0);
    const imagem_url = String(item.imagem_url || '').trim() || null;
    const imagens = Array.isArray(item.imagens) ? item.imagens.map(url => String(url || '').trim()).filter(Boolean) : [];
    const videos = Array.isArray(item.videos) ? item.videos.map(url => String(url || '').trim()).filter(Boolean) : [];
    const cor_hex = String(item.cor_hex || '').trim() || null;
    const ordem = parseInt(item.ordem, 10) || 0;
    if (!cor || !tamanho) continue;

    const chave = `${cor.toLowerCase()}|${tamanho.toUpperCase()}`;
    if (vistos.has(chave)) {
      const err = new Error(`Combinação duplicada: ${cor} / ${tamanho}`);
      err.status = 400;
      throw err;
    }
    vistos.add(chave);
    variantes.push({ produto_id: produtoId, cor, tamanho, estoque, ativo, preco, preco_antigo, imagem_url, imagens, videos, cor_hex, ordem });
  }

  await sb(`/produto_variantes?produto_id=eq.${produtoId}`, { method: 'DELETE' });
  if (!variantes.length) return res.json([]);

  const data = await sb('/produto_variantes', {
    method: 'POST',
    body: JSON.stringify(variantes),
  });
  res.json(data || []);
});

// PATCH /api/produtos/:id — atualiza
router.patch('/:id', async (req, res) => {
  try {
    const data = await sb(`/produtos?id=eq.${req.params.id}`, { method: 'PATCH', body: JSON.stringify(req.body) });
    res.json(data);
  } catch (err) {
    throw normalizeProductError(err);
  }
});

// DELETE /api/produtos/:id — deleta
router.delete('/:id', async (req, res) => {
  await sb(`/produtos?id=eq.${req.params.id}`, { method: 'DELETE' });
  res.json({ ok: true });
});

module.exports = router;
