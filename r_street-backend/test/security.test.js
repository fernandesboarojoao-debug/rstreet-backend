const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyMercadoPagoWebhookSignature } = require('../src/services/webhookSignature');
const { createAdminToken, verifyAdminToken, isAdminAuthConfigured } = require('../src/middleware/adminAuth');

test('aceita somente assinatura valida do webhook do Mercado Pago', () => {
  const secret = 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
  const dataId = '123456789';
  const requestId = 'request-security-test';
  const ts = '1704908010';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const signature = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  assert.equal(verifyMercadoPagoWebhookSignature({
    xSignature: `ts=${ts},v1=${signature}`,
    xRequestId: requestId,
    dataId,
    secret,
  }), true);
  assert.equal(verifyMercadoPagoWebhookSignature({
    xSignature: `ts=${ts},v1=${signature}`,
    xRequestId: requestId,
    dataId: 'outro-pagamento',
    secret,
  }), false);
});

test('token administrativo usa segredo explicito ou derivado e detecta adulteracao', () => {
  const previousPassword = process.env.SENHA_ADMIN;
  const previousSecret = process.env.ADMIN_TOKEN_SECRET;
  const previousSupabaseKey = process.env.SUPABASE_KEY;
  try {
    process.env.SENHA_ADMIN = 'senha-forte-de-teste';
    process.env.ADMIN_TOKEN_SECRET = 'segredo-de-token-com-mais-de-trinta-e-dois-caracteres';
    assert.equal(isAdminAuthConfigured(), true);
    const session = createAdminToken();
    assert.equal(verifyAdminToken(session.token), true);
    assert.equal(verifyAdminToken(session.token.slice(0, -1) + (session.token.endsWith('a') ? 'b' : 'a')), false);
    const [payload, signature] = session.token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const missingNoncePayload = Buffer.from(JSON.stringify({ ...claims, nonce: '' })).toString('base64url');
    assert.equal(verifyAdminToken(`${missingNoncePayload}.${signature}`), false);

    process.env.ADMIN_TOKEN_SECRET = '';
    process.env.SUPABASE_KEY = 'chave-secreta-do-backend-para-derivacao';
    assert.equal(isAdminAuthConfigured(), true);
    const derivedSession = createAdminToken();
    assert.equal(verifyAdminToken(derivedSession.token), true);

    delete process.env.SUPABASE_KEY;
    assert.equal(isAdminAuthConfigured(), false);
  } finally {
    if (previousPassword === undefined) delete process.env.SENHA_ADMIN;
    else process.env.SENHA_ADMIN = previousPassword;
    if (previousSecret === undefined) delete process.env.ADMIN_TOKEN_SECRET;
    else process.env.ADMIN_TOKEN_SECRET = previousSecret;
    if (previousSupabaseKey === undefined) delete process.env.SUPABASE_KEY;
    else process.env.SUPABASE_KEY = previousSupabaseKey;
  }
});
