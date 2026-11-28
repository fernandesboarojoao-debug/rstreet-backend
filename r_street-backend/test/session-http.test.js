const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('login, private reads and maintenance work together without external services', async t => {
  const isolated = { SENHA_ADMIN:crypto.randomUUID(), ADMIN_TOKEN_SECRET:crypto.randomUUID(), CHECKOUT_MAINTENANCE:'true', ADMIN_LOGIN_LIMIT_DB:':memory:' };
  const previous = Object.fromEntries(Object.keys(isolated).map(k => [k, process.env[k]]));
  Object.assign(process.env, isolated);
  let server;
  try {
    const app = require('../src/server');
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const post = (path, body) => fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body});
    const denied = await fetch(base+'/api/admin/operacao');
    assert.equal(denied.status,401);
    assert.equal(denied.headers.get('cache-control'),'no-store');
    const login = await post('/api/auth/login',JSON.stringify({senha:isolated.SENHA_ADMIN}));
    assert.equal(login.status,200);
    const {token} = await login.json();
    assert.equal((await fetch(base+'/api/admin/operacao',{headers:{Authorization:'Bearer '+token}})).status,200);
    const malformed = await post('/api/auth/login','not-json');
    assert.equal(malformed.status,400);
    assert.equal((await malformed.json()).erro,'Formato da solicitação inválido.');
    const wrongType = await post('/api/auth/login',JSON.stringify({senha:[isolated.SENHA_ADMIN]}));
    assert.equal(wrongType.status,401);
    const wrong = JSON.stringify({senha:'incorrect-test-input'});
    for (const status of [401, 401, 429]) assert.equal((await post('/api/auth/login',wrong)).status,status);
    const locked = await post('/api/auth/login',JSON.stringify({senha:isolated.SENHA_ADMIN}));
    assert.equal(locked.status,429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 899);
    assert.match(locked.headers.get('access-control-expose-headers'),/Retry-After/i);
    assert.equal((await locked.json()).token,undefined);
    const invalidOrder = await post('/api/pedidos/acompanhar','{}');
    assert.equal(invalidOrder.status,400);
    assert.equal(invalidOrder.headers.get('cache-control'),'no-store');
    const db = require('../src/services/db');
    const mp = require('../src/services/mercadopago');
    const order = { id:42,status:'pago',total:95,frete_valor:0,frete_tipo:'Retirada na Loja',metodo_pagamento:'pix',
      cliente_email:'teste@example.invalid',cliente_cpf:'example',checkout_token:'example',endereco_rua:'example' };
    t.mock.method(db,'buscarPedidoPorIdEmail',async()=>order);
    t.mock.method(db,'buscarItensPedido',async()=>[]);
    t.mock.method(db,'buscarAtualizacoesPedido',async()=>[]);
    t.mock.method(db,'buscarPedido',async()=>order);
    t.mock.method(mp,'buscarPagamento',async()=>({external_reference:'42',status:'pending'}));
    for (const body of [{id:[42],email:order.cliente_email},{id:true,email:order.cliente_email},{id:42,email:'incompleto'}]) {
      assert.equal((await post('/api/pedidos/acompanhar',JSON.stringify(body))).status,400);
    }
    assert.equal((await post('/api/pedidos/confirmacao',JSON.stringify({pedido_id:42,payment_id:['123']}))).status,400);
    const track = await post('/api/pedidos/acompanhar', JSON.stringify({id:42,email:order.cliente_email}));
    assert.equal(track.status,200);
    assert.deepEqual((await track.json()).pedido,{id:42,status:'pago',total:95});
    const receipt = await post('/api/pedidos/confirmacao', JSON.stringify({pedido_id:42,payment_id:'123'}));
    assert.equal(receipt.status,200);
    assert.equal(receipt.headers.get('cache-control'),'no-store');
    assert.deepEqual((await receipt.json()).pedido,{id:42,status:'pago',total:95,frete_valor:0,frete_tipo:'Retirada na Loja',metodo_pagamento:'pix'});
    assert.equal((await post('/api/pagamento/criar','{}')).status,503);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key,value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
