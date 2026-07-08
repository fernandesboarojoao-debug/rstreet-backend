// src/services/db.js
// Conexão com Supabase via REST API (sem biblioteca extra)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase erro ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── PEDIDOS ──────────────────────────────────────────────

async function criarPedido(dados) {
  const rows = await sbFetch('/pedidos', {
    method: 'POST',
    body: JSON.stringify({
      cliente_nome:       dados.cliente.nome,
      cliente_email:      dados.cliente.email,
      cliente_telefone:   dados.cliente.telefone,
      cliente_cpf:        dados.cliente.cpf || null,
      endereco_cep:       dados.endereco.cep,
      endereco_rua:       dados.endereco.rua,
      endereco_numero:    dados.endereco.numero,
      endereco_complemento: dados.endereco.complemento || null,
      endereco_bairro:    dados.endereco.bairro,
      endereco_cidade:    dados.endereco.cidade,
      endereco_estado:    dados.endereco.estado,
      frete_tipo:         dados.frete.tipo,
      frete_valor:        dados.frete.valor,
      subtotal:           dados.itens.reduce((s,i) => s + i.preco_unitario * i.quantidade, 0),
      total:              dados.total,
      metodo_pagamento:   dados.metodo_pagamento,
      status:             'pendente',
    }),
  });
  return rows[0];
}

async function criarItensPedido(pedidoId, itens) {
  const rows = itens.map(i => ({
    pedido_id:      pedidoId,
    produto_id:     i.id,
    nome_produto:   i.nome,
    quantidade:     i.quantidade,
    preco_unitario: i.preco_unitario,
    total:          i.preco_unitario * i.quantidade,
  }));
  return sbFetch('/itens_pedido', { method: 'POST', body: JSON.stringify(rows) });
}

async function atualizarPedido(pedidoId, dados) {
  return sbFetch(`/pedidos?id=eq.${pedidoId}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...dados, atualizado_em: new Date().toISOString() }),
  });
}

async function buscarPedido(pedidoId) {
  const rows = await sbFetch(`/pedidos?id=eq.${pedidoId}&select=*`);
  return rows?.[0] || null;
}

async function buscarPedidoPorMPId(mpPaymentId) {
  const rows = await sbFetch(`/pedidos?mp_payment_id=eq.${mpPaymentId}&select=*`);
  return rows?.[0] || null;
}

// ── ESTOQUE ──────────────────────────────────────────────

async function reduzirEstoque(produtoId, quantidade) {
  // Busca estoque atual
  const rows = await sbFetch(`/produtos?id=eq.${produtoId}&select=id,estoque`);
  const produto = rows?.[0];
  if (!produto) return;
  const novoEstoque = Math.max(0, produto.estoque - quantidade);
  return sbFetch(`/produtos?id=eq.${produtoId}`, {
    method: 'PATCH',
    body: JSON.stringify({ estoque: novoEstoque }),
  });
}

module.exports = {
  criarPedido,
  criarItensPedido,
  atualizarPedido,
  buscarPedido,
  buscarPedidoPorMPId,
  reduzirEstoque,
};
