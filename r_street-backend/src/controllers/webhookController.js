const db = require('../services/db');
const mp = require('../services/mercadopago');

async function receberWebhook(req, res) {
  try {
    const body = JSON.parse(req.body.toString());
    const tipo = body.type || body.topic;
    const paymentId = body.data?.id || body.id;

    if (tipo !== 'payment' || !paymentId) return res.sendStatus(200);
    await processarPagamentoMercadoPago(paymentId);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err.message);
    return res.sendStatus(500);
  }
}

async function processarPagamentoMercadoPago(paymentId) {
  const pagamento = await mp.buscarPagamento(paymentId);
  const pedidoId = Number(pagamento.external_reference);
  if (!Number.isInteger(pedidoId) || pedidoId <= 0) return null;

  const pedidoAtual = await db.buscarPedido(pedidoId);
  if (!pedidoAtual) return null;

  const statusMap = {
    approved: 'pago',
    pending: 'pendente',
    in_process: 'em_analise',
    rejected: 'recusado',
    cancelled: 'cancelado',
    refunded: 'reembolsado',
    charged_back: 'estornado',
  };
  const novoStatus = statusMap[pagamento.status] || pagamento.status;
  const statusAtual = String(pedidoAtual.status || '').toLowerCase();

  // Um pedido ja reembolsado ou estornado nao pode voltar a pago por uma
  // notificacao atrasada, pois o estoque dessa compra ja foi processado.
  if (['reembolsado', 'estornado'].includes(statusAtual)) {
    return { pagamento, pedidoId, status: statusAtual };
  }

  // Depois de confirmado, somente um reembolso ou estorno real pode retirar
  // o status pago. Retornos pendentes, recusados ou cancelados sao ignorados.
  const podeReverterPagamento = ['refunded', 'charged_back'].includes(pagamento.status);
  if (statusAtual === 'pago' && pagamento.status !== 'approved' && !podeReverterPagamento) {
    return { pagamento, pedidoId, status: 'pago' };
  }

  if (pagamento.status === 'approved') {
    try {
      await db.finalizarPedidoPago(pedidoId, paymentId);
    } catch (estoqueErr) {
      const detalhe = `${estoqueErr.message || ''} ${estoqueErr.responseBody || ''}`;
      const estoqueIndisponivel = /estoque insuficiente|produto indisponível|produto indisponivel|variação indisponível|variacao indisponivel/i.test(detalhe);
      if (!estoqueIndisponivel) throw estoqueErr;

      await db.atualizarPedido(pedidoId, {
        status: 'estoque_indisponivel',
        mp_payment_id: String(paymentId),
        pago_em: new Date().toISOString(),
      });
      console.error('Pagamento aprovado com problema de estoque:', estoqueErr.message);
      return { pagamento, pedidoId, status: 'estoque_indisponivel' };
    }
    return { pagamento, pedidoId, status: 'pago' };
  }

  await db.atualizarPedido(pedidoId, {
    status: novoStatus,
    mp_payment_id: String(paymentId),
    pago_em: podeReverterPagamento ? (pedidoAtual.pago_em || null) : null,
  });

  return { pagamento, pedidoId, status: novoStatus };
}

module.exports = { receberWebhook, processarPagamentoMercadoPago };
