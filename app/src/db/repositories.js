'use strict';

const { createHash, randomUUID } = require('node:crypto');

const USER_ACTIONS = new Set(['user.created', 'user.disabled', 'user.enabled', 'user.role_changed', 'user.password_changed', 'user.password_reset', 'session.created', 'session.revoked', 'session.revoked_all', 'login.succeeded', 'login.failed', 'login.factor_failed', 'security.factor_changed', 'security.recovery_used', 'security.operation_consumed', 'data.migrated']);
const SAFE_DETAIL_KEYS = new Set(['reason', 'deviceLabel', 'authMethod', 'result', 'count', 'source']);

function hash(value) {
  if (typeof value !== 'string' || value.length < 16) throw new TypeError('secret must be a string of at least 16 characters');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function synchronous(fn) {
  if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') throw new TypeError('synchronous callback required');
  const result = fn();
  if (result && typeof result.then === 'function') throw new TypeError('async transaction forbidden');
  return result;
}
function normalizeUsername(value) {
  const name = required(value, 'username').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(name)) throw new TypeError('username must be 3-64 ASCII login characters');
  return name;
}
function required(value, name) { if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`); return value; }
function safeDetail(detail) {
  if (detail == null) return null;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) throw new TypeError('audit detail must be an object');
  const output = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!SAFE_DETAIL_KEYS.has(key) || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')) throw new TypeError('audit detail contains unsupported field');
    output[key] = value;
  }
  return JSON.stringify(output);
}
function assertId(value, name) { return required(value, name); }
function ensureTimeWindow(createdAt, expiresAt) { if (!Number.isSafeInteger(expiresAt) || expiresAt < createdAt) throw new RangeError('expiresAt must be after createdAt'); }

function createRepositories(db) {
  const tx = db.transaction((fn) => fn()).immediate;
  function createUser({ id = randomUUID(), username, displayName, passwordHash, role = 'user', mustChangePassword = false, storageQuotaBytes = 0, at = Date.now() }) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new TypeError('id must be a UUID');
    username = normalizeUsername(username); required(displayName, 'displayName'); required(passwordHash, 'passwordHash');
    if (!['user', 'admin'].includes(role)) throw new TypeError('invalid role');
    db.prepare(`INSERT INTO users (id,username,display_name,password_hash,role,must_change_password,created_at,updated_at,storage_quota_bytes) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, username.trim(), displayName, passwordHash, role, mustChangePassword ? 1 : 0, at, at, storageQuotaBytes);
    return findUserById(id);
  }
  function findUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(assertId(id, 'id')) || null; }
  function findUserByUsername(username) { return db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(normalizeUsername(username)) || null; }
  function listActiveUserIds() { return db.prepare('SELECT id FROM users WHERE deleted_at IS NULL').all(); }
  function listUsers({ limit = 50, before = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100');
    if (before !== null && (typeof before !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(before))) throw new TypeError('before must be a user UUID');
    const fields = 'id, username, display_name, role, disabled_at, deleted_at, must_change_password, storage_quota_bytes, storage_bytes, created_at';
    return before === null
      ? db.prepare(`SELECT ${fields} FROM users ORDER BY id DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT ${fields} FROM users WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, limit);
  }
  function findMigrationAudit({ userId, migrationId }) {
    assertId(userId, 'userId');
    required(migrationId, 'migrationId');
    const row = db.prepare("SELECT id,target_id,created_at,detail FROM audit_log WHERE target_id=? AND action='data.migrated' AND json_extract(detail,'$.reason')=? ORDER BY id DESC LIMIT 1").get(userId, migrationId);
    if (!row) return null;
    const detail = JSON.parse(row.detail || '{}');
    const allowed = Object.fromEntries(Object.entries(detail).filter(([key]) => SAFE_DETAIL_KEYS.has(key)));
    return { ...row, detail: JSON.stringify(allowed) };
  }
  function setStorageUsage({ userId, storageBytes, at = Date.now() }) {
    assertId(userId, 'userId');
    if (!Number.isSafeInteger(storageBytes) || storageBytes < 0) throw new TypeError('storageBytes must be a non-negative safe integer');
    return tx(() => {
      const updated = db.prepare('UPDATE users SET storage_bytes=?,updated_at=? WHERE id=?').run(storageBytes, at, userId);
      return updated.changes === 1 ? findUserById(userId) : null;
    });
  }
  function countActiveAdmins() { return db.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND disabled_at IS NULL AND deleted_at IS NULL").get().count; }
  function revokeSessionsForUser(userId, at) { return db.prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND revoked_at IS NULL').run(at, userId).changes; }
  function changePassword({ userId, passwordHash, mustChangePassword = false, at = Date.now() }) {
    required(passwordHash, 'passwordHash');
    return tx(() => { const user = findUserById(userId); if (!user) return null; db.prepare('UPDATE users SET password_hash=?, must_change_password=?, security_version=security_version+1, updated_at=? WHERE id=?').run(passwordHash, mustChangePassword ? 1 : 0, at, userId); revokeSessionsForUser(userId, at); revokeSecurityMaterials(userId, at); return findUserById(userId); });
  }
  function setDisabled({ userId, disabled, at = Date.now() }) {
    if (typeof disabled !== 'boolean') throw new TypeError('disabled must be boolean');
    return tx(() => { const user = findUserById(userId); if (!user) return null; if (!disabled && user.disabled_at == null) return user; if (disabled && user.role === 'admin' && user.disabled_at == null && countActiveAdmins() <= 1) { const e = new Error('cannot disable the last active administrator'); e.code = 'LAST_ADMIN'; throw e; } db.prepare('UPDATE users SET disabled_at=?, security_version=security_version+1, updated_at=? WHERE id=?').run(disabled ? at : null, at, userId); if (disabled) { revokeSessionsForUser(userId, at); revokeSecurityMaterials(userId, at); } return findUserById(userId); });
  }
  function createSession({ id = randomUUID(), userId, token, csrfToken, deviceLabel = null, ipAddress = null, ephemeral = false, authStrength = 'password', createdAt = Date.now(), idleExpiresAt, expiresAt }) {
    assertId(userId, 'userId'); ensureTimeWindow(createdAt, idleExpiresAt); ensureTimeWindow(createdAt, expiresAt); required(token, 'token'); required(csrfToken, 'csrfToken');
    if (!['password', 'totp', 'webauthn'].includes(authStrength)) throw new TypeError('invalid auth strength');
    db.prepare(`INSERT INTO sessions (id,user_id,token_hash,csrf_hash,device_label,ip_address,is_ephemeral,auth_strength,security_version,created_at,last_seen_at,idle_expires_at,expires_at) SELECT ?,?,?,?,?,?,?,?,security_version,?,?,?,? FROM users WHERE id=? AND disabled_at IS NULL AND deleted_at IS NULL`).run(id,userId,hash(token),hash(csrfToken),deviceLabel,ipAddress,ephemeral ? 1 : 0,authStrength,createdAt,createdAt,idleExpiresAt,expiresAt,userId);
    return findSessionById(id);
  }
  function findSessionByToken(token, at = Date.now()) { const row = db.prepare('SELECT s.*, u.username, u.role, u.disabled_at, u.deleted_at, u.security_version AS user_security_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.idle_expires_at>? AND s.expires_at>? AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND s.security_version=u.security_version').get(hash(token), at, at); return row || null; }
  function findSessionById(id) { return db.prepare('SELECT * FROM sessions WHERE id=?').get(assertId(id, 'sessionId')) || null; }
  function revokeSession({ sessionId, userId, at = Date.now() }) { const result = db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at, ?) WHERE id=? AND user_id=? AND revoked_at IS NULL').run(at, assertId(sessionId, 'sessionId'), assertId(userId, 'userId')); return result.changes === 1; }
  function revokeOtherSessions({ userId, keepSessionId, at = Date.now() }) { return db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at, ?) WHERE user_id=? AND id<>? AND revoked_at IS NULL').run(at, userId, keepSessionId).changes; }
  function revokeSecurityMaterials(userId, at) { db.prepare('UPDATE login_challenges SET consumed_at=COALESCE(consumed_at, ?) WHERE user_id=? AND consumed_at IS NULL').run(at, userId); db.prepare('UPDATE operation_grants SET consumed_at=COALESCE(consumed_at, ?) WHERE user_id=? AND consumed_at IS NULL').run(at, userId); db.prepare('UPDATE recovery_codes SET revoked_at=COALESCE(revoked_at, ?) WHERE user_id=? AND revoked_at IS NULL').run(at, userId); db.prepare('DELETE FROM totp_credentials WHERE user_id=? AND enabled_at IS NULL').run(userId); }
  function createOperationGrant({ userId, sessionId, grant, action, targetId = null, securityVersion, createdAt = Date.now(), expiresAt }) {
    required(action,'action'); ensureTimeWindow(createdAt,expiresAt);
    if (expiresAt-createdAt>120000) throw new RangeError('operation grant exceeds two minutes');
    const session=activeSession(sessionId,userId,createdAt);
    if (!session || session.security_version!==securityVersion) return null;
    const id=randomUUID();
    db.prepare('INSERT INTO operation_grants (id,user_id,session_id,grant_hash,action,target_id,security_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,userId,sessionId,hash(grant),action,targetId,securityVersion,createdAt,expiresAt);
    return {id,userId,sessionId,action,targetId,securityVersion,createdAt,expiresAt};
  }
  function activeSession(sessionId, userId, at) {
    return db.prepare(`SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.idle_expires_at>? AND s.expires_at>? AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND s.security_version=u.security_version`).get(sessionId,userId,at,at) || null;
  }
  function withOperationGrant({ grant, userId, sessionId, action, targetId = null, securityVersion, at = Date.now() }, mutation) {
    if (typeof mutation !== 'function' || mutation.constructor.name === 'AsyncFunction') throw new TypeError('synchronous mutation required');
    return tx(() => {
      if (!activeSession(sessionId,userId,at)) return null;
      const row = db.prepare('SELECT * FROM operation_grants WHERE grant_hash=? AND user_id=? AND session_id=? AND action=? AND target_id IS ? AND security_version=? AND consumed_at IS NULL AND created_at<=? AND expires_at>?').get(hash(grant),userId,sessionId,action,targetId,securityVersion,at,at);
      const user = findUserById(userId);
      if (!row || !user || row.security_version !== user.security_version) return null;
      db.prepare('UPDATE operation_grants SET consumed_at=? WHERE id=?').run(at,row.id);
      const result = mutation();
      if (result && typeof result.then === 'function') throw new TypeError('async transaction result forbidden');
      addAudit({actorId:userId,actorSessionId:sessionId,targetId,action:'security.operation_consumed',at});
      return { result };
    });
  }
  function addRecoveryCodes(userId, codes, at = Date.now()) { if (!Array.isArray(codes) || !codes.length) throw new TypeError('codes required'); const insert = db.prepare('INSERT INTO recovery_codes (id,user_id,code_hash,created_at) VALUES (?,?,?,?)'); const add = db.transaction(() => codes.map(code => { required(code, 'code'); const id = randomUUID(); insert.run(id,userId,hash(code),at); return id; })); return add(); }
  function consumeRecoveryCode({ userId, code, at = Date.now() }) { return tx(() => { const row = db.prepare('SELECT * FROM recovery_codes WHERE user_id=? AND code_hash=? AND consumed_at IS NULL AND revoked_at IS NULL').get(userId, hash(code)); if (!row) return false; db.prepare('UPDATE recovery_codes SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(at,row.id); return true; }); }
  function addAudit({ actorId = null, targetId = null, actorSessionId = null, action, detail = null, ipAddress = null, authStrength = null, at = Date.now() }) { if (!USER_ACTIONS.has(action)) throw new TypeError('unsupported audit action'); db.prepare('INSERT INTO audit_log(actor_id,target_id,actor_session_id,action,detail,ip_address,auth_strength,created_at) VALUES (?,?,?,?,?,?,?,?)').run(actorId,targetId,actorSessionId,action,safeDetail(detail),ipAddress,authStrength,at); }
  function listAudit({ userId, limit = 50, before = null, includeDetails = false } = {}) {
    assertId(userId, 'userId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100');
    if (includeDetails !== true && includeDetails !== false) throw new TypeError('includeDetails must be boolean');
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) throw new TypeError('before must be an audit id');
    const columns = includeDetails
      ? 'id, target_id, action, detail, ip_address, actor_session_id, auth_strength, created_at'
      : 'id, target_id, action, auth_strength, created_at';
    const cursor = before !== null ? ' AND id < ?' : '';
    return db.prepare(`SELECT ${columns} FROM audit_log WHERE (actor_id = ? OR target_id = ?) AND action IN (${Array.from(USER_ACTIONS, () => '?').join(',')})${cursor} ORDER BY id DESC LIMIT ?`)
      .all(userId, userId, ...USER_ACTIONS, ...(before !== null ? [before] : []), limit);
  }
  function setRole({ userId, role, at = Date.now() }) {
    if (!['admin','user'].includes(role)) throw new TypeError('invalid role');
    return tx(() => {
      const user = findUserById(userId);
      if (!user) return null;
      if (user.role === 'admin' && role !== 'admin' && user.disabled_at == null && user.deleted_at == null && countActiveAdmins() <= 1) { const error = new Error('last administrator'); error.code = 'LAST_ADMIN'; throw error; }
      db.prepare('UPDATE users SET role=?,security_version=security_version+1,updated_at=? WHERE id=?').run(role,at,userId);
      revokeSessionsForUser(userId,at); revokeSecurityMaterials(userId,at);
      return findUserById(userId);
    });
  }
  function revokeAllSessions({ userId, at = Date.now() }) { return tx(() => {
    if (!findUserById(userId)) return 0;
    db.prepare('UPDATE users SET security_version=security_version+1,updated_at=? WHERE id=?').run(at,userId);
    const count = revokeSessionsForUser(userId,at); revokeSecurityMaterials(userId,at); return count;
  }); }
  function listSessions(userId) { return db.prepare('SELECT id,user_id,device_label,ip_address,is_ephemeral,auth_strength,created_at,last_seen_at,idle_expires_at,expires_at,revoked_at FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(userId); }
  function touchSession({sessionId,userId,idleExpiresAt,at=Date.now()}) { const session = activeSession(sessionId,userId,at); if (!session) return false; return db.prepare('UPDATE sessions SET last_seen_at=?,idle_expires_at=? WHERE id=?').run(at,Math.min(idleExpiresAt,session.expires_at),sessionId).changes === 1; }
  function promoteSession({sessionId,userId,authStrength='totp',at=Date.now()}) { return db.prepare('UPDATE sessions SET auth_strength=?,last_seen_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL').run(authStrength,at,sessionId,userId).changes === 1; }
  function createLoginChallenge({userId,challenge,kind='login',sessionId=null,action=null,targetId=null,createdAt=Date.now(),expiresAt}) {
    if (!['login','reauth','enroll'].includes(kind)) throw new TypeError('invalid challenge kind');
    ensureTimeWindow(createdAt,expiresAt);
    if (expiresAt-createdAt>300000) throw new RangeError('challenge exceeds five minutes');
    const user=findUserById(userId);
    if (!user || user.disabled_at != null || user.deleted_at != null) return null;
    if (sessionId && !activeSession(sessionId,userId,createdAt)) return null;
    const id=randomUUID();
    db.prepare('INSERT INTO login_challenges(id,user_id,challenge_hash,kind,session_id,action,target_id,security_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,userId,hash(challenge),kind,sessionId,action,targetId,user.security_version,createdAt,expiresAt);
    return {id,user_id:userId,kind,session_id:sessionId,action,target_id:targetId,security_version:user.security_version,expires_at:expiresAt};
  }
  function findLoginChallenge(challenge,at=Date.now()) {
    return db.prepare('SELECT c.* FROM login_challenges c JOIN users u ON u.id=c.user_id WHERE c.challenge_hash=? AND c.consumed_at IS NULL AND c.created_at<=? AND c.expires_at>? AND c.attempts<5 AND c.security_version=u.security_version AND u.disabled_at IS NULL AND u.deleted_at IS NULL').get(hash(challenge),at,at) || null;
  }
  function recordChallengeFailure(challenge,at=Date.now()) { return db.prepare('UPDATE login_challenges SET attempts=attempts+1 WHERE challenge_hash=? AND consumed_at IS NULL AND expires_at>?').run(hash(challenge),at).changes===1; }
  function expireFactorSetupChallenges({userId,sessionId,at=Date.now()}) { return db.prepare("UPDATE login_challenges SET consumed_at=? WHERE user_id=? AND session_id=? AND action='post-login-factor-confirm' AND consumed_at IS NULL").run(at,userId,sessionId).changes; }
  function withLoginChallenge({challenge,kind='login',sessionId=null,action=null,targetId=null,at=Date.now()},mutation) {
    return tx(() => {
      const row=findLoginChallenge(challenge,at);
      if (!row || row.kind!==kind || row.session_id!==sessionId || row.action!==action || row.target_id!==targetId || (sessionId && !activeSession(sessionId,row.user_id,at))) return null;
      db.prepare('UPDATE login_challenges SET consumed_at=? WHERE id=?').run(at,row.id);
      const result=synchronous(() => mutation(row));
      return {result};
    });
  }
  function getTotpCredential(userId) { return db.prepare('SELECT * FROM totp_credentials WHERE user_id=?').get(userId) || null; }
  function setPendingTotp({userId,encryptedSecret}) {
    required(encryptedSecret,'encryptedSecret');
    if (getTotpCredential(userId)?.enabled_at != null) throw new Error('existing TOTP must be removed through authorized recovery');
    db.prepare('INSERT INTO totp_credentials(user_id,encrypted_secret) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=excluded.encrypted_secret,last_counter=-1,enabled_at=NULL').run(userId,encryptedSecret);
  }
  function withTotpCounter({userId,counter,enroll=false,at=Date.now()},mutation) {
    if (!Number.isSafeInteger(counter) || counter<0) throw new TypeError('invalid TOTP counter');
    return tx(() => {
      const result=db.prepare('UPDATE totp_credentials SET last_counter=?,enabled_at=COALESCE(enabled_at,?) WHERE user_id=? AND last_counter<? AND (?=1 OR enabled_at IS NOT NULL)').run(counter,at,userId,counter,enroll?1:0);
      if (!result.changes) return null;
      return {result:synchronous(mutation)};
    });
  }
  function setLoginPolicy({userId,policy,at=Date.now()}) {
    if (!['standard','strict'].includes(policy)) throw new TypeError('invalid login policy');
    return tx(() => { const u=findUserById(userId); if (!u) return null; db.prepare('UPDATE users SET login_policy=?,updated_at=? WHERE id=?').run(policy,at,userId); revokeAllSessions({userId,at}); return findUserById(userId); });
  }
  function clearTotp({userId,at=Date.now()}) { return tx(() => { revokeAllSessions({userId,at}); return db.prepare('DELETE FROM totp_credentials WHERE user_id=?').run(userId).changes===1; }); }
  function completeRecovery({userId,code,at=Date.now()},mutation) {
    return tx(() => {
      const user=findUserById(userId);
      if (!user || user.disabled_at != null || user.deleted_at != null || !consumeRecoveryCode({userId,code,at})) return null;
      revokeAllSessions({userId,at});
      const result=synchronous(mutation);
      addAudit({actorId:userId,targetId:userId,action:'security.recovery_used',at});
      return {result};
    });
  }
  return { email: require('./email-repository').createEmailRepository(db), createUser, listUsers, setStorageUsage, findMigrationAudit, findUserById, findUserByUsername, listActiveUserIds, countActiveAdmins, changePassword, setDisabled, setRole, createSession, findSessionByToken, findSessionById, activeSession, promoteSession, revokeSession, revokeOtherSessions, revokeAllSessions, listSessions, touchSession, createOperationGrant, withOperationGrant, createLoginChallenge, findLoginChallenge, recordChallengeFailure, expireFactorSetupChallenges, withLoginChallenge, addRecoveryCodes, consumeRecoveryCode, completeRecovery, getTotpCredential, setPendingTotp, withTotpCounter, setLoginPolicy, clearTotp, addAudit, listAudit };
}
module.exports = { createRepositories, hash };
