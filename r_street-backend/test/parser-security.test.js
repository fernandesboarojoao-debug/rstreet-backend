const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const fromExpress = createRequire(require.resolve('express'));

test('installed query serializer tolerates an untrusted non-callable toString in comma arrays', () => {
  const qs = fromExpress('qs');
  assert.doesNotThrow(() => qs.stringify({ a: [{ toString: 'x' }] }, { arrayFormat: 'comma' }));
});

test('compressed JSON with trailing bytes cannot terminate the API process', { timeout: 5000 }, async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/', (_req, res) => res.json({ ok: true }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use((_err, _req, res, _next) => res.status(400).json({ error: 'invalid body' }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = server.address().port;
  try {
    const body = Buffer.concat([zlib.gzipSync('{"ok":true}'), Buffer.from('trailing-invalid-bytes')]);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.ok([200, 400].includes(status));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
