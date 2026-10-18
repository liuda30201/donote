'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../src/app');

test('injected app rejects legacy API, file and socket credentials', async t => {
  const denied = () => { const e = new Error('Authentication failed'); e.status = 401; e.code = 'AUTH_FAILED'; throw e; };
  const service = { authenticateRequest: denied, requireOrigin: denied, cookieName: '__Host-dn_session', cookieOptions: () => ({}) };
  const { app, server, io } = createApp({ authService: service });
  assert.equal(app.get('authService'), service);
  assert.equal(typeof app.get('sessionInvalidated'), 'function');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => io.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const old = await fetch(`${base}/api/auth`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({password:'old-password'}) });
  assert.equal(old.status, 410);
  for (const route of ['/api/messages', '/api/messages/not-real/file-stream']) {
    const response = await fetch(`${base}${route}?password=old-password&userId=someone`, { headers: {'x-access-password':'old-password', cookie:'wc_auth=b2xkLXBhc3N3b3Jk'} });
    assert.equal(response.status, 401, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
