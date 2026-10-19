'use strict';
const crypto = require('node:crypto');
const p = require('./primitives');
const { AuthError } = require('./auth-service');

const ADMIN_ACTIONS = new Set(['admin.user.create', 'admin.user.disable', 'admin.user.role', 'admin.user.reset-password']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Internal factory. Request passwords are held in memory only and must never be logged. */
function createAdminService({ authService, repo, encryptionKey, keyId, now = Date.now }) {
  if (!authService || !repo || !Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 || typeof keyId !== 'string' || !keyId) throw new TypeError('Explicit admin dependencies required');
  let workers = 0;
  const grants = new Map(); // Keys are hashes, values contain only non-secret operation digests.
  const attempts = new Map();
  const bindingKey = crypto.randomBytes(32);
  const fail = (status = 401, code = 'AUTH_FAILED') => new AuthError(status, code);
  function current(req, write = true) {
    const auth = authService.authenticateRequest(req);
    if (write || req.headers.origin) authService.requireOrigin(req);
    if (!write && req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'ORIGIN_REJECTED');
    if (write) authService.requireCsrf(req, auth);
    if (auth.user.role !== 'admin' || auth.session.auth_strength !== 'totp' || auth.session.is_ephemeral) throw fail(403, 'ADMIN_FACTOR_REQUIRED');
    return auth;
  }
  function limit(req, userId) {
    const at = now();
    for (const [key, row] of attempts) if (row.until <= at) attempts.delete(key);
    const keys = [[`user:${userId}`, 10], [`ip:${String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0,128)}`, 30], ['global', 100]];
    if (attempts.size >= 10000 || keys.some(([key, cap]) => (attempts.get(key)?.count || 0) >= cap)) throw fail(429, 'AUTH_RATE_LIMIT');
    for (const [key] of keys) { const old = attempts.get(key); attempts.set(key, { count: (old?.count || 0) + 1, until: old?.until || at + 60000 }); }
  }
  async function passwordWork(fn) {
    if (workers >= 1) throw fail(503, 'AUTH_BUSY');
    workers += 1;
    try { return await fn(); } finally { workers -= 1; }
  }
  function targetUser(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail(400, 'INVALID_USER');
    const user = repo.findUserById(id);
    if (!user || user.deleted_at != null) throw fail(404, 'USER_NOT_FOUND');
    return user;
  }
  function digest(value) { return crypto.createHmac('sha256', bindingKey).update(JSON.stringify(value), 'utf8').digest('hex'); }
  function plan(action, targetId, values) {
    if (!ADMIN_ACTIONS.has(action)) throw fail(400, 'INVALID_ACTION');
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail(400, 'INVALID_VALUES');
    let fixed;
    if (action === 'admin.user.create') {
      if (typeof values.username !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(values.username.trim().toLowerCase()) || typeof values.displayName !== 'string' || !values.displayName.trim() || values.displayName.length > 128 || !['user','admin'].includes(values.role || 'user')) throw fail(400, 'INVALID_VALUES');
      passwordPolicy(values.password);
      fixed = { username: values.username.trim().toLowerCase(), displayName: values.displayName.trim(), role: values.role || 'user', passwordDigest: digest(values.password) };
      return { action, userId: null, securityVersion: null, values: fixed };
    }
    const target = targetUser(targetId);
    if (action === 'admin.user.disable') { if (typeof values.disabled !== 'boolean') throw fail(400, 'INVALID_VALUES'); fixed = { disabled: values.disabled }; }
    if (action === 'admin.user.role') { if (!['user','admin'].includes(values.role)) throw fail(400, 'INVALID_VALUES'); fixed = { role: values.role }; }
    if (action === 'admin.user.reset-password') { try { p.validateNewPassword(values.password); } catch { throw fail(400, 'PASSWORD_POLICY'); } fixed = { passwordDigest: digest(values.password) }; }
    return { action, userId: target.id, securityVersion: target.security_version, values: fixed };
  }
  function passwordPolicy(value) {
    try { p.validateNewPassword(value); } catch { throw fail(400, 'PASSWORD_POLICY'); }
  }
  function freshActor(auth, expected) {
    const user = repo.findUserById(auth.user.id);
    const session = repo.activeSession(auth.session.id, auth.user.id, now());
    if (!user || !session || user.role !== 'admin' || user.security_version !== expected.security_version || user.password_hash !== expected.password_hash || user.must_change_password || session.auth_strength !== 'totp' || session.is_ephemeral) throw fail();
    return user;
  }
  function freshTarget(frozen) {
    if (frozen.userId !== null && targetUser(frozen.userId).security_version !== frozen.securityVersion) throw fail(409, 'TARGET_CHANGED');
    if (frozen.userId === null && repo.findUserByUsername(frozen.values.username)) throw fail(409, 'USER_CONFLICT');
  }
  function factorSnapshot(userId) { const factor = repo.getTotpCredential(userId); if (!factor || factor.enabled_at == null) throw fail(403, 'ADMIN_FACTOR_REQUIRED'); return factor; }
  function cleanGrants() { for (const [key, row] of grants) if (row.expiresAt <= now()) grants.delete(key); }
  async function reauth(req) {
    const auth = current(req); const body = req.body || {};
    limit(req, auth.user.id);
    const frozen = plan(body.action, body.targetUserId, body.values);
    freshTarget(frozen);
    const expected = repo.findUserById(auth.user.id); const factor = factorSnapshot(auth.user.id);
    if (!await passwordWork(() => p.verifyPassword(body.password, expected.password_hash))) throw fail();
    freshActor(auth, expected); freshTarget(frozen);
    const freshFactor = factorSnapshot(auth.user.id);
    if (freshFactor.encrypted_secret !== factor.encrypted_secret || freshFactor.enabled_at !== factor.enabled_at) throw fail();
    let counter = null;
    try { const secret = p.decryptSecret(JSON.parse(factor.encrypted_secret), encryptionKey, { userId: expected.id, purpose: 'totp-secret', keyId }); counter = p.verifyTotp(secret, body.code, { now: now() }); } catch { counter = null; }
    if (counter === null) {
      repo.addAudit({ actorId: expected.id, targetId: expected.id, actorSessionId: auth.session.id, action: 'login.factor_failed', ipAddress: String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128), authStrength: auth.session.auth_strength, at: now(), detail: { reason: 'admin.reauth' } });
      throw fail();
    }
    cleanGrants(); if (grants.size >= 10000) throw fail(503, 'AUTH_BUSY');
    const grant = p.generateToken(); const at = now(); const targetId = digest(frozen);
    const result = repo.withTotpCounter({ userId: expected.id, counter, at }, () => {
      freshActor(auth, expected); freshTarget(frozen);
      const created = repo.createOperationGrant({ userId: expected.id, sessionId: auth.session.id, grant, action: frozen.action, targetId, securityVersion: expected.security_version, createdAt: at, expiresAt: at + 120000 });
      if (!created) throw fail(); return created;
    });
    if (!result) throw fail();
    grants.set(p.hashToken(grant), { frozen, userId: expected.id, sessionId: auth.session.id, securityVersion: expected.security_version, expiresAt: at + 120000 });
    return { grant, action: frozen.action, expiresAt: at + 120000 };
  }
  function checkGrant(req, auth, action, frozen) {
    cleanGrants(); let key;
    try { key = p.hashToken(req.headers['x-operation-grant']); } catch { throw fail(); }
    const saved = grants.get(key);
    if (!saved || saved.userId !== auth.user.id || saved.sessionId !== auth.session.id || saved.securityVersion !== auth.user.security_version || saved.frozen.action !== action || digest(saved.frozen) !== digest(frozen)) throw fail(401, 'GRANT_REJECTED');
    freshTarget(saved.frozen);
    return { key, saved };
  }
  function users(req) {
    current(req, false);
    const limitValue = req.query?.limit == null ? 50 : Number(req.query.limit);
    const before = req.query?.before || null;
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100 || (before !== null && !UUID.test(before))) throw fail(400, 'INVALID_PAGE');
    return { users: repo.listUsers({ limit: limitValue, before }) };
  }
  async function mutate(req, action) {
    const auth = current(req); const values = { ...(req.body || {}) };
    const frozen = plan(action, action === 'admin.user.create' ? null : req.params?.id, values);
    const { key, saved } = checkGrant(req, auth, action, frozen);
    const expected = repo.findUserById(auth.user.id);
    let passwordHash;
    if (action === 'admin.user.create' || action === 'admin.user.reset-password') {
      limit(req, auth.user.id);
      passwordHash = await passwordWork(() => p.hashPassword(values.password));
    }
    freshActor(auth, expected); freshTarget(frozen); checkGrant(req, auth, action, frozen);
    const consumed = repo.withOperationGrant({ grant: req.headers['x-operation-grant'], userId: auth.user.id, sessionId: auth.session.id, action, targetId: digest(saved.frozen), securityVersion: saved.securityVersion, at: now() }, () => {
      freshActor(auth, expected); freshTarget(frozen);
      let user; let audit;
      if (action === 'admin.user.create') { user = repo.createUser({ username: frozen.values.username, displayName: frozen.values.displayName, role: frozen.values.role, passwordHash, mustChangePassword: true, at: now() }); audit = 'user.created'; }
      else if (action === 'admin.user.disable') { user = repo.setDisabled({ userId: frozen.userId, disabled: frozen.values.disabled, at: now() }); audit = frozen.values.disabled ? 'user.disabled' : 'user.enabled'; }
      else if (action === 'admin.user.role') { user = repo.setRole({ userId: frozen.userId, role: frozen.values.role, at: now() }); audit = 'user.role_changed'; }
      else { user = repo.changePassword({ userId: frozen.userId, passwordHash, mustChangePassword: true, at: now() }); audit = 'user.password_reset'; }
      if (!user) throw fail(404, 'USER_NOT_FOUND');
      repo.addAudit({ actorId: auth.user.id, targetId: user.id, actorSessionId: auth.session.id, action: audit, at: now() });
      return { success: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, disabledAt: user.disabled_at, mustChangePassword: Boolean(user.must_change_password) } };
    });
    if (!consumed) throw fail(); grants.delete(key); return consumed.result;
  }
  return { users, reauth, create: req => mutate(req, 'admin.user.create'), disable: req => mutate(req, 'admin.user.disable'), role: req => mutate(req, 'admin.user.role'), resetPassword: req => mutate(req, 'admin.user.reset-password') };
}
module.exports = { createAdminService, ADMIN_ACTIONS };
