const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/services/db');
const notifications = require('../src/services/notificacoes');
const { reservasAtivadas } = require('../src/services/reservas');

test('reservas ficam ativas por padrao e aceitam desligamento emergencial', () => {
  const original = process.env.STOCK_RESERVATIONS_DISABLED;
  delete process.env.STOCK_RESERVATIONS_DISABLED;
  assert.equal(reservasAtivadas(), true);
  process.env.STOCK_RESERVATIONS_DISABLED = 'true';
  assert.equal(reservasAtivadas(), false);
  if (original === undefined) delete process.env.STOCK_RESERVATIONS_DISABLED;
  else process.env.STOCK_RESERVATIONS_DISABLED = original;
});

test('notificacao fica inativa sem credenciais e nao consulta dados', async () => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  const originalSearch = db.buscarPedido;
  db.buscarPedido = async () => { throw new Error('nao deveria consultar'); };
  assert.deepEqual(await notifications.notificarPedido(1, 'pagamento_aprovado'), { skipped: true });
  db.buscarPedido = originalSearch;
  if (originalKey !== undefined) process.env.RESEND_API_KEY = originalKey;
  if (originalFrom !== undefined) process.env.EMAIL_FROM = originalFrom;
});

test('template de aviso escapa dados do cliente e do produto', () => {
  const html = notifications.renderEmail(
    { id: 8, cliente_nome: '<script>', total: 99.9 },
    notifications.EVENTS.pagamento_aprovado,
    [{ nome_produto: '<b>Produto</b>', quantidade: 1, cor: 'Preto', tamanho: 'M' }]
  );
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>Produto<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Pagamento aprovado/);
});

test('current notification never announces shipping for an unpaid or refunded order', () => {
  assert.equal(notifications.currentOrderEvent({ status: 'pendente', envio_status: 'enviado' }), null);
  assert.equal(notifications.currentOrderEvent({ status: 'pago', envio_status: 'enviado' }), 'enviado');
  assert.equal(notifications.currentOrderEvent({ status: 'pago', envio_status: 'aguardando_envio' }), 'pagamento_aprovado');
  assert.equal(notifications.currentOrderEvent({ status: 'reembolsado', envio_status: 'entregue' }), 'reembolsado');
  assert.equal(notifications.currentOrderEvent({ status: 'estornado' }), null);
  assert.equal(notifications.currentOrderEvent({ status: 'estoque_indisponivel' }), null);
});

test('email rejects executable tracking URLs and links directly to the order without personal data', () => {
  const html = notifications.renderEmail({ id: 9, rastreio_url: 'javascript:alert(1)', total: 10 }, notifications.EVENTS.enviado, []);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /acompanhar\.html\?pedido=9/);
});

test('notification retries a temporary error with the same payload and deduplicates concurrent requests', async () => {
  const saved = { fetch: global.fetch, order: db.buscarPedido, items: db.buscarItensPedido,
    key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
  const calls = [];
  try {
    process.env.RESEND_API_KEY = 'fixture-key'; process.env.EMAIL_FROM = 'fixture@example.test';
    db.buscarPedido = async () => ({ id: 717, status: 'pago', cliente_email: 'buyer@example.test', total: 10 });
    db.buscarItensPedido = async () => [];
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails');
      calls.push(options);
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 503, text: async () => '{}' };
    };
    const results = await Promise.all([notifications.notificarPedido(717, 'pagamento_aprovado'), notifications.notificarPedido(717, 'pagamento_aprovado')]);
    assert.ok(results.every(result => result.sent));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
    calls.length = 0;
    db.buscarPedido = async () => ({ id: 717, status: 'cancelado', cliente_email: 'buyer@example.test' });
    assert.deepEqual(await notifications.notificarPedido(717, 'pagamento_aprovado'), { skipped: true });
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = saved.fetch; db.buscarPedido = saved.order; db.buscarItensPedido = saved.items;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = saved.from;
  }
});

test('notification retry stops if the order status or recipient changed', async () => {
  const saved = { fetch: global.fetch, order: db.buscarPedido, items: db.buscarItensPedido, key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
  try {
    process.env.RESEND_API_KEY = 'fixture-key'; process.env.EMAIL_FROM = 'fixture@example.test';
    db.buscarItensPedido = async () => [];
    for (const change of [{ status: 'cancelado' }, { cliente_email: 'other@example.test' }]) {
      let reads = 0, sends = 0;
      db.buscarPedido = async () => ({ id: 718, status: 'pago', cliente_email: 'buyer@example.test', total: 10, ...(++reads > 1 ? change : {}) });
      global.fetch = async () => { sends++; return { ok: false, status: 503, text: async () => '{}' }; };
      assert.deepEqual(await notifications.notificarPedido(718, 'pagamento_aprovado'), { skipped: true });
      assert.equal(sends, 1);
      assert.equal(reads, 2);
    }
  } finally {
    global.fetch = saved.fetch; db.buscarPedido = saved.order; db.buscarItensPedido = saved.items;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.EMAIL_FROM; else process.env.EMAIL_FROM = saved.from;
  }
});
