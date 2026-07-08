// src/controllers/webhookController.js
const db = require('../services/db');
const mp = require('../services/mercadopago');

async function receberWebhook(req, res) {
  // Responde imediatamente para o MP não reenviar
  res.sendStatus(200);

  try {
    const body = JSON.parse(req.body.toString());
    console.log('🔔 Webhook recebido:', JSON.stringify(body));

    // MP envia diferentes tipos de notificação
    const tipo      = body.type || body.topic;
    const paymentId = body.data?.id || body.id;

    if (tipo !== 'payment' || !paymentId) return;

    // Busca os detalhes do pagamento no MP
    const pagamento = await mp.buscarPagamento(paymentId);
    console.log(`💳 Pagamento #${paymentId} status: ${pagamento.status}`);

    const pedidoId = pagamento.external_reference;
    if (!pedidoId) return;

    const statusMap = {
      approved:   'pago',
      pending:    'pendente',
      in_process: 'em_analise',
      rejected:   'recusado',
      cancelled:  'cancelado',
      refunded:   'reembolsado',
    };

    const novoStatus = statusMap[pagamento.status] || pagamento.status;

    // Atualiza o pedido no banco
    await db.atualizarPedido(pedidoId, {
      status:         novoStatus,
      mp_payment_id:  String(paymentId),
      pago_em:        pagamento.status === 'approved' ? new Date().toISOString() : null,
    });

    console.log(`✅ Pedido #${pedidoId} atualizado para: ${novoStatus}`);

    // Se aprovado, reduz estoque de cada produto
    if (pagamento.status === 'approved') {
      const pedido = await db.buscarPedido(pedidoId);
      if (pedido) {
        const itens = await buscarItensPedido(pedidoId);
        for (const item of itens) {
          await db.reduzirEstoque(item.produto_id, item.quantidade);
          console.log(`📦 Estoque reduzido: produto #${item.produto_id} -${item.quantidade}`);
        }
      }
    }

  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
}

async function buscarItensPedido(pedidoId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/itens_pedido?pedido_id=eq.${pedidoId}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

module.exports = { receberWebhook };
