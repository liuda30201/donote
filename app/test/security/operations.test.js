'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto'); const express = require('express');
const { openDatabase } = require('../../src/db'); const { SECURITY_MIGRATION } = require('../../src/db/schema'); const { createRepositories } = require('../../src/db/repositories');
const p = require('../../src/security/primitives'); const { createAuthService } = require('../../src/security/auth-service'); const { createSecurityRouter } = require('../../src/routes/security'); const { createOperationsService } = require('../../src/security/operations');

test('operation grants bind user, session, action and frozen targets; rollback preserves grant', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-operations-')); const db = openDatabase({ storageRoot: root, migrations: [SECURITY_MIGRATION] });
  const repo = createRepositories(db); let at = 1800000000000; const key = crypto.randomBytes(32); const password = 'synthetic-operation-password'; const hash = await p.hashPassword(password);
  const user = repo.createUser({ username: 'operation-user', displayName: 'User', passwordHash: hash }); const stranger = repo.createUser({ username: 'stranger', displayName: 'Other', passwordHash: hash });
  const authService = createAuthService({ repo, encryptionKey: key, keyId: 'test', allowedOrigins: ['https://test.local'], now: () => at });
  const loginReq = id => ({ body: { username: id, password }, headers: { origin: 'https://test.local' }, ip: '127.0.0.1' });
  const a = await authService.login(loginReq(user.username)); const b = await authService.login(loginReq(user.username)); const other = await authService.login(loginReq(stranger.username));
  const cookie = result => `__Host-dn_session=${result.token}`;
  const csrf = result => authService.me({ headers: { cookie: cookie(result) } }).csrfToken;
  const app = express(); app.use(express.json()); app.use('/api', createSecurityRouter({ authService, repo, encryptionKey: key, keyId: 'test', now: () => at }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(route, body, grant, result = a, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, { method, headers: { Origin: 'https://test.local', Cookie: cookie(result), 'X-CSRF-Token': csrf(result), ...(grant ? { 'X-Operation-Grant': grant } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/auth/sessions')).body.valid.length, 2);
  assert.equal((await request('/auth/reauth', { action: 'session.revoke', targetSessionId: other.session.id, password })).status, 404);
  const grant = (await request('/auth/reauth', { action: 'session.revoke', targetSessionId: b.session.id, password })).body.grant;
  assert.equal((await request('/auth/sessions/revoke-all', {}, grant)).status, 401);
  assert.equal((await request(`/auth/sessions/${other.session.id}/revoke`, {}, grant)).status, 404);
  assert.equal((await request(`/auth/sessions/${b.session.id}/revoke`, {}, grant, other)).status, 401);
  assert.equal((await request(`/auth/sessions/${b.session.id}/revoke`, {}, grant)).status, 200);
  assert.equal((await request(`/auth/sessions/${b.session.id}/revoke`, {}, grant)).status, 401);
  const freeze = (await request('/auth/reauth', { action: 'session.revoke-others', password })).body.grant;
  const later = await authService.login(loginReq(user.username));
  assert.equal((await request('/auth/sessions/revoke-others', {}, freeze)).status, 200);
  assert.notEqual(repo.findSessionByToken(later.token, at), null);
  const expiring = (await request('/auth/reauth', { action: 'session.revoke-all', password })).body.grant; at += 120001;
  assert.equal((await request('/auth/sessions/revoke-all', {}, expiring)).status, 401);
  const history = await request('/auth/history'); assert.equal(history.status, 200);
  for (const row of history.body) { assert.equal(row.ip_address, undefined); assert.equal(row.detail, undefined); }
  const detailGrant = (await request('/auth/reauth', { action: 'history.read-details', password })).body.grant;
  assert.equal((await request('/auth/history/details', undefined, detailGrant)).status, 200);
  assert.equal((await request('/auth/history/details', undefined, detailGrant)).status, 401);
  at += 60001;
  for (let i = 0; i < 10; i += 1) assert.equal((await request('/auth/reauth', { action: 'history.read-details', password: 'wrong-password' })).status, 401);
  assert.equal((await request('/auth/reauth', { action: 'session.revoke-all', password })).status, 429);
  at += 60001;
  for (let i = 0; i < 10; i += 1) assert.equal((await request('/auth/password', { currentPassword: password, newPassword: 'synthetic-new-password' }, 'invalid-grant')).status, 401);
  assert.equal((await request('/auth/totp/confirm', { challenge: 'invalid', code: '000000' })).status, 429);
  assert.equal((await request('/auth/reauth', { action: 'session.revoke-all', password })).status, 429);
  at += 60001;
  for (let i = 0; i < 10; i += 1) assert.equal((await request('/auth/totp/confirm', { challenge: 'invalid', code: '000000' })).status, 401);
  assert.equal((await request('/auth/password', { currentPassword: password }, 'invalid')).status, 429);
  at += 60001;
  const all = (await request('/auth/reauth', { action: 'session.revoke-all', password })).body.grant;
  assert.equal((await request('/auth/sessions/revoke-all', {}, all)).status, 200);
  assert.equal(repo.findSessionByToken(a.token, at), null); assert.equal(repo.findSessionByToken(later.token, at), null);
});
