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
    produto_variante_id: i.produto_variante_id || null,
    nome_produto:   i.nome,
    quantidade:     i.quantidade,
    preco_unitario: i.preco_unitario,
    total:          i.preco_unitario * i.quantidade,
    cor:            i.cor || null,
    tamanho:        i.tamanho || null,
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

async function buscarProdutosPorIds(ids) {
  const limpos = [...new Set((ids || []).map(id => Number(id)).filter(Number.isFinite))];
  if (!limpos.length) return [];
  return sbFetch(`/produtos?id=in.(${limpos.join(',')})&select=id,nome,preco,estoque,ativo`);
}

async function buscarVariantesPorIds(ids) {
  const limpos = [...new Set((ids || []).map(id => Number(id)).filter(Number.isFinite))];
  if (!limpos.length) return [];
  return sbFetch(`/produto_variantes?id=in.(${limpos.join(',')})&select=id,produto_id,cor,tamanho,estoque,ativo`);
}

// ── ESTOQUE ──────────────────────────────────────────────

async function reduzirEstoque(produtoId, quantidade, varianteId = null) {
  if (varianteId) {
    const atualVar = await sbFetch(`/produto_variantes?id=eq.${varianteId}&produto_id=eq.${produtoId}&ativo=eq.true&select=id,estoque`);
    const variante = atualVar?.[0];
    if (!variante || Number(variante.estoque) < Number(quantidade)) {
      const err = new Error(`Estoque insuficiente para a variacao #${varianteId}.`);
      err.status = 409;
      throw err;
    }

    const novoEstoqueVariante = Number(variante.estoque) - Number(quantidade);
    const rowsVar = await sbFetch(`/produto_variantes?id=eq.${varianteId}&estoque=eq.${variante.estoque}`, {
      method: 'PATCH',
      body: JSON.stringify({ estoque: novoEstoqueVariante }),
    });
    if (!rowsVar?.length) {
      const err = new Error(`Estoque insuficiente para a variacao #${varianteId}.`);
      err.status = 409;
      throw err;
    }

    const atualProduto = await sbFetch(`/produtos?id=eq.${produtoId}&select=id,estoque`);
    const produto = atualProduto?.[0];
    if (produto) {
      const novoEstoqueProduto = Math.max(0, Number(produto.estoque) - Number(quantidade));
      await sbFetch(`/produtos?id=eq.${produtoId}`, {
        method: 'PATCH',
        body: JSON.stringify({ estoque: novoEstoqueProduto }),
      });
    }
    return rowsVar[0];
  }

  const atual = await sbFetch(`/produtos?id=eq.${produtoId}&ativo=eq.true&select=id,estoque`);
  const produto = atual?.[0];
  if (!produto || Number(produto.estoque) < Number(quantidade)) {
    const err = new Error(`Estoque insuficiente para o produto #${produtoId}.`);
    err.status = 409;
    throw err;
  }

  const novoEstoque = Number(produto.estoque) - Number(quantidade);
  const rows = await sbFetch(`/produtos?id=eq.${produtoId}&estoque=eq.${produto.estoque}`, {
    method: 'PATCH',
    body: JSON.stringify({ estoque: novoEstoque }),
  });
  if (!rows?.length) {
    const err = new Error(`Estoque insuficiente para o produto #${produtoId}.`);
    err.status = 409;
    throw err;
  }
  return rows[0];
}

module.exports = {
  criarPedido,
  criarItensPedido,
  atualizarPedido,
  buscarPedido,
  buscarPedidoPorMPId,
  buscarProdutosPorIds,
  buscarVariantesPorIds,
  reduzirEstoque,
};
