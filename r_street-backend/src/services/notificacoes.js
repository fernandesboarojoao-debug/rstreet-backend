const db = require('./db');

const FRONTEND_URL = String(process.env.FRONTEND_URL || 'https://www.rstreet.com.br').replace(/\/$/, '');

const EVENTS = {
  pagamento_aprovado: {
    subject: pedido => `Pagamento aprovado - pedido #${pedido.id}`,
    title: 'Pagamento aprovado',
    message: 'Recebemos seu pagamento e seu pedido já está confirmado.',
  },
  em_preparacao: {
    subject: pedido => `Pedido #${pedido.id} em preparação`,
    title: 'Seu pedido está em preparação',
    message: 'A equipe da R Street já está separando suas peças com cuidado.',
  },
  enviado: {
    subject: pedido => `Pedido #${pedido.id} enviado`,
    title: 'Seu pedido foi enviado',
    message: 'Seu pedido saiu para entrega. Use o código ou o link abaixo para acompanhar.',
  },
  retirada_disponivel: {
    subject: pedido => `Pedido #${pedido.id} disponível para retirada`,
    title: 'Seu pedido está pronto para retirada',
    message: 'Seu pedido já pode ser retirado na loja. Leve um documento de identificação.',
  },
  entregue: {
    subject: pedido => `Pedido #${pedido.id} entregue`,
    title: 'Pedido entregue',
    message: 'Seu pedido foi entregue. Obrigado por comprar com a R Street.',
  },
  retirado: {
    subject: pedido => `Pedido #${pedido.id} retirado`,
    title: 'Pedido retirado',
    message: 'A retirada foi concluída. Obrigado por comprar com a R Street.',
  },
  cancelado: {
    subject: pedido => `Atualização do pedido #${pedido.id}`,
    title: 'Pedido cancelado',
    message: 'Seu pedido foi cancelado. Em caso de dúvida, fale com a nossa equipe.',
  },
  reembolsado: {
    subject: pedido => `Reembolso do pedido #${pedido.id}`,
    title: 'Reembolso confirmado',
    message: 'O reembolso do seu pedido foi registrado. O prazo de crédito depende do meio de pagamento.',
  },
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function renderEmail(pedido, event, itens) {
  const total = Number(pedido.total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const rows = (itens || []).map(item => {
    const variant = [item.cor, item.tamanho].filter(Boolean).join(' / ');
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #e8e8e8"><strong>${escapeHtml(item.nome_produto)}</strong>${variant ? `<br><span style="color:#666">${escapeHtml(variant)}</span>` : ''}</td><td style="padding:10px 0;border-bottom:1px solid #e8e8e8;text-align:right">${Number(item.quantidade) || 1}x</td></tr>`;
  }).join('');
  const tracking = pedido.codigo_rastreio
    ? `<p style="margin:18px 0 0"><strong>Código de rastreio:</strong> ${escapeHtml(pedido.codigo_rastreio)}</p>`
    : '';
  const trackingLink = pedido.rastreio_url
    ? `<p style="margin:12px 0"><a href="${escapeHtml(pedido.rastreio_url)}" style="color:#8a681e;font-weight:700">Acompanhar entrega</a></p>`
    : '';
  const orderLink = `${FRONTEND_URL}/acompanhar.html`;

  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f4;font-family:Arial,sans-serif;color:#171717"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(event.message)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:28px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:auto;background:#fff;border:1px solid #dedede"><tr><td style="padding:28px;background:#0b0b0b;color:#fff"><div style="font-size:25px;font-weight:800;letter-spacing:3px">R.STREET</div></td></tr><tr><td style="padding:30px"><p style="margin:0 0 8px;color:#96722d;font-weight:700;text-transform:uppercase;letter-spacing:1px">Pedido #${pedido.id}</p><h1 style="margin:0 0 14px;font-size:25px">${escapeHtml(event.title)}</h1><p style="margin:0 0 22px;line-height:1.6">Olá, ${escapeHtml(pedido.cliente_nome || 'cliente')}. ${escapeHtml(event.message)}</p>${rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px">${rows}</table>` : ''}<p style="font-size:18px"><strong>Total: ${escapeHtml(total)}</strong></p>${tracking}${trackingLink}<p style="margin:24px 0 0"><a href="${orderLink}" style="display:inline-block;background:#c8a96e;color:#111;padding:13px 18px;text-decoration:none;font-weight:700">Acompanhar pedido</a></p></td></tr><tr><td style="padding:20px 30px;background:#f7f7f7;color:#666;font-size:12px;line-height:1.5">R Street Moda Masculina. Esta mensagem foi enviada por causa de uma atualização no seu pedido.</td></tr></table></td></tr></table></body></html>`;
}

async function notificarPedido(pedidoId, eventKey) {
  const event = EVENTS[eventKey];
  if (!event || !isConfigured()) return { skipped: true };

  try {
    const [pedido, itens] = await Promise.all([
      db.buscarPedido(pedidoId),
      db.buscarItensPedido(pedidoId),
    ]);
    if (!pedido?.cliente_email) return { skipped: true };

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `rstreet-pedido-${pedido.id}-${eventKey}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [pedido.cliente_email],
        ...(process.env.STORE_REPLY_TO ? { reply_to: process.env.STORE_REPLY_TO } : {}),
        subject: event.subject(pedido),
        html: renderEmail(pedido, event, itens),
      }),
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Resend ${response.status}: ${responseText.slice(0, 300)}`);
    return { sent: true };
  } catch (error) {
    console.error(`Falha ao enviar aviso do pedido #${pedidoId}:`, error.message);
    return { sent: false, error: true };
  }
}

module.exports = { EVENTS, escapeHtml, isConfigured, notificarPedido, renderEmail };
