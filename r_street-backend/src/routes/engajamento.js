const express = require('express');
const db = require('../services/db');

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
router.get('/vitrines', async (req, res) => {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const count = new Map();
  let salesHistoryAvailable = false;
  try {
    const soldItems = await sb('/itens_pedido?select=produto_id,quantidade,pedidos!inner(status)&pedidos.status=eq.pago');
    salesHistoryAvailable = true;
    (soldItems || []).forEach(item => {
      const id = Number(item.produto_id);
      const quantity = Math.max(1, Number(item.quantidade) || 1);
      if (Number.isInteger(id) && id > 0) count.set(id, (count.get(id) || 0) + quantity);
    });
  } catch (error) {
    // As metricas servem apenas como plano B se o historico de vendas nao estiver disponivel.
    console.warn('Nao foi possivel consultar itens vendidos:', error.message);
  }

  if (!salesHistoryAvailable) {
    const events = await sb(`/metricas_eventos?tipo=eq.purchase_item&criado_em=gte.${encodeURIComponent(since)}&produto_id=not.is.null&select=produto_id`);
    (events || []).forEach(item => {
      const id = Number(item.produto_id);
      if (Number.isInteger(id) && id > 0) count.set(id, (count.get(id) || 0) + 1);
    });
  }
  const maisVendidos = [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([produto_id]) => produto_id);
  res.json({ mais_vendidos: maisVendidos });
});

module.exports = router;
