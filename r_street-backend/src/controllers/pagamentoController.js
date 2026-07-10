const db = require('../services/db');
const mp = require('../services/mercadopago');
const { calcularFreteSeguro } = require('../services/frete');

async function montarPedidoSeguro(pedidoData) {
  const ids = pedidoData.itens.map(i => i.id);
  const produtos = await db.buscarProdutosPorIds(ids);
  const porId = new Map(produtos.map(p => [Number(p.id), p]));

  const itens = pedidoData.itens.map(item => {
    const produtoId = Number(item.id);
    const quantidade = Math.max(1, parseInt(item.quantidade, 10) || 1);
    const produto = porId.get(produtoId);

    if (!produto || produto.ativo === false) {
      const err = new Error('Produto indisponivel no catalogo.');
      err.status = 400;
      throw err;
    }
    if (Number(produto.estoque) < quantidade) {
      const err = new Error(`Estoque insuficiente para ${produto.nome}.`);
      err.status = 409;
      throw err;
    }

    return {
      id: produto.id,
      nome: produto.nome,
      quantidade,
      preco_unitario: Number(produto.preco),
      tamanho: item.tamanho || null,
    };
  });

  const frete = calcularFreteSeguro(pedidoData.frete, pedidoData.endereco);
  const subtotal = itens.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0);
  const total = subtotal + frete.valor;

  return {
    ...pedidoData,
    itens,
    frete,
    subtotal,
    total,
  };
}

async function criarPagamento(req, res) {
  const pedidoData = req.body;

  if (!pedidoData.cliente?.nome || !pedidoData.cliente?.email) {
    return res.status(400).json({ erro: 'Dados do cliente obrigatorios.' });
  }
  if (!pedidoData.itens?.length) {
    return res.status(400).json({ erro: 'Carrinho vazio.' });
  }

  const pedidoSeguro = await montarPedidoSeguro(pedidoData);

  const pedido = await db.criarPedido(pedidoSeguro);
  console.log(`Pedido criado: #${pedido.id}`);

  await db.criarItensPedido(pedido.id, pedidoSeguro.itens);

  const preferencia = await mp.criarPreferencia(pedidoSeguro, pedido.id);
  console.log(`Preferencia MP criada: ${preferencia.id}`);

  await db.atualizarPedido(pedido.id, { mp_preference_id: preferencia.id });

  res.json({
    pedido_id: pedido.id,
    init_point: preferencia.init_point,
    sandbox_init_point: preferencia.sandbox_init_point,
  });
}

module.exports = { criarPagamento, montarPedidoSeguro };
