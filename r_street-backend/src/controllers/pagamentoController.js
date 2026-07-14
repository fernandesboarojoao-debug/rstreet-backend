const db = require('../services/db');
const mp = require('../services/mercadopago');
const { calcularFreteSeguro } = require('../services/frete');

async function montarPedidoSeguro(pedidoData) {
  const ids = pedidoData.itens.map(i => i.id);
  const varianteIds = pedidoData.itens.map(i => i.produto_variante_id).filter(Boolean);
  const produtos = await db.buscarProdutosPorIds(ids);
  const variantes = await db.buscarVariantesPorIds(varianteIds);
  const variantesProdutos = await db.buscarVariantesPorProdutoIds(ids);
  const porId = new Map(produtos.map(p => [Number(p.id), p]));
  const variantePorId = new Map(variantes.map(v => [Number(v.id), v]));
  const produtosComVariantes = new Set(variantesProdutos.map(v => Number(v.produto_id)));

  const itens = pedidoData.itens.map(item => {
    const produtoId = Number(item.id);
    const quantidade = Math.max(1, parseInt(item.quantidade, 10) || 1);
    const produto = porId.get(produtoId);

    if (!produto || produto.ativo === false) {
      const err = new Error('Produto indisponivel no catalogo.');
      err.status = 400;
      throw err;
    }
    let estoqueDisponivel = Number(produto.estoque);
    let cor = item.cor || null;
    let tamanho = item.tamanho || null;
    let produto_variante_id = item.produto_variante_id ? Number(item.produto_variante_id) : null;

    if (produtosComVariantes.has(produtoId) && !produto_variante_id) {
      const err = new Error('Escolha cor e tamanho antes de finalizar a compra.');
      err.status = 400;
      throw err;
    }

    if (produto_variante_id) {
      const variante = variantePorId.get(produto_variante_id);
      if (!variante || Number(variante.produto_id) !== produtoId || variante.ativo === false) {
        const err = new Error('Variacao indisponivel no catalogo.');
        err.status = 400;
        throw err;
      }
      estoqueDisponivel = Number(variante.estoque);
      cor = variante.cor || cor;
      tamanho = variante.tamanho || tamanho;
    }

    if (estoqueDisponivel < quantidade) {
      const err = new Error(`Estoque insuficiente para ${produto.nome}.`);
      err.status = 409;
      throw err;
    }

    return {
      id: produto.id,
      nome: produto.nome,
      produto_variante_id,
      quantidade,
      preco_unitario: Number(produto.preco),
      cor,
      tamanho,
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
