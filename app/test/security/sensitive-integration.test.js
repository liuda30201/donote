'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSensitiveService } = require('../../src/security/sensitive-service');
const { createSensitiveKeyring } = require('../../src/security/sensitive');
const { toPublicMessage } = require('../../src/message');

test('sensitive product authorization isolates actions, sessions, versions, expiry and replay', async () => {
  let clock = 100000;
  const current = { user: { id: 'user-1', security_version: 1 }, session: { id: 'session-1', expires_at: 300000, idle_expires_at: 300000 }, context: { userId: 'user-1', sessionId: 'session-1', securityVersion: 1 } };
  const keyring = createSensitiveKeyring({ activeKeyId: 'k1', keys: { k1: crypto.randomBytes(32) } });
  const authService = { authenticateRequest: () => current, requireCsrf(req) { if (req.headers['x-csrf-token'] !== 'ok') throw Object.assign(new Error('csrf'), { status: 403 }); } };
  let strongCalls = 0;
  const service = createSensitiveService({ authService, keyring, now: () => clock, verifyStrong: async req => { strongCalls++; if (req.body.password !== 'correct' || req.body.code !== '123456') throw Object.assign(new Error('auth'), { status: 401 }); return current; } });
  const request = (action = 'reveal') => ({ headers: { 'x-csrf-token': 'ok' }, body: { action, messageId: 'message-1', password: 'correct', code: '123456' } });
  for (const action of ['reveal', 'copy', 'unmark', 'remark']) {
    const req = request(action); const issued = await service.reauth(req);
    for (const other of ['reveal', 'copy', 'unmark', 'remark'].filter(value => value !== action)) assert.throws(() => service.consume(req, { token: issued.token, messageId: 'message-1', action: other }, () => true), /SENSITIVE_GRANT_REJECTED/);
    assert.throws(() => service.consume(req, { token: issued.token, messageId: 'message-2', action }, () => true), /SENSITIVE_GRANT_REJECTED/);
    assert.equal(service.consume(req, { token: issued.token, messageId: 'message-1', action }, () => true), true);
    assert.throws(() => service.consume(req, { token: issued.token, messageId: 'message-1', action }, () => true), /SENSITIVE_GRANT_REJECTED/);
  }
  const req = request(); const issued = await service.reauth(req);
  current.session.id = 'different';
  assert.throws(() => service.consume(req, { token: issued.token, messageId: 'message-1', action: 'reveal' }, () => true), /SENSITIVE_GRANT_REJECTED/);
  current.session.id = 'session-1'; current.user.security_version = 2;
  assert.throws(() => service.consume(req, { token: issued.token, messageId: 'message-1', action: 'reveal' }, () => true), /SENSITIVE_GRANT_REJECTED/);
  current.user.security_version = 1; clock = issued.expiresAt;
  assert.throws(() => service.consume(req, { token: issued.token, messageId: 'message-1', action: 'reveal' }, () => true), /SENSITIVE_GRANT_REJECTED/);
  assert.equal(strongCalls, 5);
  service.close(); keyring.close();
});

test('central serializer and authenticated decrypt keep plaintext and ciphertext out of locked products', () => {
  const keyring = createSensitiveKeyring({ activeKeyId: 'k1', keys: { k1: crypto.randomBytes(32) } });
  const record = { id: 'message-1', type: 'text', timestamp: 1, favorite: true, sensitive: true, content: null, remark: '', encryptedPayload: keyring.encrypt({ content: 'private body', remark: 'private remark' }, { userId: 'user-1', messageId: 'message-1' }) };
  const service = createSensitiveService({ keyring, authService: {}, verifyStrong: async () => {} });
  assert.deepEqual(service.decrypt(record, 'user-1'), { content: 'private body', remark: 'private remark' });
  assert.deepEqual(toPublicMessage({ ...record, stalePrivate: { value: 'private body' } }), { id: 'message-1', type: 'text', sensitive: true, content: null, remark: '', timestamp: 1, favorite: true });
  assert.throws(() => service.decrypt(record, 'user-2'), /SENSITIVE_AUTH_FAILED/);
  const corrupt = structuredClone(record); corrupt.encryptedPayload.remark.tag = 'AAAAAAAAAAAAAAAAAAAAAA==';
  assert.throws(() => service.decrypt(corrupt, 'user-1'), /SENSITIVE_AUTH_FAILED/);
  assert.throws(() => service.validateRecord({ ...record, remark: 'plaintext' }, 'user-1'), /SENSITIVE_DATA_INVALID/);
  service.close(); keyring.close();
});
