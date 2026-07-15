const db = require('../services/db');
const mp = require('../services/mercadopago');

async function receberWebhook(req, res) {
  res.sendStatus(200);

  try {
    const body = JSON.parse(req.body.toString());
    const tipo = body.type || body.topic;
    const paymentId = body.data?.id || body.id;

    if (tipo !== 'payment' || !paymentId) return;

    const pagamento = await mp.buscarPagamento(paymentId);
    const pedidoId = pagamento.external_reference;
    if (!pedidoId) return;

    const pedidoAtual = await db.buscarPedido(pedidoId);
    if (!pedidoAtual) return;

    const statusMap = {
      approved: 'pago',
      pending: 'pendente',
      in_process: 'em_analise',
      rejected: 'recusado',
      cancelled: 'cancelado',
      refunded: 'reembolsado',
    };
    const novoStatus = statusMap[pagamento.status] || pagamento.status;

    if (pagamento.status === 'approved' && pedidoAtual.status !== 'pago') {
      try {
        const itens = await buscarItensPedido(pedidoId);
        for (const item of itens) {
          await db.reduzirEstoque(item.produto_id, item.quantidade, item.produto_variante_id || null);
        }
      } catch (estoqueErr) {
        await db.atualizarPedido(pedidoId, {
          status: 'estoque_indisponivel',
          mp_payment_id: String(paymentId),
          pago_em: new Date().toISOString(),
        });
        console.error('Pagamento aprovado com problema de estoque:', estoqueErr.message);
        return;
      }
    }

    await db.atualizarPedido(pedidoId, {
      status: novoStatus,
      mp_payment_id: String(paymentId),
      pago_em: pagamento.status === 'approved' ? (pedidoAtual.pago_em || new Date().toISOString()) : null,
    });
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
}

async function buscarItensPedido(pedidoId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Pedido invalido no webhook.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/itens_pedido?pedido_id=eq.${id}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao buscar itens do pedido: ${res.status} ${text}`);
  }
  return res.json();
}

module.exports = { receberWebhook };
