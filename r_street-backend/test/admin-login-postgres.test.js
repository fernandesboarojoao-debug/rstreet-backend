const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { adminLoginWait } = require('../src/middleware/adminLoginLimit');

test('persistent login policy survives a new connection and denies public roles', async () => {
  const dir = mkdtempSync(join(tmpdir(),'rs-auth-pg-'));
  let db = new PGlite(dir);
  const check = async (ok, key='a') => (await db.query('select public.rstreet_admin_login_wait($1,$2) as wait',[key.repeat(64),ok])).rows[0].wait;
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(readFileSync(join(__dirname,'../supabase/migrations/20261128122429_admin_login_limit.sql'),'utf8'));
    for (const role of ['anon','authenticated']) {
      await db.exec('set role '+role);
      await assert.rejects(check(false),/permission denied/);
      await assert.rejects(db.query('select * from rstreet_security.admin_login_limit'),/permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    for (const ok of [false,false,true,false,false]) assert.equal(await check(ok),0);
    assert.equal(await check(false),900);
    await db.close();
    db=new PGlite(dir);
    await db.exec('set role service_role');
    assert.ok((await check(true)) >= 890);
    assert.equal(await check(true,'b'),0);
    await db.exec("update rstreet_security.admin_login_limit set expires_at=now()-interval '1 second'");
    assert.equal(await check(true),0);
  } finally { await db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('shared login store transmits no password or raw IP and fails closed on bad responses', async t => {
  t.mock.method(globalThis,'fetch');
  const names=['ADMIN_LOGIN_STORE','SUPABASE_URL','SUPABASE_KEY'];
  const before=names.map(k=>process.env[k]);
  Object.assign(process.env,{ADMIN_LOGIN_STORE:'supabase',SUPABASE_URL:'https://fixture.invalid',SUPABASE_KEY:'fixture-key'});
  t.after(()=>names.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];}));
  const check=()=>adminLoginWait('192.0.2.7','fixture-password',false);
  fetch.mock.mockImplementation(async(url,options)=>{
    assert.equal(url.hostname,'fixture.invalid');
    assert.equal(options.redirect,'error');
    assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),['p_correct','p_origin']);
    assert.match(JSON.parse(options.body).p_origin,/^[0-9a-f]{64}$/);
    return {ok:true,json:async()=>900};
  });
  assert.equal(await check(),900);
  for (const result of [{ok:false},{ok:true,json:async()=>null},{ok:true,json:async()=>-1}]) {
    fetch.mock.mockImplementation(async()=>result);
    await assert.rejects(check());
  }
});
