const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('order email comparison is literal and case insensitive, never a SQL pattern', async () => {
  const calls = [];
  const context = { module: { exports: {} }, process: { env: { SUPABASE_URL: 'https://example.invalid' } },
    fetch: async url => {
      calls.push(url);
      return { ok: true, text: async () => JSON.stringify([{ id: 1, cliente_email: 'Buyer@Example.com' }]) };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/db.js'), 'utf8'), context);
  const lookup = context.module.exports.buscarPedidoPorIdEmail;
  for (const email of ['%', '*', '_', '', 'other@example.com', '%@example.com', '*@example.com']) {
    assert.equal(await lookup(1, email), null);
  }
  assert.equal((await lookup(1, ' buyer@example.com ')).id, 1);
  assert.ok(calls.every(url => !url.includes('ilike') && !url.includes('cliente_email=')));
});

test('webhook conditional status updates cannot overwrite a newer payment status', async () => {
  let called;
  const context={module:{exports:{}},process:{env:{}},fetch:async (url,opts)=>{
    called={url,opts};return {ok:true,text:async()=>'[]'};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/db.js'),'utf8'),context);
  await context.module.exports.atualizarPedido(1,{status:'cancelado'},'pendente');
  assert.ok(called.url.includes('&status=eq.pendente'));
});
