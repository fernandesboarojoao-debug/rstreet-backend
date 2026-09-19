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
  if (supabaseError?.code === 'P0001') {
    const message = String(supabaseError.message || '');
    if (/Estoque mudou|Reabra|Variacao alterada|duplicada|reserva ativa/i.test(message)) {
      const friendly = new Error(message);
      friendly.status = 409;
      friendly.expose = true;
      return friendly;
    }
  }
  if (supabaseError?.code === '23505' && String(supabaseError.message || '').includes('produtos_referencia_key')) {
    const friendly = new Error('Essa referência já está cadastrada em outro produto. Use uma referência diferente ou edite o produto existente.');
    friendly.status = 409;
    friendly.expose = true;
    return friendly;
  }
  return err;
}

function cleanText(value, maxLength) {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function cleanLongText(value, maxLength) {
  const clean = String(value ?? '').replace(/\u0000/g, '').trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function cleanHttpUrl(value) {
  const clean = String(value ?? '').trim();
  if (!clean) return null;
  if (clean.length > 2048) return null;
  try {
    const url = new URL(clean);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function cleanNumber(value, { nullable = false, integer = false, max = 1_000_000 } = {}) {
  if (nullable && (value === null || value === '' || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return nullable ? null : 0;
  const safe = Math.min(max, Math.max(0, number));
  return integer ? Math.trunc(safe) : Number(safe.toFixed(2));
}

function cleanStringList(value, maxItems, itemLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => cleanText(item, itemLength)).filter(Boolean))].slice(0, maxItems);
}

function cleanUrlList(value, maxItems) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanHttpUrl).filter(Boolean))].slice(0, maxItems);
}

const PRODUCT_FIELDS = {
  nome: value => cleanText(value, 180),
  marca: value => cleanText(value, 80),
  categoria: value => cleanText(value, 80),
  preco: value => cleanNumber(value),
  preco_antigo: value => cleanNumber(value, { nullable: true }),
  estoque: value => cleanNumber(value, { integer: true }),
  referencia: value => cleanText(value, 100),
  imagem_url: cleanHttpUrl,
  imagens: value => cleanUrlList(value, 20),
  descricao: value => cleanLongText(value, 5000),
  especificacoes_tecnicas: value => cleanLongText(value, 5000),
  dicas_conservacao: value => cleanLongText(value, 5000),
  tamanhos: value => cleanStringList(value, 40, 30),
  destaque_catalogo: value => value === true,
  ativo: value => value !== false,
};

function cleanProductPayload(input = {}, { partial = false } = {}) {
  const payload = {};
  for (const [field, cleaner] of Object.entries(PRODUCT_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    payload[field] = cleaner(input[field]);
  }
  if (!partial && !payload.nome) {
    const err = new Error('Informe o nome do produto.');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  if (!Object.keys(payload).length) {
    const err = new Error('Nenhum campo permitido para salvar.');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  return payload;
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
    err.expose = true;
    throw err;
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 5 * 1024 * 1024) {
    const err = new Error('Imagem muito grande. Máximo de 5MB.');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  return { mime: match[1], buffer };
}

function hasExpectedMediaSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'video/mp4' || mime === 'video/quicktime') return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
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
    err.expose = true;
    throw err;
  }
  if (!mime) {
    const err = new Error('Arquivo invalido. Use JPG, PNG, WEBP, MP4, WEBM ou MOV.');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  const buffer = Buffer.from(match[2], 'base64');
  const isVideo = mime.startsWith('video/');
  const maxSize = isVideo ? 30 * 1024 * 1024 : 5 * 1024 * 1024;
  if (buffer.length > maxSize) {
    const err = new Error(isVideo ? 'Video muito grande. Maximo de 30MB.' : 'Imagem muito grande. Maximo de 5MB.');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  if (!hasExpectedMediaSignature(buffer, mime)) {
    const err = new Error('O conteudo do arquivo nao corresponde ao formato informado.');
    err.status = 400;
    err.expose = true;
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
    const payload = cleanProductPayload(req.body || {});
    const data = await sb('/produtos', { method: 'POST', body: JSON.stringify(payload) });
    res.json(data);
  } catch (err) {
    throw normalizeProductError(err);
  }
});

router.put('/:id/variantes', async (req, res) => {
  const produtoId = Number(req.params.id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) return res.status(400).json({ erro: 'Produto inválido' });

  if (!Array.isArray(req.body?.variantes) || req.body.variantes.length > 1000) {
    return res.status(400).json({ erro: 'Envie uma lista válida de variações.' });
  }
  const entrada = req.body.variantes;
  const vistos = new Set();
  const variantes = [];

  for (const item of entrada) {
    const cor = cleanText(item.cor, 80) || '';
    const tamanho = cleanText(item.tamanho, 30) || '';
    const estoque = cleanNumber(item.estoque, { integer: true });
    const ativo = item.ativo !== false;
    const preco = cleanNumber(item.preco, { nullable: true });
    const preco_antigo = cleanNumber(item.preco_antigo, { nullable: true });
    const imagem_url = cleanHttpUrl(item.imagem_url);
    const imagens = cleanUrlList(item.imagens, 20);
    const videos = cleanUrlList(item.videos, 12);
    const cor_hex = /^#[0-9a-f]{6}$/i.test(String(item.cor_hex || '').trim()) ? String(item.cor_hex).trim() : null;
    const ordem = cleanNumber(item.ordem, { integer: true, max: 10_000 });
    if (!cor || !tamanho) return res.status(400).json({ erro: 'Cor e tamanho são obrigatórios.' });

    const chave = `${cor.toLowerCase()}|${tamanho.toUpperCase()}`;
    if (vistos.has(chave)) {
      const err = new Error(`Combinação duplicada: ${cor} / ${tamanho}`);
      err.status = 400;
      err.expose = true;
      throw err;
    }
    vistos.add(chave);
    const id = Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0 ? Number(item.id) : null;
    const estoque_original = item.estoque_original == null ? null : cleanNumber(item.estoque_original, { integer: true });
    variantes.push({ id, estoque_original, produto_id: produtoId, cor, tamanho, estoque, ativo, preco, preco_antigo, imagem_url, imagens, videos, cor_hex, ordem });
  }

  try {
    const data = await sb('/rpc/salvar_variantes_seguras', {
      method: 'POST',
      body: JSON.stringify({ p_produto_id: produtoId, p_variantes: variantes }),
    });
    res.json(data || []);
  } catch (err) { throw normalizeProductError(err); }
});

// PATCH /api/produtos/:id — atualiza
router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'Produto inválido' });
  try {
    const payload = cleanProductPayload(req.body || {}, { partial: true });
    if (Object.hasOwn(payload, 'estoque')) {
      const variantes = await sb(`/produto_variantes?produto_id=eq.${id}&select=id&limit=1`);
      if (variantes?.length) delete payload.estoque;
    }
    const data = Object.keys(payload).length
      ? await sb(`/produtos?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      : await sb(`/produtos?id=eq.${id}`);
    res.json(data);
  } catch (err) {
    throw normalizeProductError(err);
  }
});

// DELETE /api/produtos/:id — deleta
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'Produto inválido' });
  try { await sb(`/produtos?id=eq.${id}`, { method: 'DELETE' }); }
  catch (err) { throw normalizeProductError(err); }
  res.json({ ok: true });
});

module.exports = router;
