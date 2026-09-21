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
