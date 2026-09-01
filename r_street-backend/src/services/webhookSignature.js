const crypto = require('crypto');

function parseSignatureHeader(value) {
  const entries = String(value || '')
    .split(',')
    .map(part => part.trim().split('='))
    .filter(([key, item]) => key && item);
  return {
    ts: entries.find(([key]) => key === 'ts')?.[1] || '',
    signatures: entries.filter(([key]) => key === 'v1').map(([, item]) => item),
  };
}

function verifyMercadoPagoWebhookSignature({ xSignature, xRequestId, dataId, secret }) {
  const cleanSecret = String(secret || '');
  const cleanRequestId = String(xRequestId || '').trim();
  const cleanDataId = String(dataId || '').trim().toLowerCase();
  const { ts, signatures } = parseSignatureHeader(xSignature);
  if (!cleanSecret || !cleanRequestId || !cleanDataId || !/^\d{8,16}$/.test(ts) || !signatures.length) {
    return false;
  }

  const manifest = `id:${cleanDataId};request-id:${cleanRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', cleanSecret).update(manifest).digest('hex');
  return signatures.some(signature => (
    /^[a-f0-9]{64}$/i.test(signature)
    && crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
  ));
}

module.exports = { verifyMercadoPagoWebhookSignature };
