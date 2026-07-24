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

function slugifyTema(value) {
  return String(value || 'campanha')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'campanha';
}

function cleanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function cleanTemaSite(input = {}) {
  const nome = String(input.nome || '').trim().slice(0, 120);
  const titulo = String(input.titulo || '').trim().slice(0, 160);
  if (!nome || !titulo) {
    const err = new Error('Informe nome e titulo do tema.');
    err.status = 400;
    throw err;
  }

  const statusPermitidos = ['ativo', 'inativo', 'programado'];
  const locaisPermitidos = ['home', 'catalogo', 'ambos'];
  const produtoIds = Array.isArray(input.produto_ids) ? input.produto_ids : [];
  const slug = slugifyTema(input.slug || nome);

  return {
    nome,
    slug,
    titulo,
    texto: String(input.texto || '').trim().slice(0, 500) || null,
    banner_url: String(input.banner_url || '').trim().slice(0, 1000) || null,
    cor_destaque: /^#[0-9a-f]{6}$/i.test(String(input.cor_destaque || ''))
      ? String(input.cor_destaque).trim()
      : '#c8a96e',
    botao_texto: String(input.botao_texto || 'Ver campanha').trim().slice(0, 80) || 'Ver campanha',
    botao_link: String(input.botao_link || '').trim().slice(0, 500) || `catalogo.html?campanha=${slug}`,
    local_exibicao: locaisPermitidos.includes(input.local_exibicao) ? input.local_exibicao : 'ambos',
    status: statusPermitidos.includes(input.status) ? input.status : 'inativo',
    inicio: cleanDate(input.inicio),
    fim: cleanDate(input.fim),
    produto_ids: [...new Set(produtoIds.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 80),
    atualizado_em: new Date().toISOString(),
  };
}

async function ensureTemaSlug(payload, currentId = 0) {
  const originalSlug = payload.slug;
  const rows = await sb(`/temas_site?slug=eq.${encodeURIComponent(payload.slug)}&select=id`);
  const conflict = (rows || []).find(row => Number(row.id) !== Number(currentId));
  if (!conflict) return payload;
  const slug = `${payload.slug}-${Date.now().toString(36).slice(-4)}`.slice(0, 90);
  return {
    ...payload,
    slug,
    botao_link: payload.botao_link === `catalogo.html?campanha=${originalSlug}` ? `catalogo.html?campanha=${slug}` : payload.botao_link,
  };
}

// GET /api/admin/temas-site - lista campanhas/temas cadastrados
router.get('/temas-site', async (req, res) => {
  const data = await sb('/temas_site?select=*&order=criado_em.desc');
  res.json(data || []);
});

// POST /api/admin/temas-site - cria ou atualiza campanha/tema
router.post('/temas-site', async (req, res) => {
  let payload = cleanTemaSite(req.body || {});
  const id = Number(req.body?.id);
  payload = await ensureTemaSlug(payload, Number.isInteger(id) ? id : 0);
  if (Number.isInteger(id) && id > 0) {
    const data = await sb(`/temas_site?id=eq.${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    return res.json(Array.isArray(data) ? data[0] : data);
  }

  const data = await sb('/temas_site', {
    method: 'POST',
    body: JSON.stringify({ ...payload, criado_em: new Date().toISOString() }),
  });
  res.json(Array.isArray(data) ? data[0] : data);
});

// DELETE /api/admin/temas-site/:id - remove uma campanha/tema
router.delete('/temas-site/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'Tema invalido.' });
  await sb(`/temas_site?id=eq.${id}`, { method: 'DELETE' });
  res.json({ ok: true });
});

module.exports = router;
