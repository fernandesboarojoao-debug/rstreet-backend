const { DatabaseSync } = require('node:sqlite');
const { createHmac } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const WINDOW_MS = 15 * 60 * 1000;

function createLoginLimit(filename, now = Date.now) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS login_failures (
      source TEXT PRIMARY KEY, last_error INTEGER NOT NULL,
      previous_error INTEGER, expires INTEGER NOT NULL, locked INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_expiry ON login_failures(expires);
  `);
  const prune = db.prepare('DELETE FROM login_failures WHERE expires <= ?');
  const read = db.prepare('SELECT * FROM login_failures WHERE source = ?');
  const remove = db.prepare('DELETE FROM login_failures WHERE source = ?');
  const write = db.prepare('INSERT OR REPLACE INTO login_failures VALUES (?, ?, ?, ?, ?)');
  return {
    close: () => db.close(),
    check(source, correct) {
      const time = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        prune.run(time);
        const row = read.get(source);
        let seconds = 0;
        if (row?.locked) seconds = Math.ceil((row.expires - time) / 1000);
        else if (correct) remove.run(source);
        else {
          const lock = row?.previous_error != null && row.previous_error > time - WINDOW_MS;
          write.run(source, time, row?.last_error ?? null, time + WINDOW_MS, Number(lock));
          if (lock) seconds = WINDOW_MS / 1000;
        }
        db.exec('COMMIT');
        return seconds;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

let store;
async function adminLoginWait(ip, passwordSecret, correct) {
  const source = createHmac('sha256', passwordSecret).update('login-origin:' + ip).digest('hex');
  if (process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || process.env.ADMIN_LOGIN_STORE === 'supabase') {
    const url = new URL('/rest/v1/rpc/rstreet_admin_login_wait', process.env.SUPABASE_URL);
    const key = process.env.SUPABASE_KEY;
    if (!key || url.protocol !== 'https:') throw new Error('Login store unavailable');
    const res = await fetch(url, { method:'POST', redirect:'error', signal:AbortSignal.timeout(6000),
      headers:{ apikey:key, Authorization:'Bearer '+key, 'Content-Type':'application/json' },
      body:JSON.stringify({p_origin:source,p_correct:correct}) });
    if (!res.ok) throw new Error('Login store unavailable');
    const seconds = await res.json();
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 900) throw new Error('Invalid login decision');
    return seconds;
  }
  store ??= createLoginLimit(process.env.ADMIN_LOGIN_LIMIT_DB || join(tmpdir(), 'rstreet-admin', 'login.sqlite'));
  return store.check(source, correct);
}

module.exports = { createLoginLimit, adminLoginWait, WINDOW_MS };
