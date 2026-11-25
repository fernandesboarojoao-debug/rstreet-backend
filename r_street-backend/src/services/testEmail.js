'use strict';

function validateTestEmail(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  if (email.length > 254 || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email) || /[\r\n\u0000-\u001f\u007f]/.test(email) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return null;
  return { email, requestId: requestId.toLowerCase() };
}

async function sendTestEmail({ email, requestId }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return { configured: false, accepted: false };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
        'Idempotency-Key': `rstreet-diagnostico-${requestId}` },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email],
        subject: 'R Street - teste de avisos da loja',
        text: 'R.STREET\n\nEste e um teste solicitado pelo administrador para conferir o envio dos avisos da loja.\n\nNenhum pedido foi criado ou alterado. Esta mensagem nao confirma uma compra ou um pagamento.\n\nR Street Moda Masculina',
      }),
    });
    if (!response.ok) { await response.arrayBuffer(); return { configured: true, accepted: false }; }
    const data = await response.json();
    if (typeof data.id !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(data.id)) return { configured: true, accepted: false };
    return { configured: true, accepted: true, id: data.id };
  } catch { return { configured: true, accepted: false }; }
}

module.exports = { validateTestEmail, sendTestEmail };
