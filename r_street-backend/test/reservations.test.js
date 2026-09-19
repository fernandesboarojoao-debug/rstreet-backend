const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');

test('reservations allocate the last unit once, release once, and remain compatible with old orders', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE produtos(id bigint PRIMARY KEY, ativo boolean DEFAULT true, preco numeric DEFAULT 100, estoque integer CHECK(estoque>=0), atualizado_em timestamptz);
      CREATE TABLE produto_variantes(id bigint PRIMARY KEY, produto_id bigint REFERENCES produtos(id), ativo boolean DEFAULT true, preco numeric, estoque integer CHECK(estoque>=0), atualizado_em timestamptz);
      CREATE TABLE pedidos(id bigint PRIMARY KEY, status text DEFAULT 'pendente', mp_preference_id text, mp_payment_id text, pago_em timestamptz, atualizado_em timestamptz);
      CREATE TABLE itens_pedido(id bigint GENERATED ALWAYS AS IDENTITY, pedido_id bigint REFERENCES pedidos(id), produto_id bigint REFERENCES produtos(id) ON DELETE SET NULL,
        produto_variante_id bigint REFERENCES produto_variantes(id) ON DELETE SET NULL, quantidade integer, preco_unitario numeric);
      INSERT INTO produtos(id,estoque) VALUES(1,1),(2,3),(3,5);
      INSERT INTO produto_variantes(id,produto_id,estoque) VALUES(10,1,1),(20,2,3);
      INSERT INTO pedidos(id) SELECT generate_series(1,10);
      INSERT INTO itens_pedido(pedido_id,produto_id,produto_variante_id,quantidade,preco_unitario)
        VALUES(1,1,10,1,100),(2,1,10,1,100),(3,2,20,2,100),(4,3,NULL,2,100),
          (5,3,NULL,1,90),(6,2,20,1,100),(7,1,NULL,1,100),(8,2,20,99,100);
    `);
    await pg.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260917185850_checkout_reservations.sql'),'utf8'));
    const scalar = async sql => Object.values((await pg.query(sql)).rows[0])[0];
    const reserve = id => pg.query('SELECT reservar_estoque_pedido($1)',[id]);
    const pay = id => pg.query('SELECT finalizar_pedido_pago($1,$2)',[id,`payment-${id}`]);
    const race = await Promise.allSettled([reserve(1),reserve(2)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(await scalar('SELECT estoque FROM produto_variantes WHERE id=10'),0);
    await reserve(1);
    await assert.rejects(pg.exec('DELETE FROM produtos WHERE id=1'),/reserva ativa/);
    await assert.rejects(pg.exec('DELETE FROM produto_variantes WHERE id=10'),/reserva ativa/);
    await pg.exec('UPDATE produtos SET ativo=false WHERE id=1; UPDATE produto_variantes SET ativo=false WHERE id=10');
    await pay(1); await pay(1);
    assert.equal(await scalar('SELECT estoque FROM produto_variantes WHERE id=10'),0);
    assert.equal(await scalar('SELECT reserva_estado FROM pedidos WHERE id=1'),'consumida');
    assert.equal(await scalar('SELECT liberar_reserva_pedido(1)'),false);

    await reserve(3);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=2'),1);
    assert.equal(await scalar('SELECT liberar_reserva_pedido(3)'),false);
    await pg.exec("UPDATE pedidos SET reserva_expira_em=now()-interval '1 hour' WHERE id=3");
    assert.equal(await scalar('SELECT liberar_reserva_pedido(3)'),true);
    assert.equal(await scalar('SELECT liberar_reserva_pedido(3)'),false);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=2'),3);
    // A late genuine payment after release must acquire stock again, never oversell.
    await pay(3);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=2'),1);
    await pay(4); await pay(4);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=3'),3);
    await assert.rejects(reserve(5),/Preco mudou/);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=3'),3);
    await assert.rejects(reserve(7),/Produto indisponivel|variacao/);
    await assert.rejects(reserve(8),/Estoque insuficiente/);
    await pg.exec('INSERT INTO itens_pedido(pedido_id,produto_id,produto_variante_id,quantidade,preco_unitario) VALUES(9,3,NULL,1,100),(9,2,20,99,100)');
    await assert.rejects(reserve(9),/Estoque insuficiente/);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=3'),3);
    assert.equal(await scalar('SELECT reserva_estado FROM pedidos WHERE id=9'),null);
    await reserve(6);
    await pg.exec("UPDATE pedidos SET reserva_expira_em=now()-interval '1 hour' WHERE id=6; UPDATE produto_variantes SET ativo=false WHERE id=20");
    assert.equal(await scalar('SELECT liberar_reserva_pedido(6)'),true);
    assert.equal(await scalar('SELECT estoque FROM produtos WHERE id=2'),0);
    assert.equal(await scalar('SELECT estoque FROM produto_variantes WHERE id=20'),1);
    for (const signature of ['reservar_estoque_pedido(bigint)','liberar_reserva_pedido(bigint)','finalizar_pedido_pago(bigint,text)','alocar_estoque_pedido(bigint,boolean)']) {
      assert.equal((await pg.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed",[signature])).rows[0].allowed,false);
    }
  } finally { await pg.close(); }
});

test('reconciliation never releases unknown, pending, approved or unverified payments', async () => {
  const now = Date.now();
  const pedido = {id:1,mp_preference_id:'pref',reserva_expira_em:new Date(now-3600000).toISOString()};
  let attempts = [], released = 0, processed = 0;
  const mp = {
    buscarPreferencia:async()=>({expires:true,expiration_date_to:pedido.reserva_expira_em,external_reference:'1'}),
    buscarPagamentosPedido:async()=>attempts,
  };
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/services/reservas.js'),'utf8'),{
    module, require:name=>name==='./db'?{liberarReservaPedido:async()=>{released++;return true;}}:name==='./mercadopago'?mp:
      {processarPagamentoMercadoPago:async()=>{processed++;}},
    Date, console, process:{env:{}}, setInterval,
  });
  const run = () => module.exports.reconciliarReserva(pedido,now);
  for (const status of ['pending','in_process','authorized','in_mediation','refunded','charged_back','unknown']) {
    attempts = [{id:1,external_reference:'1',status}];
    assert.equal(await run(),'aguardando');
  }
  attempts = [{id:1,external_reference:'1',status:'approved'}];
  assert.equal(await run(),'aprovado'); assert.equal(processed,1); assert.equal(released,0);
  attempts = [{id:1,external_reference:'1',status:'rejected'},{id:2,external_reference:'1',status:'pending'}];
  assert.equal(await run(),'aguardando');
  attempts = [{id:1,external_reference:'1',status:'cancelled'}];
  assert.equal(await run(),'liberada');
  attempts=[]; assert.equal(await run(),'liberada');
  mp.buscarPreferencia=async()=>({expires:false});
  assert.equal(await run(),'aguardando');
  mp.buscarPreferencia=async()=>{throw new Error('API offline');};
  await assert.rejects(run(),/API offline/);
  assert.equal(released,2);
});
