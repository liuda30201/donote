'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLifecycle, trackHandler } = require('../src/lifecycle');
const { createShutdown } = require('../src/shutdown');
const { createApp } = require('../src/app');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('application close waits for handler continuation after client abort', async t => {
  const pending = gate(); const entered = gate(); const completed = gate();
  const instance = createApp();
  instance.app.get('/held-work', trackHandler(async () => {
    entered.resolve(); await pending.promise; completed.resolve();
  }));
  await new Promise(r => instance.server.listen(0, '127.0.0.1', r));
  t.after(async () => { pending.resolve(); await instance.close(); });
  const request = http.get(`http://127.0.0.1:${instance.server.address().port}/held-work`);
  request.on('error', () => {});
  await entered.promise;
  request.destroy();
  let closed = false;
  const closing = instance.close().then(() => { closed = true; });
  await new Promise(setImmediate);
  assert.equal(instance.lifecycle.stopping, true);
  assert.equal(closed, false);
  assert.strictEqual(instance.close(), instance.close());
  pending.resolve(); await completed.promise; await closing;
  assert.equal(closed, true);
});

test('shutdown rejects new requests and tracks rejected handler completion', async () => {
  const lifecycle = createLifecycle(); lifecycle.stop();
  const headers = {}; let body; let status;
  lifecycle.middleware({}, { set: (k,v) => { headers[k] = v; }, status: n => { status = n; return { json: b => { body = b; } }; } }, () => assert.fail('admitted'));
  assert.equal(status, 503); assert.equal(headers.Connection, 'close'); assert.equal(body.code, 'SERVER_STOPPING');
  await assert.rejects(lifecycle.track(() => { throw new Error('expected'); }), /expected/);
  await lifecycle.drain();
});

test('shutdown drains requests and cleanup before persistence and closes security last, once', async () => {
  const requests = gate(); const cleanup = gate(); const order = [];
  const shutdown = createShutdown({ closeApp: () => requests.promise, stopCleanup: () => cleanup.promise,
    flushPersist: async () => { order.push('flush'); }, closeSecurity: () => { order.push('db'); } });
  const closing = shutdown(); assert.strictEqual(closing, shutdown());
  requests.resolve(); await new Promise(setImmediate); assert.deepEqual(order, []);
  cleanup.resolve(); await closing; assert.deepEqual(order, ['flush', 'db']);
});

test('failed persistence and shutdown deadline never close security early', async () => {
  let closed = false;
  const failed = createShutdown({ closeApp: async () => {}, stopCleanup: async () => {}, flushPersist: async () => { throw new Error('disk full'); }, closeSecurity: () => { closed = true; } });
  await assert.rejects(failed(), /disk full/); assert.equal(closed, false);
  const blocked = gate(); let flushed = false;
  const timedOut = createShutdown({ closeApp: () => blocked.promise, stopCleanup: async () => {}, flushPersist: async () => { flushed = true; }, closeSecurity: () => { closed = true; }, timeoutMs: 10 });
  await assert.rejects(timedOut(), { code: 'SHUTDOWN_TIMEOUT' });
  blocked.resolve(); await new Promise(setImmediate);
  assert.equal(flushed, false); assert.equal(closed, false);
});
