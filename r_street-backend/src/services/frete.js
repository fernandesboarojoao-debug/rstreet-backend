const FRETE_REGRAS = {
  local: { tipo: 'Entrega local', valor: 8.00 },
  sp: { tipo: 'Entrega SP', valor: 18.00 },
  regional: { tipo: 'Entrega regional', valor: 28.00 },
  nacional: { tipo: 'Entrega nacional', valor: 38.00 },
  retirada: { tipo: 'Retirada na Loja', valor: 0 },
};

function normalizarTexto(txt) {
  return String(txt || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function calcularOpcoesFrete(endereco = {}) {
  const cidadeNorm = normalizarTexto(endereco.cidade);
  const uf = String(endereco.estado || '').toUpperCase();

  if (uf === 'SP' && cidadeNorm === 'sao jose do rio pardo') {
    return [FRETE_REGRAS.retirada, FRETE_REGRAS.local];
  }
  if (uf === 'SP') return [FRETE_REGRAS.sp];
  if (['MG', 'RJ', 'PR'].includes(uf)) return [FRETE_REGRAS.regional];
  return [FRETE_REGRAS.nacional];
}

function calcularFreteSeguro(frete = {}, endereco = {}) {
  const valorPedido = Number(frete.valor) || 0;
  const tipoPedido = String(frete.tipo || '').trim();
  const opcoes = calcularOpcoesFrete(endereco);
  const selecionado = opcoes.find(op => (
    op.tipo === tipoPedido && Number(op.valor) === valorPedido
  ));

  if (!selecionado) {
    const err = new Error('Opcao de frete invalida para o endereco informado.');
    err.status = 400;
    throw err;
  }

  return { tipo: selecionado.tipo, valor: selecionado.valor };
}

module.exports = { calcularFreteSeguro };
