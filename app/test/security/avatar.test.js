'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { openDatabase } = require('../../src/db');
const { ACCOUNT_MIGRATIONS } = require('../../src/db/schema');
const { createRepositories } = require('../../src/db/repositories');
const { createAuthService } = require('../../src/security/auth-service');
const { createAuthRouter } = require('../../src/routes/auth');
const primitives = require('../../src/security/primitives');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-avatar-'));
  const db = openDatabase({ storageRoot: root, migrations: ACCOUNT_MIGRATIONS });
  const repo = createRepositories(db);
  const key = crypto.randomBytes(32);
  const password = 'Avatar-test-password-2026!';
  const user = repo.createUser({ username: 'avatar-user', displayName: 'Avatar User', passwordHash: await primitives.hashPassword(password) });
  const service = createAuthService({ repo, allowedOrigins: ['https://test.local'], encryptionKey: key, keyId: 'test' });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); key.fill(0); });
  return { db, repo, service, user, password };
}

test('avatar is persisted in the account profile and requires the session CSRF token', async t => {
  const f = await fixture(t);
  const request = body => ({ body, headers: { origin: 'https://test.local' } });
  const login = await f.service.login(request({ username: f.user.username, password: f.password }));
  const me = f.service.me({ headers: { cookie: `__Host-dn_session=${login.token}` } });
  const write = request({ avatar: { type: 'image', value: PNG } });
  write.headers.cookie = `__Host-dn_session=${login.token}`;
  write.headers['x-csrf-token'] = me.csrfToken;
  const result = f.service.updateAvatar(write);
  assert.equal(result.success, true);
  assert.deepEqual(result.avatar, { type: 'image', value: PNG });
  assert.deepEqual(f.service.me({ headers: { cookie: `__Host-dn_session=${login.token}` } }).user.avatar, result.avatar);
  const missingCsrf = request({ avatar: { type: 'text', value: 'A' } });
  missingCsrf.headers.cookie = `__Host-dn_session=${login.token}`;
  assert.throws(() => f.service.updateAvatar(missingCsrf), { code: 'CSRF_REJECTED' });
});

test('avatar HTTP endpoint validates image payloads and supports restoring the default', async t => {
  const f = await fixture(t);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createAuthRouter({ authService: f.service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: 'https://test.local' };
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username: f.user.username, password: f.password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  let me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
  const csrf = (await me.json()).csrfToken;
  let response = await fetch(`${base}/api/user/avatar`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ avatar: { type: 'image', value: 'data:image/png;base64,not-an-image' } }) });
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/user/avatar`, { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ avatar: null }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).avatar.type, 'text');
});
