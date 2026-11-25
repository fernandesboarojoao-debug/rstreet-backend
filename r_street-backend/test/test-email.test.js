'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTestEmail, sendTestEmail } = require('../src/services/testEmail');
const id = '9d7c98f0-1f2a-4c33-9a40-33510c582b87';

test('email diagnostics reject recipient lists, header injection and invalid attempt IDs', () => {
  assert.deepEqual(validateTestEmail({ email: ' qa@example.invalid ', request_id: id }), { email: 'qa@example.invalid', requestId: id });
  for (const email of ['', 'invalid', 'a@b.invalid,c@d.invalid', 'a@b.invalid\r\nBcc:x@y.invalid', '<a@b.invalid>', ['a@b.invalid']]) assert.equal(validateTestEmail({ email, request_id: id }), null);
  assert.equal(validateTestEmail({ email: 'qa@example.invalid', request_id: 'bad' }), null);
});

test('test email is static, authenticated, idempotent and never announces a real order', async () => {
  const oldFetch = global.fetch; const key = process.env.RESEND_API_KEY; const from = process.env.EMAIL_FROM;
  const calls = [];
  try {
    delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
    global.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: 'fixture-test-id' }), { status: 200 }); };
    assert.equal((await sendTestEmail({ email: 'qa@example.invalid', requestId: id })).configured, false); assert.equal(calls.length, 0);
    process.env.RESEND_API_KEY = 'fixture-not-a-real-key'; process.env.EMAIL_FROM = 'R Street <teste@example.invalid>';
    assert.equal((await sendTestEmail({ email: 'qa@example.invalid', requestId: id })).accepted, true);
    const sent = calls[0]; assert.equal(sent.url, 'https://api.resend.com/emails'); assert.equal(sent.options.redirect, 'error');
    assert.equal(sent.options.headers.Authorization, 'Bearer fixture-not-a-real-key');
    assert.equal(sent.options.headers['Idempotency-Key'], `rstreet-diagnostico-${id}`);
    const body = JSON.parse(sent.options.body); assert.deepEqual(body.to, ['qa@example.invalid']); assert.match(body.text, /nao confirma uma compra/); assert.doesNotMatch(JSON.stringify(body), /cliente_cpf|pedido_id|estoque|fixture-not-a-real-key/);
    global.fetch = async () => new Response('private provider error', { status: 422 });
    assert.deepEqual(await sendTestEmail({ email: 'qa@example.invalid', requestId: id }), { configured: true, accepted: false });
    global.fetch = async () => { throw new Error('private-network-detail'); };
    assert.deepEqual(await sendTestEmail({ email: 'qa@example.invalid', requestId: id }), { configured: true, accepted: false });
  } finally {
    global.fetch = oldFetch;
    for (const [name, value] of [['RESEND_API_KEY', key], ['EMAIL_FROM', from]]) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('email diagnostic route stays behind the admin router guard and limits', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/pedidosAdmin.js'), 'utf8');
  assert.ok(route.indexOf('router.use(requireAdmin)') < route.indexOf("router.post('/operacao/teste-email'"));
  const server = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.match(server, /app\.post\('\/api\/admin\/operacao\/teste-email', requireAdmin, simpleRateLimit\(\{ windowMs: 15 \* 60 \* 1000, max: 3,/);
});
