const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createLoginLimit, WINDOW_MS } = require('../src/middleware/adminLoginLimit');

test('third wrong password locks only its origin for a fixed fifteen minutes across reopening', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-limit-test-'));
  const file = join(dir, 'limit.db');
  let now = 1000, db = createLoginLimit(file, () => now);
  t.after(() => { db.close(); rmSync(dir, { recursive:true, force:true }); });
  assert.equal(db.check('a', false), 0);
  assert.equal(db.check('a', false), 0);
  assert.equal(db.check('a', false), 900);
  db.close();
  db = createLoginLimit(file, () => now);
  now += 45000;
  assert.equal(db.check('a', true), 855);
  assert.equal(db.check('a', false), 855);
  assert.equal(db.check('b', true), 0);
  now += WINDOW_MS - 45000;
  assert.equal(db.check('a', true), 0);
});

test('successful login clears prior failures; only recent errors count', t => {
  let now = 100;
  const db = createLoginLimit(':memory:', () => now);
  t.after(() => db.close());
  for (const correct of [false, false, true, false]) assert.equal(db.check('a', correct), 0);
  now += WINDOW_MS / 2;
  assert.equal(db.check('a', false), 0);
  now += WINDOW_MS / 2;
  assert.equal(db.check('a', false), 0);
  assert.equal(db.check('a', false), 900);
});
