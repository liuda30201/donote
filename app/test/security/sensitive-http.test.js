'use strict';

// This file is intentionally runnable in isolation. Config is read at module load.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donote-sensitive-http-'));
process.env.AUTH_MODE = 'accounts';
process.env.STORAGE_ROOT = root;
process.env.AUTH_ORIGIN = 'http://127.0.0.1:3000';
process.env.AUTH_DEV_HTTP = '1';
process.env.SENSITIVE_KEYRING_FILE = path.join(root, '..', 'content-keyring.json');

const express = require('express');
const { openDatabase } = require('../../src/db');
const { SECURITY_MIGRATION } = require('../../src/db/schema');
const { createRepositories } = require('../../src/db/repositories');
const p = require('../../src/security/primitives');
const { createAuthService } = require('../../src/security/auth-service');
const { createSensitiveKeyring } = require('../../src/security/sensitive');
const { createSensitiveService } = require('../../src/security/sensitive-service');
const { createApp } = require('../../src/app');
const storage = require('../../src/storage');

test('accounts HTTP sensitive messages enforce locked output, grants and tenant isolation', async t => {
  const db = openDatabase({ storageRoot: root, migrations: [SECURITY_MIGRATION] });
  const repo = createRepositories(db);
  const authKey = crypto.randomBytes(32);
  const contentKey = crypto.randomBytes(32);
  const keyring = createSensitiveKeyring({ activeKeyId: 'content-test', keys: { 'content-test': contentKey } });
  let now = 1_800_000_000_000;
  const password = 'synthetic-http-password';
  const hash = await p.hashPassword(password);
  const userA = repo.createUser({ username: 'http-alice', displayName: 'Alice', passwordHash: hash, at: now });
  const userB = repo.createUser({ username: 'http-bob', displayName: 'Bob', passwordHash: hash, at: now });
  const authService = createAuthService({ repo, allowedOrigins: ['http://127.0.0.1:3000'], encryptionKey: authKey, keyId: 'http-test', now: () => now });
  const sensitiveService = createSensitiveService({
    authService,
    keyring,
    now: () => now,
    // Synthetic strong-auth boundary: real session/CSRF/authentication still run;
    // password/TOTP verification belongs to the separate auth acceptance suite.
    verifyStrong: async req => {
      const current = authService.authenticateRequest(req);
      if (req.body?.syntheticStrong !== true) throw Object.assign(new Error('strong auth required'), { status: 401, code: 'AUTH_FAILED' });
      return { context: current.context, session: current.session, user: current.user };
    }
  });

  const session = (user, label) => {
    const token = p.generateToken();
    const csrf = crypto.createHmac('sha256', token).update('donote-csrf-v1').digest('base64url');
    repo.createSession({ userId: user.id, token, csrfToken: csrf, deviceLabel: label, createdAt: now, idleExpiresAt: now + 3600000, expiresAt: now + 7200000, authStrength: 'totp' });
    return { cookie: `${authService.cookieName}=${token}`, csrf };
  };
  const a = session(userA, 'alice-http');
  const b = session(userB, 'bob-http');

  assert.equal(authService.authenticateRequest({ headers: { cookie: a.cookie } }).user.id, userA.id);
  const application = createApp({ authService, sensitiveService });
  await new Promise(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${application.server.address().port}`;
  t.after(async () => {
    await application.close();
    sensitiveService.close();
    keyring.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function request(route, { session: s, method = 'GET', body, grant, headers = {} } = {}) {
    const h = { Origin: 'http://127.0.0.1:3000', Cookie: s.cookie, ...headers };
    if (body !== undefined) { h['Content-Type'] = 'application/json'; h['X-CSRF-Token'] = s.csrf; }
    if (grant) h['X-Sensitive-Grant'] = grant;
    const response = await fetch(base + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { response, body: parsed };
  }
  async function grantFor(s, id, action) {
    const result = await request(`/api/messages/${id}/sensitive/reauth`, { session: s, method: 'POST', body: { action, syntheticStrong: true } });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(typeof result.body.token, 'string');
    return result.body.token;
  }

  const created = await request('/api/messages', { session: a, method: 'POST', body: { type: 'text', content: 'synthetic secret body', remark: 'synthetic secret remark', sensitive: true } });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  const id = created.body.message.id;
  assert.equal(created.body.message.sensitive, true);
  assert.equal(created.body.message.content, null);
  assert.equal(created.body.message.remark, '');
  assert.equal(JSON.stringify(created.body).includes('synthetic secret'), false);

  const list = await request('/api/messages', { session: a });
  assert.equal(list.response.status, 200);
  assert.equal(list.response.headers.get('cache-control'), 'no-store');
  assert.equal(list.body.messages.some(m => m.id === id && m.content === null && m.remark === ''), true);
  assert.equal(JSON.stringify(list.body).includes('synthetic secret'), false);

  const search = await request('/api/messages/search?q=synthetic', { session: a });
  assert.equal(search.response.status, 200);
  assert.equal(search.body.messages.some(m => m.id === id), false);
  assert.equal(JSON.stringify(search.body).includes('synthetic secret'), false);
  const favorite = await request(`/api/messages/${id}/favorite`, { session: a, method: 'POST', body: {} });
  assert.equal(favorite.response.status, 200);
  assert.equal(favorite.body.message.content, null);
  assert.equal(JSON.stringify(favorite.body).includes('synthetic secret'), false);

  // There is no HTTP export endpoint; an attempted export must not become a plaintext route.
  const exportAttempt = await request(`/api/messages/${id}/export`, { session: a });
  assert.equal(exportAttempt.response.status, 404);
  assert.equal(JSON.stringify(exportAttempt.body).includes('synthetic secret'), false);

  const wrongTenant = await request(`/api/messages/${id}/sensitive/reveal`, { session: b, method: 'POST', body: {} });
  assert.equal(wrongTenant.response.status, 404);
  assert.equal(wrongTenant.response.headers.get('cache-control'), 'no-store');

  const revealGrant = await grantFor(a, id, 'reveal');
  const reveal = await request(`/api/messages/${id}/sensitive/reveal`, { session: a, method: 'POST', body: {}, grant: revealGrant });
  assert.equal(reveal.response.status, 200, JSON.stringify(reveal.body));
  assert.deepEqual({ content: reveal.body.content, remark: reveal.body.remark }, { content: 'synthetic secret body', remark: 'synthetic secret remark' });
  assert.equal(reveal.response.headers.get('cache-control'), 'no-store');
  const revealReplay = await request(`/api/messages/${id}/sensitive/reveal`, { session: a, method: 'POST', body: {}, grant: revealGrant });
  assert.equal(revealReplay.response.status, 401);

  const copyGrant = await grantFor(a, id, 'copy');
  const copy = await request(`/api/messages/${id}/sensitive/copy`, { session: a, method: 'POST', body: {}, grant: copyGrant });
  assert.equal(copy.response.status, 200);
  assert.deepEqual(copy.body, { content: 'synthetic secret body' });
  const copyReplay = await request(`/api/messages/${id}/sensitive/copy`, { session: a, method: 'POST', body: {}, grant: copyGrant });
  assert.equal(copyReplay.response.status, 401);
  const revealGrantForCopy = await grantFor(a, id, 'reveal');
  const wrongAction = await request(`/api/messages/${id}/sensitive/copy`, { session: a, method: 'POST', body: {}, grant: revealGrantForCopy });
  assert.equal(wrongAction.response.status, 401);

  const remarkGrant = await grantFor(a, id, 'remark');
  const remarked = await request(`/api/messages/${id}/remark`, { session: a, method: 'PATCH', body: { remark: 'updated private remark' }, grant: remarkGrant });
  assert.equal(remarked.response.status, 200);
  assert.equal(remarked.body.message.remark, '');
  assert.equal(JSON.stringify(remarked.body).includes('updated private remark'), false);
  const remarkReplay = await request(`/api/messages/${id}/remark`, { session: a, method: 'PATCH', body: { remark: 'replay' }, grant: remarkGrant });
  assert.equal(remarkReplay.response.status, 401);

  const unmarkGrant = await grantFor(a, id, 'unmark');
  const unmarked = await request(`/api/messages/${id}/sensitive/state`, { session: a, method: 'POST', body: { sensitive: false }, grant: unmarkGrant });
  assert.equal(unmarked.response.status, 200, JSON.stringify(unmarked.body));
  assert.equal(unmarked.body.message.sensitive, false);
  assert.equal(unmarked.body.message.content, 'synthetic secret body');
  const unmarkReplay = await request(`/api/messages/${id}/sensitive/state`, { session: a, method: 'POST', body: { sensitive: false }, grant: unmarkGrant });
  assert.equal(unmarkReplay.response.status, 200); // idempotent after the first state transition

  const otherUserList = await request('/api/messages', { session: b });
  assert.equal(otherUserList.body.messages.some(m => m.id === id), false);
});
