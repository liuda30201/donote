'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ACTIONS, EMAIL_REAUTH_ACTIONS, createOperationsService } = require('../../src/security/operations');
const { createAuthService } = require('../../src/security/auth-service');
const { createEmailVerification } = require('../../src/security/email-verification');
const { createAdminService } = require('../../src/security/admin');
const p = require('../../src/security/primitives');
const { createSensitiveService } = require('../../src/security/sensitive-service');

const origin = 'https://test.local';
const key = crypto.randomBytes(32);
const at = 1800000000000;
const request = body => ({ body, headers: { origin }, ip: '127.0.0.1' });
const authConfig = repo => ({ repo, allowedOrigins: [origin], encryptionKey: key, keyId: 'test', now: () => at });
const corrupt = ['{', 'null', '[]', '42', '"text"'];

test('corrupt setup and TOTP login challenge payloads fail closed', () => {
  for (const value of corrupt) {
    const token = p.generateToken();
    const user = { id: 'user', security_version: 1 };
    const secret = p.generateTotpSecret();
    const row = { user_id: user.id, target_id: value, kind: 'enroll', session_id: null, action: null };
    const repo = {
      email: { find: () => null },
      findLoginChallenge: () => row,
      findUserById: () => user,
      getTotpCredential: () => ({ enabled_at: at, encrypted_secret: JSON.stringify(p.encryptSecret(secret, key, { userId: user.id, purpose: 'totp-secret', keyId: 'test' })) }),
      withLoginChallenge: (scope, fn) => ({ result: fn() }),
      recordChallengeFailure() {}, addAudit() {},
      withTotpCounter() { assert.fail('corrupt payload must not consume counter'); }
    };
    const auth = createAuthService(authConfig(repo));
    assert.throws(() => auth.startSetup(request({ challenge: token })), { code: 'AUTH_FAILED', status: 401 });
    row.kind = 'login';
    assert.throws(() => auth.completeLogin(request({ challenge: token, code: p.generateTotp(secret, { now: at }) })), { code: 'AUTH_FAILED', status: 401 });
  }
});

test('corrupt email login and binding targets produce AUTH_FAILED, not raw parser errors', () => {
  for (const value of [...corrupt, '{}', '{"email":null}', '{"email":"not-an-email"}']) {
    const user = { id: 'user', security_version: 1, role: 'user' };
    const current = { user, session: { id: 'session' } };
    const row = { user_id: user.id, session_id: 'session', purpose: 'bind', target: value };
    const token = p.generateToken();
    const code = '123456';
    row.code_hash = crypto.createHmac('sha256', key).update(`email-code:${token}:${code}`).digest('hex');
    const repo = { email: { find: () => row, consume: (token, now, fn) => ({ result: fn(row) }) } };
    const email = createEmailVerification({ repo, authService: { authenticateRequest: () => current, requireCsrf() {} }, encryptionKey: key, now: () => at });
    assert.throws(() => email.confirmBind(request({ challenge: token, code })), { code: 'AUTH_FAILED', status: 401 });
    if (!corrupt.includes(value)) continue;
    const auth = createAuthService(authConfig({ ...repo, findUserById: () => user, email: { ...repo.email, preference: () => ({ method: 'email' }) } }));
    auth.setEmailVerification({ consume: (token, code, scope, fn) => fn(row) });
    assert.throws(() => auth.completeLogin(request({ challenge: token, code })), { code: 'AUTH_FAILED', status: 401 });
  }
});

test('TOTP-only reauthentication rejects dead sessions and disabled/deleted users before counter consumption', () => {
  for (const state of ['dead', 'disabled', 'deleted']) {
    const user = { id: 'user', security_version: 1, password_hash: 'hash' };
    const secret = p.generateTotpSecret();
    let reads = 0;
    const repo = {
      findUserById: () => { reads++; return reads === 1 ? user : { ...user, ...(state === 'disabled' ? { disabled_at: at } : state === 'deleted' ? { deleted_at: at } : {}) }; },
      getTotpCredential: () => ({ enabled_at: at, encrypted_secret: JSON.stringify(p.encryptSecret(secret, key, { userId: user.id, purpose: 'totp-secret', keyId: 'test' })) }),
      activeSession: () => state === 'dead' ? null : {},
      withTotpCounter() { assert.fail('invalid actor must not consume counter'); }
    };
    const service = createOperationsService({ repo, encryptionKey: key, keyId: 'test', now: () => at, authService: { authenticateRequest: () => ({ user, session: { id: 's' } }), requireCsrf() {}, verificationMethod: () => 'totp' } });
    assert.throws(() => service.reauth(request({ action: 'history.read-details', code: p.generateTotp(secret, { now: at }) })), { code: 'AUTH_FAILED', status: 401 });
  }
});

test('admin invalid TOTP writes a credential-free failure audit', async () => {
  const password = 'synthetic-admin-password';
  const user = { id: 'admin', role: 'admin', security_version: 1, password_hash: await p.hashPassword(password) };
  const session = { id: 'session', auth_strength: 'totp' };
  const secret = p.generateTotpSecret();
  const factor = { enabled_at: at, encrypted_secret: JSON.stringify(p.encryptSecret(secret, key, { userId: user.id, purpose: 'totp-secret', keyId: 'test' })) };
  const audits = [];
  const repo = { findUserById: () => user, findUserByUsername: () => null, activeSession: () => session, getTotpCredential: () => factor, addAudit: row => audits.push(row) };
  const service = createAdminService({ repo, encryptionKey: key, keyId: 'test', now: () => at, authService: { authenticateRequest: () => ({ user, session }), requireOrigin() {}, requireCsrf() {} } });
  await assert.rejects(service.reauth(request({ action: 'admin.user.create', values: { username: 'new-user', displayName: 'New', password: 'synthetic-user-password' }, password, code: 'invalid' })), { code: 'AUTH_FAILED' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'login.factor_failed');
  assert.equal(audits[0].actorSessionId, session.id);
  assert.equal(JSON.stringify(audits).includes(password), false);
  assert.equal(JSON.stringify(audits).includes('invalid'), false);
});

test('email reauthentication actions share the operations allowlist', () => {
  for (const action of ACTIONS) assert.equal(EMAIL_REAUTH_ACTIONS.has(action), true);
  assert.equal(EMAIL_REAUTH_ACTIONS.has('verification.change'), true);
  assert.equal(EMAIL_REAUTH_ACTIONS.has('sensitive'), true);
});

test('sensitive issue does not mutate the caller request body', async () => {
  const original = { password: 'synthetic-password', unrelated: 'preserved' };
  let observed;
  const auth = {
    authenticateRequest(req) { observed = req.body; return { user: { id: 'u', security_version: 1 }, session: { id: 's', expires_at: 2000, idle_expires_at: 2000 } }; },
    requireCsrf() {}
  };
  const service = createSensitiveService({
    authService: auth,
    verifyStrong: async () => ({ context: { userId: 'u', sessionId: 's', securityVersion: 1 }, session: { expires_at: 2000, idle_expires_at: 2000 } }),
    keyring: { decrypt() {} },
    now: () => 1000
  });
  const req = { body: original };
  await service.issue(req, 'reveal', 'message');
  assert.strictEqual(req.body, original);
  assert.deepEqual(original, { password: 'synthetic-password', unrelated: 'preserved' });
  assert.deepEqual(observed, { ...original, action: 'reveal', messageId: 'message' });
});

test('sensitive issue preserves request headers and socket through scoped request', async () => {
  let seen;
  const auth = {
    authenticateRequest(req) { seen = req; return { user: { id: 'u', security_version: 1 }, session: { id: 's', expires_at: 2000, idle_expires_at: 2000 } }; },
    requireCsrf() {}
  };
  const service = createSensitiveService({ authService: auth, verifyStrong: async () => ({ context: { userId: 'u', sessionId: 's', securityVersion: 1 }, session: { expires_at: 2000, idle_expires_at: 2000 } }), keyring: {}, now: () => 1000 });
  const req = { body: {}, headers: { origin: 'https://test' }, socket: { remoteAddress: '127.0.0.1' } };
  await service.issue(req, 'copy', 'message');
  assert.equal(seen.headers, req.headers);
  assert.equal(seen.socket, req.socket);
});
