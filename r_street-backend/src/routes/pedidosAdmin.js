// src/routes/pedidosAdmin.js
const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/adminAuth');
const { notificarPedido } = require('../services/notificacoes');
const { loadMetrics } = require('../services/metricas');
const notifications = require('../services/notificacoes');
const db = require('../services/db');
const { reservasAtivadas } = require('../services/reservas');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

router.use(requireAdmin);

const STATUS_PEDIDO = new Set(['pendente', 'em_analise', 'pago', 'recusado', 'cancelado', 'reembolsado', 'estornado', 'estoque_indisponivel']);
const STATUS_ENVIO = new Set(['aguardando_envio', 'em_preparacao', 'enviado', 'entregue', 'retirada_disponivel', 'retirado']);

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function safeOptionalText(value, maxLength) {
  const clean = String(value || '').trim();
  if (clean.length > maxLength) return undefined;
  return clean || null;
}

function safeOptionalHttpUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) return null;
  if (clean.length > 2048) return undefined;
  try {
    const url = new URL(clean);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function cleanPublicUrl(value, fallback = null, maxLength = 1000) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean.length > maxLength || clean.includes('\\')) return fallback;
  if (clean.startsWith('//')) return `https:${clean}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) {
    try {
      const parsed = new URL(clean);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : fallback;
    } catch {
      return fallback;
    }
  }
  return clean;
}

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
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Pedido invalido.' });
  const data = await sb(`/itens_pedido?pedido_id=eq.${id}&select=*`);
  res.json(data);
});

// PATCH /api/admin/pedidos/:id — atualiza status
router.patch('/pedidos/:id', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Pedido invalido.' });
  const payload = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
    if (!STATUS_PEDIDO.has(req.body.status)) return res.status(400).json({ erro: 'Status do pedido invalido.' });
    payload.status = req.body.status;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'envio_status')) {
    if (!STATUS_ENVIO.has(req.body.envio_status)) return res.status(400).json({ erro: 'Status de envio invalido.' });
    payload.envio_status = req.body.envio_status;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'codigo_rastreio')) {
    const code = safeOptionalText(req.body.codigo_rastreio, 120);
    if (code === undefined) return res.status(400).json({ erro: 'Codigo de rastreio muito longo.' });
    payload.codigo_rastreio = code;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rastreio_url')) {
    const url = safeOptionalHttpUrl(req.body.rastreio_url);
    if (url === undefined) return res.status(400).json({ erro: 'Link de rastreio invalido.' });
    payload.rastreio_url = url;
  }
  if (!Object.keys(payload).length) return res.status(400).json({ erro: 'Nenhum campo permitido para atualizar.' });

  const rows = await sb(`/pedidos?id=eq.${id}&select=id,status,envio_status,mp_preference_id,checkout_token,reserva_estado`);
  const atual = rows?.[0];
  if (!atual) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
    if (atual.reserva_estado === 'ativa' && payload.status !== atual.status) {
      return res.status(409).json({ erro: 'Este pedido tem estoque reservado. Aguarde a confirmação automática do pagamento.' });
    }
    if ((atual.mp_preference_id || atual.checkout_token) && payload.status !== atual.status) {
      return res.status(409).json({ erro: 'O status financeiro deste pedido é atualizado automaticamente pelo Mercado Pago.' });
    }
    // A stale admin form must never rewrite a financial state owned by the payment webhook.
    if (atual.mp_preference_id || atual.checkout_token) delete payload.status;
  }
  const nextStatus = payload.status || atual.status;
  if (payload.envio_status && payload.envio_status !== atual.envio_status &&
      payload.envio_status !== 'aguardando_envio' && nextStatus !== 'pago') {
    return res.status(409).json({ erro: 'Confirme o pagamento antes de avançar a preparação, o envio ou a retirada.' });
  }
  payload.atualizado_em = new Date().toISOString();

  const data = await sb(`/pedidos?id=eq.${id}&status=eq.${encodeURIComponent(atual.status)}`, { method: 'PATCH', body: JSON.stringify(payload) });
  if (!Array.isArray(data) || !data.length) {
    return res.status(409).json({ erro: 'O pedido mudou enquanto você editava. Atualize a lista antes de salvar novamente.' });
  }
  const nextShipping = payload.envio_status || atual.envio_status;
  if (nextStatus !== atual.status && ['pago', 'cancelado', 'reembolsado'].includes(nextStatus)) {
    void notificarPedido(id, nextStatus === 'pago' ? 'pagamento_aprovado' : nextStatus);
  }
  if (nextShipping !== atual.envio_status && ['em_preparacao', 'enviado', 'retirada_disponivel', 'entregue', 'retirado'].includes(nextShipping)) {
    void notificarPedido(id, nextShipping);
  }
  res.json(data);
});

// GET /api/admin/avaliacoes — fila de moderação de avaliações
router.get('/avaliacoes', async (req, res) => {
  const data = await sb('/avaliacoes_produtos?select=*&order=criado_em.desc');
  const reviews = data || [];
  const ids = [...new Set(reviews.map(item => Number(item.produto_id)).filter(Number.isInteger))];
  const products = ids.length ? await sb(`/produtos?id=in.(${ids.join(',')})&select=id,nome`) : [];
  const names = new Map((products || []).map(item => [Number(item.id), item.nome]));
  res.json(reviews.map(item => ({ ...item, produto_nome: names.get(Number(item.produto_id)) || `Produto #${item.produto_id}` })));
});

// PATCH /api/admin/avaliacoes/:id — aprova ou recusa avaliação
router.patch('/avaliacoes/:id', async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').trim();
  if (!Number.isInteger(id) || id <= 0 || !['pendente', 'aprovada', 'recusada'].includes(status)) {
    return res.status(400).json({ erro: 'Avaliação ou status inválido.' });
  }
  const data = await sb(`/avaliacoes_produtos?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, aprovado_em: status === 'aprovada' ? new Date().toISOString() : null }),
  });
  res.json(Array.isArray(data) ? data[0] : data);
});

// GET /api/admin/metricas — resumo anônimo das visitas e intenções de compra
router.get('/metricas', async (req, res) => {
  const days = Number(req.query.dias || 30);
  if (![7, 30, 90].includes(days)) return res.status(400).json({ erro: 'Escolha um período de 7, 30 ou 90 dias.' });
  return res.json(await loadMetrics(sb, days));
});

router.get('/operacao', (req, res) => {
  res.json({ email: { configurado: notifications.isConfigured(), provedor: 'Resend',
    chave_configurada: Boolean(process.env.RESEND_API_KEY), remetente_configurado: Boolean(process.env.EMAIL_FROM) },
    estoque: { reservas_ativas: reservasAtivadas(), integracao_fisica: 'aguardando_formato' },
    eventos_email: Object.keys(notifications.EVENTS), versao: 1 });
});

router.post('/pedidos/:id/aviso', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Pedido inválido.' });
  const pedido = await db.buscarPedido(id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  const event = notifications.currentOrderEvent(pedido);
  if (!event) return res.status(409).json({ erro: 'Este pedido ainda não tem uma atualização confirmada para enviar.' });
  if (!notifications.isConfigured()) return res.status(409).json({ erro: 'Configure o e-mail da loja antes de enviar avisos.' });
  const result = await notificarPedido(id, event);
  if (!result.sent) return res.status(503).json({ erro: 'O aviso não foi enviado. Confira a configuração de e-mail e tente novamente.' });
  res.json({ ok: true, evento: event, mensagem: 'Aviso enviado ou já confirmado pelo provedor.' });
});

router.get('/pedidos/:id/integracao', async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (!id) return res.status(400).json({ erro: 'Pedido inválido.' });
  const pedido = await db.buscarPedido(id);
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  if (pedido.status !== 'pago') return res.status(409).json({ erro: 'A exportação de venda exige pagamento confirmado.' });
  const items = await db.buscarItensPedido(id);
  const ids = [...new Set(items.map(item => Number(item.produto_id)).filter(Number.isSafeInteger))];
  const products = ids.length ? await sb(`/produtos?id=in.(${ids.join(',')})&select=id,referencia`) : [];
  const refs = new Map((products || []).map(product => [Number(product.id), product.referencia]));
  res.set('Cache-Control', 'no-store');
  res.json({ formato: 'rstreet.venda.v1', evento_id: `rstreet:pedido:${id}:pago`, pedido_id: id,
    status: 'pago', pago_em: pedido.pago_em, total: Number(pedido.total),
    itens: items.map(item => ({ produto_id: item.produto_id, variante_id: item.produto_variante_id,
      referencia: refs.get(Number(item.produto_id)) || null, nome: item.nome_produto,
      cor: item.cor, tamanho: item.tamanho, quantidade: Number(item.quantidade) })) });
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
    err.expose = true;
    throw err;
  }

  const midiaTipo = item?.midia_tipo === 'video' ? 'video' : 'image';
  const midias = (Array.isArray(item?.midias) ? item.midias : [])
    .map(media => ({
      url: cleanPublicUrl(media?.url),
      tipo: media?.tipo === 'video' ? 'video' : 'image',
    }))
    .filter(media => media.url)
    .slice(0, 8);
  if (!midias.length && item?.midia_url) {
    midias.push({
      url: cleanPublicUrl(item.midia_url),
      tipo: midiaTipo,
    });
  }
  const principal = midias[0] || { url: cleanPublicUrl(item?.midia_url), tipo: midiaTipo };

  return {
    id,
    marca: String(item?.marca || '').trim().slice(0, 80),
    titulo: String(item?.titulo || '').trim().slice(0, 120),
    midia_url: principal.url,
    midia_tipo: principal.tipo,
    midias,
    link_url: cleanPublicUrl(item?.link_url, 'catalogo.html', 500),
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
    err.expose = true;
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
    banner_url: cleanPublicUrl(input.banner_url || input.banner_desktop_url || input.banner_mobile_url),
    banner_desktop_url: cleanPublicUrl(input.banner_desktop_url || input.banner_url),
    banner_mobile_url: cleanPublicUrl(input.banner_mobile_url || input.banner_url),
    cor_destaque: /^#[0-9a-f]{6}$/i.test(String(input.cor_destaque || ''))
      ? String(input.cor_destaque).trim()
      : '#c8a96e',
    botao_texto: String(input.botao_texto || 'Ver campanha').trim().slice(0, 80) || 'Ver campanha',
    botao_link: cleanPublicUrl(input.botao_link, `catalogo.html?campanha=${slug}`, 500),
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
