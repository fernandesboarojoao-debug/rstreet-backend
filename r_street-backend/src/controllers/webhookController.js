const db = require('../services/db');
const mp = require('../services/mercadopago');
const { verifyMercadoPagoWebhookSignature } = require('../services/webhookSignature');
const { notificarPedido } = require('../services/notificacoes');

async function receberWebhook(req, res) {
  try {
    const body = JSON.parse(req.body.toString());
    const tipo = body.type || body.topic;
    const queryDataId = req.query?.['data.id'] || req.query?.data_id || '';
    const bodyDataId = body.data?.id || body.id || '';
    const signedDataId = String(queryDataId || bodyDataId).trim();
    const paymentId = String(bodyDataId || queryDataId).trim();

    const webhookSecret = String(process.env.MP_WEBHOOK_SECRET || '');
    if (webhookSecret) {
      const signatureValid = verifyMercadoPagoWebhookSignature({
        xSignature: req.headers['x-signature'],
        xRequestId: req.headers['x-request-id'],
        dataId: signedDataId,
        secret: webhookSecret,
      });
      if (!signatureValid) return res.sendStatus(401);
    } else {
      // Compatibilidade com o deploy atual: nenhuma informacao do corpo e
      // confiada. O status e a referencia sao consultados na API do MP.
      console.warn('MP_WEBHOOK_SECRET ausente; validando o pagamento pela API do Mercado Pago.');
    }
    if (queryDataId && bodyDataId && String(queryDataId) !== String(bodyDataId)) return res.sendStatus(400);

    if (tipo !== 'payment' || !/^\d{1,30}$/.test(paymentId)) return res.sendStatus(200);
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
    const esperado = Number(pedidoAtual.total);
    const recebido = Number(pagamento.transaction_amount);
    if (!Number.isFinite(esperado) || esperado <= 0 || !Number.isFinite(recebido)
      || Math.round(esperado * 100) !== Math.round(recebido * 100)
      || pagamento.currency_id !== 'BRL') {
      throw new Error('Pagamento divergente do valor ou moeda do pedido.');
    }
    if (pedidoAtual.mp_preference_id) {
      const ordemId = pagamento.order?.id;
      if (!ordemId) throw new Error('Pagamento sem vinculo verificavel com o checkout.');
      const ordem = await mp.buscarPedidoComercial(ordemId);
      if (String(ordem.preference_id) !== String(pedidoAtual.mp_preference_id)
        || String(ordem.external_reference) !== String(pedidoId)
        || !ordem.payments?.some(item => String(item.id) === String(paymentId))) {
        throw new Error('Pagamento nao pertence ao checkout deste pedido.');
      }
    }
    try {
      await db.finalizarPedidoPago(pedidoId, paymentId);
    } catch (estoqueErr) {
      const detalhe = `${estoqueErr.message || ''} ${estoqueErr.responseBody || ''}`;
      const estoqueIndisponivel = /estoque insuficiente|produto indisponível|produto indisponivel|variação indisponível|variacao indisponivel|escolha uma variacao/i.test(detalhe);
      if (!estoqueIndisponivel) throw estoqueErr;

      await db.atualizarPedido(pedidoId, {
        status: 'estoque_indisponivel',
        mp_payment_id: String(paymentId),
        pago_em: new Date().toISOString(),
      }, pedidoAtual.status);
      console.error('Pagamento aprovado com problema de estoque:', estoqueErr.message);
      return { pagamento, pedidoId, status: 'estoque_indisponivel' };
    }
    if (statusAtual !== 'pago') void notificarPedido(pedidoId, 'pagamento_aprovado');
    return { pagamento, pedidoId, status: 'pago' };
  }

  if (podeReverterPagamento && pedidoAtual.mp_payment_id
    && String(pedidoAtual.mp_payment_id) !== String(paymentId)) {
    return { pagamento, pedidoId, status: statusAtual };
  }

  await db.atualizarPedido(pedidoId, {
    status: novoStatus,
    mp_payment_id: String(paymentId),
    pago_em: podeReverterPagamento ? (pedidoAtual.pago_em || null) : null,
  }, pedidoAtual.status);

  if (novoStatus !== statusAtual && ['cancelado', 'reembolsado'].includes(novoStatus)) {
    void notificarPedido(pedidoId, novoStatus);
  }

  return { pagamento, pedidoId, status: novoStatus };
}

module.exports = {
  receberWebhook,
  processarPagamentoMercadoPago,
  verifyMercadoPagoWebhookSignature,
};
