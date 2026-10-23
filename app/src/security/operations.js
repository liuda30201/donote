'use strict';
const p = require('./primitives');
const { AuthError } = require('./auth-service');

const ACTIONS = new Set(['session.revoke', 'session.revoke-others', 'session.revoke-all', 'history.read-details', 'password.change', 'factor.replace', 'factor.disable']);
const EMAIL_REAUTH_ACTIONS = new Set([...ACTIONS, 'verification.change', 'sensitive', 'private']);
function createOperationsService({ authService, repo, encryptionKey, keyId, maxPasswordConcurrency = 1, now = Date.now }) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 || typeof keyId !== 'string' || !keyId) throw new TypeError('Explicit encryption key and keyId required');
  if (!authService || !repo || !Number.isInteger(maxPasswordConcurrency) || maxPasswordConcurrency < 1 || maxPasswordConcurrency > 3) throw new TypeError('Explicit operations dependencies required');
  let workers = 0;
  const snapshots = new Map();
  const attempts = new Map();
  const fail = () => new AuthError(401, 'AUTH_FAILED');
  function auth(req, write = true) { const current = authService.authenticateRequest(req); if (write) authService.requireCsrf(req, current); return current; }
  function ensureAction(action) { if (typeof action !== 'string' || !ACTIONS.has(action)) throw new AuthError(400, 'INVALID_ACTION'); }
  function target(current, targetId) {
    const sessions = repo.listSessions(current.user.id).filter(row => row.revoked_at == null && row.id !== current.session.id);
    if (targetId != null && (!sessions.some(row => row.id === targetId))) throw new AuthError(404, 'SESSION_NOT_FOUND');
    return targetId == null ? null : sessions.find(row => row.id === targetId);
  }
  function snapshot(current, action, targetId) {
    ensureAction(action);
    if (action === 'session.revoke') {
      const row = target(current, targetId); return { targetId: row.id, targetIds: [row.id], label: row.device_label || 'Browser' };
    }
    if (action === 'session.revoke-others') {
      const rows = repo.listSessions(current.user.id).filter(row => row.revoked_at == null && row.id !== current.session.id);
      return { targetId: null, targetIds: rows.map(row => row.id), count: rows.length };
    }
    if (action === 'session.revoke-all') {
      const rows = repo.listSessions(current.user.id).filter(row => row.revoked_at == null);
      return { targetId: null, targetIds: rows.map(row => row.id), count: rows.length };
    }
    return { targetId: null, targetIds: [], count: 0 };
  }
  function currentFactor(user) {
    const factor = repo.getTotpCredential(user.id); if (!factor?.enabled_at) return null;
    try { return { factor, secret: p.decryptSecret(JSON.parse(factor.encrypted_secret), encryptionKey, { userId: user.id, purpose: 'totp-secret', keyId }) }; } catch { throw fail(); }
  }
  function freshUser(current, expected) {
    const fresh = repo.findUserById(current.user.id);
    if (!fresh || fresh.disabled_at != null || fresh.deleted_at != null || fresh.security_version !== expected.security_version || fresh.password_hash !== expected.password_hash) throw fail();
    const live = repo.activeSession(current.session.id, current.user.id, now()); if (!live) throw fail();
    return fresh;
  }
  function dualAction(action) { return ['password.change', 'factor.replace', 'factor.disable'].includes(action); }
  function rateLimit(req, current) {
    const at = now();
    for (const [id, entry] of attempts) if (entry.expiresAt <= at) attempts.delete(id);
    const buckets = [[`user:${current.user.id}`, 10], [`ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`, 30], ['global', 300]];
    if (buckets.some(([id, cap]) => (attempts.get(id)?.count || 0) >= cap) || attempts.size >= 10000) throw new AuthError(429, 'AUTH_RATE_LIMIT');
    for (const [id] of buckets) { const previous = attempts.get(id); attempts.set(id, { count: (previous?.count || 0) + 1, expiresAt: previous?.expiresAt || at + 60000 }); }
  }
  async function verifyStrong(req) {
    const current = auth(req);
    rateLimit(req, current);
    const body = req.body || {};
    if (typeof body.password !== 'string' || !body.password) throw fail();
    const user = repo.findUserById(current.user.id);
    if (!user) throw fail();
    if (workers >= maxPasswordConcurrency) throw new AuthError(503, 'AUTH_BUSY');
    workers += 1;
    let valid = false;
    try { valid = await p.verifyPassword(body.password, user.password_hash); } finally { workers -= 1; }
    if (!valid) throw fail();
    const method=authService.verificationMethod?.(user) || 'totp';
    if(method==='email') {
      const fresh=freshUser(current,user);
      authService.emailVerification.consume(body.emailChallenge,body.code,{userId:user.id,purpose:'reauth',sessionId:current.session.id,target:{action:'sensitive'}},()=>true);
      return {...current,user:fresh};
    }
    const factor = repo.getTotpCredential(user.id);
    if (!factor?.enabled_at || typeof body.code !== 'string') throw fail();
    let counter = null;
    try {
      const currentFactorValue = currentFactor(user);
      counter = p.verifyTotp(currentFactorValue.secret, body.code, { now: now() });
    } catch { counter = null; }
    if (counter == null) throw fail();
    const fresh = freshUser(current, user);
    const consumed = repo.withTotpCounter({ userId: user.id, counter, at: now() }, () => ({ result: true }));
    if (!consumed) throw fail();
    return { ...current, user: fresh };
  }
  function reauth(req) {
    const current = auth(req); const body = req.body || {}; ensureAction(body.action);
    rateLimit(req, current);
    const user = repo.findUserById(current.user.id); const snapshotUser = { id: user.id, security_version: user.security_version, password_hash: user.password_hash, role: user.role, disabled_at: user.disabled_at, deleted_at: user.deleted_at };
    let verified = false;
    const method=authService.verificationMethod?.(user);
    if(method==='email') {
      if(typeof body.password!=='string')throw fail();
      if(workers>=maxPasswordConcurrency)throw new AuthError(503,'AUTH_BUSY');workers++;
      return p.verifyPassword(body.password,user.password_hash).finally(()=>{workers--;}).then(valid=>{
        if(!valid)throw fail();freshUser(current,snapshotUser);
        return authService.emailVerification.consume(body.emailChallenge,body.code,{userId:user.id,purpose:'reauth',sessionId:current.session.id,target:{action:body.action,...(body.targetSessionId?{targetSessionId:body.targetSessionId}:{})}},()=>issueGrant(current,body.action,body.targetSessionId,snapshotUser.security_version));
      });
    }
    const enrolled = method==='password' ? null : repo.getTotpCredential(user.id);
    if (enrolled?.enabled_at != null && typeof body.code !== 'string') throw fail();
    if (typeof body.password === 'string' && (enrolled?.enabled_at == null || dualAction(body.action))) {
      if (workers >= maxPasswordConcurrency) throw new AuthError(503, 'AUTH_BUSY'); workers += 1;
      return Promise.resolve(p.verifyPassword(body.password, snapshotUser.password_hash)).then(value => { verified = value; }).finally(() => { workers -= 1; }).then(() => {
        const fresh = freshUser(current, snapshotUser);
        if (!verified) throw fail();
        if (enrolled?.enabled_at != null) {
          const factor = currentFactor(fresh); const counter = factor && p.verifyTotp(factor.secret, body.code, { now: now() });
          if (counter == null) throw fail();
          const result = repo.withTotpCounter({ userId: user.id, counter, at: now() }, () => issueGrant(current, body.action, body.targetSessionId, snapshotUser.security_version));
          if (!result) throw fail(); return result.result;
        }
        return issueGrant(current, body.action, body.targetSessionId, snapshotUser.security_version);
      });
    }
    if (typeof body.code === 'string' && !dualAction(body.action)) {
      const factor = repo.getTotpCredential(user.id); let counter = null;
      try { const secret = factor?.encrypted_secret ? p.decryptSecret(JSON.parse(factor.encrypted_secret), encryptionKey, { userId: user.id, purpose: 'totp-secret', keyId }) : null; if (secret) counter = p.verifyTotp(secret, body.code, { now: now() }); } catch { counter = null; }
      if (counter === null) throw fail();
      const fresh = freshUser(current, snapshotUser);
      const consumed = repo.withTotpCounter({ userId: user.id, counter, at: now() }, () => issueGrant(current, body.action, body.targetSessionId, snapshotUser.security_version));
      if (!consumed) throw fail(); return consumed.result;
    }
    throw fail();
  }
  function issueGrant(current, action, targetId, securityVersion) {
    const frozen = snapshot(current, action, targetId);
    const grant = p.generateToken(); const at = now();
    for (const [token, entry] of snapshots) if (entry.expiresAt <= at) snapshots.delete(token);
    if (snapshots.size >= 10000) throw new AuthError(503, 'AUTH_BUSY');
    const row = repo.createOperationGrant({ userId: current.user.id, sessionId: current.session.id, grant, action, targetId: JSON.stringify(frozen), securityVersion, createdAt: at, expiresAt: at + 120000 });
    if (!row) throw fail(); snapshots.set(grant, { frozen, userId: current.user.id, sessionId: current.session.id, action, securityVersion, expiresAt: at + 120000 }); return { grant, action, expiresAt: at + 120000, target: frozen };
  }
  function checkGrant(current, grant, action) {
    ensureAction(action); if (typeof grant !== 'string') throw fail();
    const entry = snapshots.get(grant);
    if (!entry || entry.expiresAt <= now()) { snapshots.delete(grant); throw fail(); }
    if (entry.userId !== current.user.id || entry.sessionId !== current.session.id || entry.action !== action || entry.securityVersion !== current.context.securityVersion) throw fail();
    return entry.frozen;
  }
  function consume(current, grant, action, mutation) {
    const target = checkGrant(current, grant, action);
    const frozen = repo.withOperationGrant({ grant, userId: current.user.id, sessionId: current.session.id, action, targetId: JSON.stringify(target), securityVersion: current.context.securityVersion, at: now() }, () => mutation(target));
    if (!frozen) throw fail(); snapshots.delete(grant); return frozen.result;
  }
  function sessions(req) {
    const current = auth(req, false); const at = now(); const rows = repo.listSessions(current.user.id);
    return { currentSessionId: current.session.id, valid: rows.filter(row => row.revoked_at == null && row.expires_at > at && row.idle_expires_at > at).map(publicSession), recentlyActive: rows.filter(row => row.revoked_at == null && row.last_seen_at >= at - 120000).map(publicSession) };
  }
  function publicSession(row) { return { id: row.id, deviceLabel: row.device_label, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, idleExpiresAt: row.idle_expires_at, authStrength: row.auth_strength, ephemeral: Boolean(row.is_ephemeral), recentlyActive: row.last_seen_at >= now() - 120000 }; }
  function history(req, details = false) {
    const current = auth(req, false); const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50)); const before = req.query.before == null ? null : Number(req.query.before);
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new AuthError(400, 'INVALID_CURSOR');
    return repo.listAudit({ userId: current.user.id, limit, before, includeDetails: details });
  }
  async function changePassword(req) {
    const current = auth(req); const expected = repo.findUserById(current.user.id); const body = req.body || {};
    rateLimit(req, current);
    checkGrant(current, req.headers['x-operation-grant'], 'password.change');
    if (workers >= maxPasswordConcurrency) throw new AuthError(503, 'AUTH_BUSY');
    workers += 1; let passwordHash;
    try {
      if (!await p.verifyPassword(body.currentPassword, expected.password_hash)) throw fail();
      try { p.validateNewPassword(body.newPassword); passwordHash = await p.hashPassword(body.newPassword); } catch { throw new AuthError(400, 'PASSWORD_POLICY'); }
    } finally { workers -= 1; }
    freshUser(current, expected);
    return consume(current, req.headers['x-operation-grant'], 'password.change', () => {
      freshUser(current, expected);
      repo.changePassword({ userId: current.user.id, passwordHash, at: now() });
      return { success: true, requiresLogin: true };
    });
  }
  function startFactor(req) {
    const current = auth(req); if (current.session.is_ephemeral) throw new AuthError(403, 'TEMPORARY_SESSION');
    const secret = p.generateTotpSecret();
    const payload = JSON.stringify({ userId: current.user.id, sessionId: current.session.id, securityVersion: current.user.security_version, encryptedSecret: JSON.stringify(p.encryptSecret(secret, encryptionKey, { userId: current.user.id, purpose: 'totp-secret', keyId })) });
    const challenge = p.generateToken(); const at = now();
    return consume(current, req.headers['x-operation-grant'], 'factor.replace', () => {
      if (!repo.createLoginChallenge({ userId: current.user.id, sessionId: current.session.id, challenge, kind: 'enroll', action: 'factor.replace', targetId: payload, createdAt: at, expiresAt: at + 120000 })) throw fail();
      return { secret, challenge, expiresAt: at + 120000 };
    });
  }
  function confirmFactor(req) {
    const current = auth(req); if (current.session.is_ephemeral) throw new AuthError(403, 'TEMPORARY_SESSION');
    rateLimit(req, current);
    const challenge = req.body?.challenge;
    try { p.hashToken(challenge); } catch { throw fail(); }
    const row = repo.findLoginChallenge(challenge, now());
    if (!row || row.kind !== 'enroll' || row.action !== 'factor.replace' || row.session_id !== current.session.id || row.user_id !== current.user.id) throw fail();
    const payload = JSON.parse(row.target_id);
    if (payload.userId !== current.user.id || payload.sessionId !== current.session.id || payload.securityVersion !== current.user.security_version) throw fail();
    let counter = null;
    try { const secret = p.decryptSecret(JSON.parse(payload.encryptedSecret), encryptionKey, { userId: current.user.id, purpose: 'totp-secret', keyId }); counter = p.verifyTotp(secret, req.body.code, { now: now() }); } catch { /* Invalid staged factor fails closed. */ }
    if (counter === null) { repo.recordChallengeFailure(challenge, now()); throw fail(); }
    const codes = p.generateRecoveryCodes();
    const result = repo.withLoginChallenge({ challenge, kind: 'enroll', sessionId: current.session.id, action: 'factor.replace', targetId: row.target_id, at: now() }, () => {
      if (repo.getTotpCredential(current.user.id)) repo.clearTotp({ userId: current.user.id, at: now() });
      else repo.revokeAllSessions({ userId: current.user.id, at: now() });
      repo.setPendingTotp({ userId: current.user.id, encryptedSecret: payload.encryptedSecret });
      if (!repo.withTotpCounter({ userId: current.user.id, counter, enroll: true, at: now() }, () => true)) throw fail();
      repo.email.activateTotp(current.user.id,current.session.id,now());
      repo.addRecoveryCodes(current.user.id, codes, now());
      repo.addAudit({ actorId: current.user.id, targetId: current.user.id, action: 'security.factor_changed', at: now() });
      return { success: true, requiresLogin: true, recoveryCodes: codes };
    });
    if (!result) throw fail(); return result.result;
  }
  function disableFactor(req) {
    const current = auth(req);
    if (current.session.is_ephemeral || current.user.role === 'admin' || current.user.login_policy === 'strict') throw new AuthError(403, 'MFA_POLICY_REQUIRED');
    return consume(current, req.headers['x-operation-grant'], 'factor.disable', () => { repo.clearTotp({ userId: current.user.id, at: now() }); if(repo.email.preference(current.user.id)?.method==='totp')repo.email.setPreference({userId:current.user.id,method:'password',at:now()}); return { success: true, requiresLogin: true }; });
  }
  return { reauth, verifyStrong, sessions, history, consume, changePassword, startFactor, confirmFactor, disableFactor };
}
module.exports = { createOperationsService, ACTIONS, EMAIL_REAUTH_ACTIONS };
