const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

test('the installed Express proxy dependency cannot trust public IPv4 through a malformed mapped subnet', () => {
  const fromExpress = createRequire(require.resolve('express'));
  const proxyaddr = fromExpress('proxy-addr');
  const trust = proxyaddr.compile(['::ffff:10.0.0.0/8']);
  assert.equal(trust('203.0.113.10'), false);
  const correctTrust = proxyaddr.compile(['10.0.0.0/8']);
  assert.equal(correctTrust('10.1.2.3'), true);
  assert.equal(correctTrust('203.0.113.10'), false);
});
