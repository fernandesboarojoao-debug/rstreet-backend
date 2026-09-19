const db = require('./db');
const mp = require('./mercadopago');
const { processarPagamentoMercadoPago } = require('../controllers/webhookController');

async function reconciliarReserva(pedido, now = Date.now()) {
  const limite = new Date(pedido.reserva_expira_em).getTime();
  if (!Number.isFinite(limite) || limite + 5 * 60 * 1000 > now) return 'aguardando';
  if (pedido.mp_preference_id) {
    const preferencia = await mp.buscarPreferencia(pedido.mp_preference_id);
    const expira = new Date(preferencia.expiration_date_to).getTime();
    if (preferencia.expires !== true || !Number.isFinite(expira) || expira + 5 * 60 * 1000 > now
      || String(preferencia.external_reference) !== String(pedido.id)) return 'aguardando';
  }
  const pagamentos = await mp.buscarPagamentosPedido(pedido.id);
  if (pagamentos.some(p => String(p.external_reference) !== String(pedido.id))) throw new Error('Referencia de pagamento divergente.');
  const aprovado = pagamentos.find(p => p.status === 'approved');
  if (aprovado) {
    await processarPagamentoMercadoPago(aprovado.id);
    return 'aprovado';
  }
  // An expired checkout does not cancel a Pix or a card still under review.
  // Unknown states fail closed, even when the preference has expired.
  if (pagamentos.some(p => !['rejected', 'cancelled'].includes(p.status))) return 'aguardando';
  return await db.liberarReservaPedido(pedido.id) ? 'liberada' : 'inalterada';
}

function iniciarReconciliacaoReservas() {
  if (process.env.STOCK_RESERVATIONS_ENABLED !== 'true') return;
  let running = false;
  let cursor = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const pedidos = await db.buscarReservasVencidas(cursor);
      for (const pedido of pedidos) {
        try { await reconciliarReserva(pedido); }
        catch (err) { console.error(`Reserva #${pedido.id} mantida:`, err.message); }
      }
      cursor = pedidos.length === 50 ? pedidos[pedidos.length - 1].id : 0;
    } catch (err) { console.error('Falha na verificacao de reservas:', err.message); }
    finally { running = false; }
  };
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
  void run();
}

module.exports = { reconciliarReserva, iniciarReconciliacaoReservas };
