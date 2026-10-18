'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../../src/app');
const { createAuthRouter } = require('../../src/routes/auth');

test('aborted auth request remains tracked until service promise settles', async t => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const service = {
    login: async () => {
      started();
      await new Promise(resolve => { release = resolve; });
      return { requiresSecondFactor: true, challenge: 'challenge' };
    },
    cookieName: '__Host-test',
    cookieOptions: () => ({})
  };
  const { app, server, io, lifecycle } = createApp({ authService: service });
  app.set('securityRouter', null);
  // Mount the session router explicitly for this isolated lifecycle test.
  app.use('/test', createAuthRouter({ authService: service }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release?.();
    await new Promise(resolve => io.close(resolve));
    await new Promise(resolve => server.close(() => resolve()));
  });

  const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/test/auth/login', method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ username: 'user', password: 'password' }));
  await startedPromise;
  request.destroy();

  lifecycle.stop();
  let drained = false;
  const draining = lifecycle.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await draining;
  assert.equal(drained, true);
});
