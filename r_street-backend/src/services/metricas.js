const PAGE_SIZE = 500;
const MAX_ROWS = 20000;

async function readPages(sb, resource, query) {
  const rows = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const params = new URLSearchParams({ ...query, limit: String(PAGE_SIZE), offset: String(offset) });
    const page = await sb(`/${resource}?${params}`);
    if (!Array.isArray(page)) throw new Error('Resposta de metricas invalida.');
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, limited: false };
  }
  return { rows, limited: true };
}

function summarize(events, paidOrders, soldItems, products) {
  const totals = { page_view: 0, view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: paidOrders.length, whatsapp: 0 };
  const sessions = new Map();
  const productMap = new Map();
  function product(id) {
    const key = Number(id);
    if (!Number.isSafeInteger(key) || key <= 0) return null;
    if (!productMap.has(key)) productMap.set(key, { produto_id: key, visualizacoes: 0, carrinhos: 0, checkouts: 0, compras: 0 });
    return productMap.get(key);
  }
  for (const event of events) {
    if (event.tipo !== 'purchase' && Object.hasOwn(totals, event.tipo)) totals[event.tipo]++;
    if (event.sessao_id) {
      if (!sessions.has(event.sessao_id)) sessions.set(event.sessao_id, new Set());
      sessions.get(event.sessao_id).add(event.tipo);
    }
    const row = product(event.produto_id);
    if (!row) continue;
    if (event.tipo === 'view_item') row.visualizacoes++;
    if (event.tipo === 'add_to_cart') row.carrinhos++;
    if (event.tipo === 'begin_checkout_item') row.checkouts++;
  }
  for (const item of soldItems) {
    const row = product(item.produto_id);
    if (row) row.compras += Math.max(0, Number(item.quantidade) || 0);
  }
  const names = new Map(products.map(p => [Number(p.id), p]));
  const top = [...productMap.values()].map(row => ({ ...row,
    nome: names.get(row.produto_id)?.nome || `Produto #${row.produto_id}`, marca: names.get(row.produto_id)?.marca || '',
  })).sort((a, b) => b.carrinhos - a.carrinhos || b.visualizacoes - a.visualizacoes).slice(0, 30);
  const allSessions = [...sessions.values()];
  const count = type => allSessions.filter(events => events.has(type)).length;
  const revenue = Math.round(paidOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0) * 100) / 100;
  return {
    totais: totals, receita: revenue, ticket_medio: paidOrders.length ? revenue / paidOrders.length : 0,
    sessoes: { total: sessions.size, com_produto: count('view_item'), com_carrinho: count('add_to_cart'),
      com_checkout: count('begin_checkout'), com_compra_observada: count('purchase'),
      checkout_sem_confirmacao: allSessions.filter(events => events.has('begin_checkout') && !events.has('purchase')).length },
    produtos: top,
  };
}

async function loadMetrics(sb, days) {
  const now = Date.now();
  const since = new Date(now - days * 86400000).toISOString();
  const until = new Date(now).toISOString();
  const [events, orders, items] = await Promise.all([
    readPages(sb, 'metricas_eventos', { and: `(criado_em.gte.${since},criado_em.lte.${until})`, select: 'id,tipo,sessao_id,produto_id,criado_em', order: 'criado_em.desc,id.desc' }),
    readPages(sb, 'pedidos', { status: 'eq.pago', pago_em: `gte.${since}`, select: 'id,total', order: 'id.asc' }),
    readPages(sb, 'itens_pedido', { select: 'id,produto_id,quantidade,pedidos!inner(status,pago_em)',
      'pedidos.status': 'eq.pago', 'pedidos.pago_em': `gte.${since}`, order: 'id.asc' }),
  ]);
  const ids = [...new Set([...events.rows, ...items.rows].map(row => Number(row.produto_id)).filter(id => Number.isSafeInteger(id) && id > 0))];
  const products = [];
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await sb(`/produtos?id=in.(${ids.slice(i, i + 100).join(',')})&select=id,nome,marca`);
    if (!Array.isArray(rows)) throw new Error('Produtos de metricas indisponiveis.');
    products.push(...rows);
  }
  return { ...summarize(events.rows, orders.rows, items.rows, products), periodo_dias: days,
    amostra_limitada: events.limited || orders.limited || items.limited,
    atualizado_em: new Date().toISOString() };
}

module.exports = { loadMetrics, summarize, readPages };
