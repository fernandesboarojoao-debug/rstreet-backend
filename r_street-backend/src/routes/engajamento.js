const express = require('express');
const db = require('../services/db');
const { readPages } = require('../services/metricas');

const router = express.Router();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function cleanText(value, max = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function reviewName(name) {
  const first = cleanText(name, 80).split(' ')[0] || 'Cliente';
  return `${first.charAt(0).toUpperCase()}${first.slice(1).toLowerCase()}`;
}

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(text || 'Erro ao salvar.');
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

router.get('/avaliacoes/produto/:produtoId', async (req, res) => {
  if (req.query.pagina !== undefined) {
    const id = Number(req.params.produtoId);
    const pagina = Number(req.query.pagina);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(pagina) || pagina < 1 || pagina > 100000) {
      return res.status(400).json({ erro: 'Produto ou página inválida.' });
    }
    return res.json(await db.buscarPaginaAvaliacoes(id, pagina));
  }
  const reviews = await db.buscarAvaliacoesPublicadas(req.params.produtoId);
  res.json(reviews || []);
});

router.post('/avaliacoes', async (req, res) => {
  const pedidoId = Number(req.body?.pedido_id);
  const produtoId = Number(req.body?.produto_id);
  const email = cleanText(req.body?.email, 254).toLowerCase();
  const nota = Number(req.body?.nota);
  const comentario = cleanText(req.body?.comentario, 800);

  if (!Number.isInteger(pedidoId) || pedidoId <= 0 || !Number.isInteger(produtoId) || produtoId <= 0 || !email) {
    return res.status(400).json({ erro: 'Informe pedido, e-mail e produto para avaliar.' });
  }
  if (!Number.isInteger(nota) || nota < 1 || nota > 5 || comentario.length < 8) {
    return res.status(400).json({ erro: 'Escolha uma nota e escreva um comentário com pelo menos 8 caracteres.' });
  }

  const pedido = await db.buscarPedidoPorIdEmail(pedidoId, email);
  if (!pedido || String(pedido.status).toLowerCase() !== 'pago') {
    return res.status(403).json({ erro: 'Só é possível avaliar produtos de pedidos pagos.' });
  }
  const itens = await db.buscarItensPedido(pedidoId);
  if (!itens.some(item => Number(item.produto_id) === produtoId)) {
    return res.status(403).json({ erro: 'Esse produto não faz parte do pedido informado.' });
  }

  try {
    await db.criarAvaliacao({
      pedido_id: pedidoId,
      produto_id: produtoId,
      nome_cliente: reviewName(pedido.cliente_nome),
      nota,
      comentario,
      status: 'pendente',
    });
    res.status(201).json({ ok: true, mensagem: 'Avaliação recebida e aguardando aprovação.' });
  } catch (err) {
    if (String(err.message || '').includes('avaliacoes_produtos_pedido_id_produto_id_key')) {
      return res.status(409).json({ erro: 'Este produto já foi avaliado nesse pedido.' });
    }
    throw err;
  }
});

router.post('/metricas', async (req, res) => {
  const allowed = new Set(['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'begin_checkout_item', 'purchase', 'purchase_item', 'whatsapp']);
  const tipo = cleanText(req.body?.tipo, 30);
  const sessaoId = cleanText(req.body?.sessao_id, 80);
  const pagina = cleanText(req.body?.pagina, 120);
  const produtoId = Number(req.body?.produto_id);
  const varianteId = Number(req.body?.produto_variante_id);
  const valor = Number(req.body?.valor);

  if (!allowed.has(tipo) || sessaoId.length < 12 || !pagina) {
    return res.status(400).json({ erro: 'Evento inválido.' });
  }

  await sb('/metricas_eventos', {
    method: 'POST',
    body: JSON.stringify({
      sessao_id: sessaoId,
      tipo,
      pagina,
      produto_id: Number.isInteger(produtoId) && produtoId > 0 ? produtoId : null,
      produto_variante_id: Number.isInteger(varianteId) && varianteId > 0 ? varianteId : null,
      marca: cleanText(req.body?.marca, 80) || null,
      categoria: cleanText(req.body?.categoria, 80) || null,
      valor: Number.isFinite(valor) && valor >= 0 ? valor : null,
    }),
  });
  res.status(204).end();
});

// Dados agregados para vitrines públicas. Não expõe clientes, pedidos ou valores.
let showcaseCache = null;
let showcaseRequest = null;
router.get('/vitrines', async (req, res) => {
  if (!showcaseCache || showcaseCache.until <= Date.now()) {
    if (!showcaseRequest) showcaseRequest = (async () => {
      const since = new Date(Date.now() - 90 * 86400000).toISOString();
      const sold = await readPages(path => sb(path, { signal: AbortSignal.timeout(10000) }), 'itens_pedido', { select: 'id,produto_id,quantidade,pedidos!inner(status,pago_em)',
        'pedidos.status': 'eq.pago', 'pedidos.pago_em': `gte.${since}`, order: 'id.asc' });
      const count = new Map();
      sold.rows.forEach(item => {
        const id = Number(item.produto_id);
        const quantity = Number(item.quantidade);
        if (Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(quantity) && quantity > 0) {
          count.set(id, (count.get(id) || 0) + quantity);
        }
      });
      const data = { mais_vendidos: [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10).map(([id]) => id),
        periodo_dias: 90, amostra_limitada: sold.limited };
      showcaseCache = { data, until: Date.now() + 60000 };
    })().finally(() => { showcaseRequest = null; });
    await showcaseRequest;
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json(showcaseCache.data);
});

module.exports = router;
