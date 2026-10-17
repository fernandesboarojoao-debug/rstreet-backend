const db = require('../services/db');
const mp = require('../services/mercadopago');
const crypto = require('crypto');
const { reservasAtivadas } = require('../services/reservas');
const { calcularFreteSeguro } = require('../services/frete');
const { validarEnderecoPorCep } = require('../services/cep');

const PIX_DISCOUNT_RATE = 0.05;

function arredondarMoeda(valor) {
  return Math.round(Number(valor || 0) * 100) / 100;
}

function erroPedido(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeCustomerAndAddress(pedidoData) {
  const cliente = {
    nome: cleanText(pedidoData.cliente?.nome, 120),
    email: cleanText(pedidoData.cliente?.email, 254).toLowerCase(),
    telefone: cleanText(pedidoData.cliente?.telefone, 30),
    cpf: cleanText(pedidoData.cliente?.cpf, 20) || null,
  };
  const endereco = {
    cep: cleanText(pedidoData.endereco?.cep, 20),
    rua: cleanText(pedidoData.endereco?.rua, 160),
    numero: cleanText(pedidoData.endereco?.numero, 30),
    complemento: cleanText(pedidoData.endereco?.complemento, 120) || null,
    bairro: cleanText(pedidoData.endereco?.bairro, 100),
    cidade: cleanText(pedidoData.endereco?.cidade, 100),
    estado: cleanText(pedidoData.endereco?.estado, 2).toUpperCase(),
  };

  if (cliente.nome.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliente.email)) {
    throw erroPedido('Nome e e-mail válidos são obrigatórios.');
  }
  const telefoneDigitos = cliente.telefone.replace(/\D/g, '');
  if (telefoneDigitos.length < 10 || telefoneDigitos.length > 11) {
    throw erroPedido('Informe um telefone válido com DDD.');
  }
  if (endereco.cep.replace(/\D/g, '').length !== 8 || !endereco.rua || !endereco.numero
    || !endereco.bairro || !endereco.cidade || !/^[A-Z]{2}$/.test(endereco.estado)) {
    throw erroPedido('Preencha o endereço completo e informe um CEP válido.');
  }
  return { cliente, endereco };
}

function normalizeCheckoutToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
    throw erroPedido('Atualize a pagina do checkout e tente novamente.');
  }
  return token;
}

function checkoutFingerprint(pedido) {
  const itens = pedido.itens.map(item => ({
    id: Number(item.id),
    variante: Number(item.produto_variante_id) || null,
    quantidade: Number(item.quantidade),
    preco: Number(item.preco_pagamento ?? item.preco_unitario),
  })).sort((a, b) => a.id - b.id || Number(a.variante || 0) - Number(b.variante || 0));
  const canonical = JSON.stringify({
    cliente: pedido.cliente,
    endereco: pedido.endereco,
    frete: pedido.frete,
    metodo_pagamento: pedido.metodo_pagamento,
    total: pedido.total,
    itens,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function preferenceResponse(pedido) {
  if (!pedido?.mp_init_point) return null;
  return {
    pedido_id: pedido.id,
    init_point: pedido.mp_init_point,
    sandbox_init_point: pedido.mp_sandbox_init_point || null,
    reutilizado: true,
    reserva_expira_em: pedido.reserva_expira_em || null,
    total: Number(pedido.total),
  };
}

function assertReusableOrder(existing) {
  const error = (message, code) => Object.assign(erroPedido(message, 409), { code });
  if (['em_analise', 'processando_pagamento'].includes(existing.status)) {
    throw error('O pagamento deste pedido ainda está em análise. Acompanhe o pedido antes de iniciar outro pagamento.', 'CHECKOUT_PROCESSING');
  }
  const retryRejected = existing.status === 'recusado' && existing.reserva_estado === 'ativa';
  if ((!retryRejected && existing.status !== 'pendente') || existing.reserva_estado === 'liberada') {
    throw error('Esta tentativa foi encerrada. Confira o pedido e revise o carrinho antes de iniciar outra compra.', 'CHECKOUT_CLOSED');
  }
  const expires = Date.parse(existing.reserva_expira_em || '');
  if (existing.reserva_estado === 'ativa' && (!Number.isFinite(expires) || expires <= Date.now())) {
    throw error('O prazo deste pagamento terminou. A liberação do estoque depende da verificação dos pagamentos pendentes. Aguarde alguns minutos e revise o carrinho.', 'CHECKOUT_EXPIRED');
  }
}

async function findReusableOrder(token, fingerprint) {
  const existing = await db.buscarPedidoPorCheckoutToken(token);
  if (!existing) return null;
  assertReusableOrder(existing);
  if (existing.checkout_fingerprint !== fingerprint) {
    throw Object.assign(erroPedido('Já existe um pagamento iniciado com outros dados. As alterações de endereço, entrega ou pagamento não foram aplicadas ao pedido anterior. Você pode retomar esse pedido ou aguardar o encerramento da reserva para fazer outro.', 409), {
      code: 'CHECKOUT_CHANGED', checkout: preferenceResponse(existing),
    });
  }
  const response = preferenceResponse(existing);
  if (response) return response;
  throw erroPedido('Seu pedido ainda está sendo preparado. Aguarde alguns segundos e tente novamente.', 409);
}

function agruparItensRecebidos(itensRecebidos) {
  if (!Array.isArray(itensRecebidos) || !itensRecebidos.length) {
    throw erroPedido('Carrinho vazio.');
  }
  if (itensRecebidos.length > 100) {
    throw erroPedido('Carrinho com itens demais.');
  }

  const agrupados = new Map();
  for (const item of itensRecebidos) {
    const produtoId = Number(item?.id);
    const varianteId = item?.produto_variante_id == null || item.produto_variante_id === ''
      ? null
      : Number(item.produto_variante_id);
    const quantidade = Number(item?.quantidade);

    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      throw erroPedido('Produto inválido no carrinho.');
    }
    if (varianteId !== null && (!Number.isInteger(varianteId) || varianteId <= 0)) {
      throw erroPedido('Variação inválida no carrinho.');
    }
    if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > 999) {
      throw erroPedido('Quantidade inválida no carrinho.');
    }

    const chave = `${produtoId}:${varianteId || 0}`;
    const existente = agrupados.get(chave);
    if (existente) {
      existente.quantidade += quantidade;
      if (existente.quantidade > 999) throw erroPedido('Quantidade inválida no carrinho.');
    } else {
      agrupados.set(chave, {
        ...item,
        id: produtoId,
        produto_variante_id: varianteId,
        quantidade,
      });
    }
  }
  return [...agrupados.values()];
}

async function montarPedidoSeguro(pedidoData = {}, { skipStockCheck = false } = {}) {
  const metodosPermitidos = new Set(['credit_card', 'debit_card', 'pix']);
  const metodoPagamento = pedidoData.metodo_pagamento || 'credit_card';
  if (!metodosPermitidos.has(metodoPagamento)) throw erroPedido('Escolha cartao ou Pix para continuar.');
  const itensRecebidos = agruparItensRecebidos(pedidoData.itens);
  const ids = itensRecebidos.map(i => i.id);
  const varianteIds = itensRecebidos.map(i => i.produto_variante_id).filter(Boolean);
  const produtos = await db.buscarProdutosPorIds(ids);
  const variantes = await db.buscarVariantesPorIds(varianteIds);
  const variantesProdutos = await db.buscarVariantesPorProdutoIds(ids);
  const porId = new Map(produtos.map(p => [Number(p.id), p]));
  const variantePorId = new Map(variantes.map(v => [Number(v.id), v]));
  const produtosComVariantes = new Set(variantesProdutos.map(v => Number(v.produto_id)));

  const itens = itensRecebidos.map(item => {
    const produtoId = Number(item.id);
    const quantidade = item.quantidade;
    const produto = porId.get(produtoId);

    if (!produto || produto.ativo === false) {
      throw erroPedido('Produto indisponível no catálogo.');
    }
    let estoqueDisponivel = Number(produto.estoque);
    let cor = item.cor || null;
    let tamanho = item.tamanho || null;
    let produto_variante_id = item.produto_variante_id ? Number(item.produto_variante_id) : null;

    if (produtosComVariantes.has(produtoId) && !produto_variante_id) {
      throw erroPedido('Escolha cor e tamanho antes de finalizar a compra.');
    }

    if (produto_variante_id) {
      const variante = variantePorId.get(produto_variante_id);
      if (!variante || Number(variante.produto_id) !== produtoId || variante.ativo === false) {
        throw erroPedido('Variação indisponível no catálogo.');
      }
      estoqueDisponivel = Number(variante.estoque);
      cor = variante.cor || cor;
      tamanho = variante.tamanho || tamanho;
    }

    const precoUnitario = produto_variante_id && variantePorId.get(produto_variante_id)?.preco != null
      ? Number(variantePorId.get(produto_variante_id).preco)
      : Number(produto.preco);

    if (!Number.isFinite(estoqueDisponivel) || estoqueDisponivel < 0) {
      throw erroPedido(`Não foi possível confirmar o estoque de ${produto.nome}.`, 503);
    }
    if (!Number.isFinite(precoUnitario) || precoUnitario <= 0) {
      throw erroPedido(`Preço inválido para ${produto.nome}.`, 409);
    }
    if (!skipStockCheck && estoqueDisponivel < quantidade) {
      throw erroPedido(`Estoque insuficiente para ${produto.nome}.`, 409);
    }

    return {
      id: produto.id,
      nome: produto.nome,
      produto_variante_id,
      quantidade,
      preco_unitario: precoUnitario,
      cor,
      tamanho,
    };
  });

  const frete = calcularFreteSeguro(pedidoData.frete, pedidoData.endereco);
  const subtotal = arredondarMoeda(itens.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0));
  const itensComPagamento = metodoPagamento === 'pix'
    ? itens.map(item => ({
        ...item,
        preco_pagamento: arredondarMoeda(item.preco_unitario * (1 - PIX_DISCOUNT_RATE)),
      }))
    : itens.map(item => ({ ...item, preco_pagamento: arredondarMoeda(item.preco_unitario) }));
  const descontoPix = metodoPagamento === 'pix'
    ? arredondarMoeda(subtotal - itensComPagamento.reduce((s, i) => s + i.preco_pagamento * i.quantidade, 0))
    : 0;
  const totalProdutosPagamento = arredondarMoeda(itensComPagamento.reduce((s, i) => s + i.preco_pagamento * i.quantidade, 0));
  const total = arredondarMoeda(totalProdutosPagamento + frete.valor);
  if (pedidoData.total !== undefined && (!Number.isFinite(Number(pedidoData.total))
    || Math.round(Number(pedidoData.total) * 100) !== Math.round(total * 100))) {
    throw erroPedido('O valor da compra mudou. Revise o carrinho e o frete antes de continuar.', 409);
  }

  return {
    ...pedidoData,
    metodo_pagamento: metodoPagamento,
    itens: itensComPagamento,
    frete,
    subtotal,
    desconto_pix: descontoPix,
    total,
  };
}

async function criarPagamento(req, res) {
  const pedidoData = req.body || {};
  if (!pedidoData.itens?.length) {
    return res.status(400).json({ erro: 'Carrinho vazio.' });
  }

  const checkoutToken = normalizeCheckoutToken(pedidoData.checkout_token);
  const existing = await db.buscarPedidoPorCheckoutToken(checkoutToken);
  let normalized;
  let pedidoSeguro;
  try {
    normalized = normalizeCustomerAndAddress(pedidoData);
    normalized.endereco = await validarEnderecoPorCep(normalized.endereco);
    if (!existing) pedidoSeguro = await montarPedidoSeguro({ ...pedidoData, ...normalized });
  } catch (err) {
    // Only retire an attempt known not to have created a payment, including in another tab.
    if (!existing && err.expose === true && err.status >= 400 && err.status < 500
      && !await db.buscarPedidoPorCheckoutToken(checkoutToken)) err.code = 'CHECKOUT_REVALIDATE';
    throw err;
  }
  if (existing) {
    assertReusableOrder(existing);
    // Retry the immutable order, even if catalog prices or availability changed.
    const savedItems = await db.buscarItensPedido(existing.id);
    const requestedItems = agruparItensRecebidos(pedidoData.itens).map(item => {
      const saved = savedItems.find(saved => Number(saved.produto_id) === Number(item.id)
        && Number(saved.produto_variante_id || 0) === Number(item.produto_variante_id || 0));
      const price = saved ? Number(saved.preco_unitario) : -1;
      return { ...item, preco_pagamento: pedidoData.metodo_pagamento === 'pix'
        ? arredondarMoeda(price * (1 - PIX_DISCOUNT_RATE)) : price };
    });
    const fingerprint = checkoutFingerprint({ ...pedidoData, ...normalized, itens: requestedItems,
      frete: { tipo: String(pedidoData.frete?.tipo || ''), valor: Number(pedidoData.frete?.valor) }, total: Number(pedidoData.total) });
    return res.json(await findReusableOrder(checkoutToken, fingerprint));
  }
  pedidoSeguro.checkout_token = checkoutToken;
  pedidoSeguro.checkout_fingerprint = checkoutFingerprint(pedidoSeguro);

  const reused = await findReusableOrder(checkoutToken, pedidoSeguro.checkout_fingerprint);
  if (reused) return res.json(reused);

  let pedido;
  try {
    pedido = await db.criarPedido(pedidoSeguro);
  } catch (err) {
    const detail = `${err.message || ''} ${err.responseBody || ''}`;
    if (/pedidos_checkout_token_unique|duplicate key|23505/i.test(detail)) {
      const concurrent = await findReusableOrder(checkoutToken, pedidoSeguro.checkout_fingerprint);
      if (concurrent) return res.json(concurrent);
    }
    throw err;
  }
  console.log(`Pedido criado: #${pedido.id}`);

  let preferenceRequested = false;
  try {
    await db.criarItensPedido(pedido.id, pedidoSeguro.itens);

    if (reservasAtivadas()) {
      const reservado = await db.reservarEstoquePedido(pedido.id);
      pedidoSeguro.reserva_expira_em = reservado.reserva_expira_em;
    }

    preferenceRequested = true;
    const preferencia = await mp.criarPreferencia(pedidoSeguro, pedido.id);
    console.log(`Preferencia MP criada: ${preferencia.id}`);

    await db.atualizarPedido(pedido.id, {
      mp_preference_id: preferencia.id,
      mp_init_point: preferencia.init_point,
      mp_sandbox_init_point: preferencia.sandbox_init_point || null,
    });

    return res.json({
      pedido_id: pedido.id,
      init_point: preferencia.init_point,
      sandbox_init_point: preferencia.sandbox_init_point,
      reserva_expira_em: pedidoSeguro.reserva_expira_em || null,
      total: pedidoSeguro.total,
    });
  } catch (err) {
    if (preferenceRequested) {
      // A timeout or failed database write does not prove that Mercado Pago failed.
      // Keep the token and reservation for reconciliation instead of enabling a second checkout.
      console.error(`Pagamento do pedido #${pedido.id} precisa de verificacao:`, err.message);
      throw Object.assign(erroPedido('Não foi possível confirmar a abertura do pagamento. Aguarde alguns minutos e tente novamente. A reserva será verificada antes de liberar uma nova tentativa.', 503), {
        code: 'CHECKOUT_PROCESSING',
      });
    }
    let cleaned = false;
    try {
      if (reservasAtivadas()) {
        await db.liberarReservaPedido(pedido.id);
      }
      await db.atualizarPedido(pedido.id, {
        status: 'cancelado',
        checkout_token: null,
        checkout_fingerprint: null,
      });
      cleaned = true;
    } catch (cleanupErr) {
      console.error(`Falha ao cancelar pedido incompleto #${pedido.id}:`, cleanupErr.message);
    }
    if (/estoque insuficiente|indisponivel|preco mudou|escolha uma variacao/i.test(err.message)) {
      throw Object.assign(erroPedido('O estoque ou preço mudou. Revise o carrinho antes de continuar.', 409), {
        ...(cleaned ? { code: 'CHECKOUT_REVALIDATE' } : {}),
      });
    }
    throw err;
  }
}

module.exports = { criarPagamento, montarPedidoSeguro, normalizeCheckoutToken, checkoutFingerprint, findReusableOrder, assertReusableOrder };
