'use strict';
const { createSensitiveUnlockGrants } = require('./sensitive');

const ACTIONS = new Set(['reveal', 'copy', 'unmark', 'remark']);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
function createSensitiveService({ authService, verifyStrong, keyring, now = Date.now, grantMaxMs = 120000 }) {
  if (!authService || typeof verifyStrong !== 'function' || !Number.isInteger(grantMaxMs) || grantMaxMs < 1000 || grantMaxMs > 120000) throw new TypeError('Explicit sensitive service dependencies required');
  // Separate stores bind each product action without broadening E01's reveal-only primitive.
  const stores = new Map([...ACTIONS].map(action => [action, createSensitiveUnlockGrants({ now })]));
  const grantScope = scope => ({ ...scope, action: 'reveal' });
  function requireKeyring() { if (!keyring) throw fail(503, 'SENSITIVE_KEY_UNAVAILABLE'); }
  function authenticate(req, write = true) {
    const current = authService.authenticateRequest(req);
    if (write) authService.requireCsrf(req, current);
    return current;
  }
  function scopeFor(current, messageId, action) {
    if (!ACTIONS.has(action) || typeof messageId !== 'string' || !messageId || messageId.length > 128) throw fail(400, 'INVALID_SENSITIVE_ACTION');
    return { userId: current.user.id, sessionId: current.session.id, securityVersion: current.user.security_version, messageId, action };
  }
  async function reauth(req) {
    requireKeyring();
    const body = req.body || {};
    const initial = authenticate(req, true);
    const scope = scopeFor(initial, body.messageId, body.action);
    const verified = await verifyStrong(req);
    if (verified.context.userId !== scope.userId || verified.context.sessionId !== scope.sessionId || verified.context.securityVersion !== scope.securityVersion) throw fail(401, 'AUTH_FAILED');
    const expiry = Math.min(now() + grantMaxMs, verified.session.expires_at, verified.session.idle_expires_at);
    try { return stores.get(scope.action).issue(grantScope(scope), expiry); } catch { throw fail(401, 'AUTH_FAILED'); }
  }
  function consume(req, { token, messageId, action }, callback) {
    requireKeyring();
    const current = authenticate(req, true);
    const scope = scopeFor(current, messageId, action);
    if (!stores.get(action)?.consume(token, grantScope(scope))) throw fail(401, 'SENSITIVE_GRANT_REJECTED');
    return callback(current);
  }
  function current(req) { return authenticate(req, true); }
  function assertCurrent(req, expected) {
    const current = authenticate(req, true);
    if ((expected.userId && current.user.id !== expected.userId) || (expected.sessionId && current.session.id !== expected.sessionId) || (expected.securityVersion && current.user.security_version !== expected.securityVersion)) throw fail(401, 'AUTH_FAILED');
    return current;
  }
  function decrypt(record, userId) {
    requireKeyring();
    if (!record || record.sensitive !== true || record.type !== 'text' || !record.encryptedPayload) throw fail(401, 'SENSITIVE_AUTH_FAILED');
    try { return keyring.decrypt(record.encryptedPayload, { userId, messageId: record.id }); } catch { throw fail(401, 'SENSITIVE_AUTH_FAILED'); }
  }
  function validateRecord(record, userId) {
    if (!record || record.sensitive !== true) return true;
    if (!keyring || record.type !== 'text' || record.content !== null || record.remark !== '' || !record.encryptedPayload) throw fail(500, 'SENSITIVE_DATA_INVALID');
    decrypt(record, userId);
    return true;
  }
  function revokeMessage(userId, messageId) { for (const grants of stores.values()) grants.revokeMessage(userId, messageId); }
  function revokeSession(userId, sessionId) { for (const grants of stores.values()) grants.revokeSession(userId, sessionId); }
  function close() { for (const grants of stores.values()) grants.clear(); }
  function issue(req, action, messageId) {
    const scopedRequest = Object.create(req);
    Object.defineProperty(scopedRequest, 'body', { value: { ...(req.body || {}), action, messageId }, enumerable: true });
    return reauth(scopedRequest);
  }
  return Object.freeze({ keyring, reauth, issue, consume, current, assertCurrent, decrypt, validateRecord, revokeMessage, revokeSession, close, requireKeyring });
}
module.exports = { createSensitiveService, SENSITIVE_ACTIONS: ACTIONS };
