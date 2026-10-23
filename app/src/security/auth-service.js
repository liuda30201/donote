'use strict';
const crypto = require('node:crypto');
const p = require('./primitives');
const QRCode = require('qrcode');

class AuthError extends Error {
  constructor(status, code, message = 'Authentication failed') { super(message); this.status = status; this.code = code; }
}
function createAuthService({ repo, allowedOrigins, encryptionKey, keyId, secureCookies = true, cookieName = secureCookies ? '__Host-dn_session' : 'dn_session_dev', maxPasswordConcurrency = 2, now = Date.now, postLoginFactorSetup = false, optionalFactorSetup = false }) {
  if (!repo || !Array.isArray(allowedOrigins) || !allowedOrigins.length || !Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 || typeof keyId !== 'string' || !keyId) throw new TypeError('Explicit authentication configuration required');
  const origins = new Set(allowedOrigins.map(origin => { const url = new URL(origin); if (url.origin !== origin || !['https:', 'http:'].includes(url.protocol)) throw new TypeError('Exact HTTP origin required'); return origin; }));
  if (!Number.isInteger(maxPasswordConcurrency) || maxPasswordConcurrency < 1 || maxPasswordConcurrency > 8 || !/^[A-Za-z0-9_-]+$/.test(cookieName) || (!secureCookies && cookieName.startsWith('__Host-'))) throw new TypeError('Invalid authentication configuration');
  let workers = 0; let dummyHash;
  const attempts = new Map();
  const fail = () => new AuthError(401, 'AUTH_FAILED');
  function parseObject(value) {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail();
      return parsed;
    } catch { throw fail(); }
  }
  function audit(action, userId, req, extra = {}) { repo.addAudit({ action, actorId: userId || null, targetId: userId || null, ipAddress: source(req), at: now(), ...extra }); }
  function source(req) { return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128); }
  function origin(req) { if (!origins.has(req.headers.origin)) throw new AuthError(403, 'ORIGIN_REJECTED'); }
  function limit(req, username) {
    const at = now();
    for (const [key, value] of attempts) if (value.until <= at) attempts.delete(key);
    const keys = ['global', `ip:${source(req)}`, `user:${username}`];
    const caps = [300, 30, 10];
    if (keys.some((key, i) => (attempts.get(key)?.count || 0) >= caps[i])) throw new AuthError(429, 'AUTH_RATE_LIMIT');
    if (attempts.size > 10000) throw new AuthError(429, 'AUTH_RATE_LIMIT');
    keys.forEach(key => { const old = attempts.get(key); attempts.set(key, { count: (old?.count || 0) + 1, until: old?.until || at + 60000 }); });
  }
  async function passwordWork(password, hash) {
    if (workers >= maxPasswordConcurrency) throw new AuthError(503, 'AUTH_BUSY');
    workers += 1;
    try {
      if (!dummyHash) dummyHash = p.hashPassword('donote-dummy-password-not-an-account');
      return await p.verifyPassword(password, hash || await dummyHash);
    } finally { workers -= 1; }
  }
  function csrfFor(token) { return crypto.createHmac('sha256', token).update('donote-csrf-v1').digest('base64url'); }
  function cookieToken(req) {
    const header = req.headers.cookie || '';
    const values = header.split(';').map(x => x.trim()).filter(x => x.startsWith(`${cookieName}=`));
    if (values.length !== 1) throw fail();
    const token = values[0].slice(cookieName.length + 1);
    try { p.hashToken(token); } catch { throw fail(); }
    return token;
  }
  function setupSession(user, meta, req) {
    return { ...makeSession(user, meta, req, 'password'), requiresFactorSetup: true, optionalFactorSetup };
  }
  let emailVerification;
  function verificationMethod(user) {
    if (user.role === 'admin' || user.login_policy === 'strict') return 'totp';
    return repo.email.preference(user.id)?.method || (repo.getTotpCredential(user.id)?.enabled_at != null ? 'totp' : 'password');
  }
  function fullPolicy(user, session) {
    if (!user || user.disabled_at != null || user.deleted_at != null || user.must_change_password) return false;
    const method = verificationMethod(user);
    const needsTotp = method === 'totp';
    if (method === 'email') return repo.email.hasProof(session.id,user.id,user.security_version);
    return !needsTotp || (optionalFactorSetup && repo.getTotpCredential(user.id)?.enabled_at == null && session.auth_strength === 'password') || (repo.getTotpCredential(user.id)?.enabled_at != null && ['totp', 'webauthn'].includes(session.auth_strength));
  }
  function needsFactorSetup(user) { return postLoginFactorSetup && verificationMethod(user) === 'totp' && !user.must_change_password && repo.getTotpCredential(user.id)?.enabled_at == null; }
  function authenticateRequest(req) {
    const token = cookieToken(req); const at = now();
    const session = repo.findSessionByToken(token, at);
    const user = session && repo.findUserById(session.user_id);
    if (!session || !user || (!fullPolicy(user, session) && !(req.allowFactorSetup === true && needsFactorSetup(user)))) throw fail();
    const context = { userId: user.id, sessionId: session.id, role: user.role, securityVersion: user.security_version, authStrength: session.auth_strength };
    return { context, session, user, token };
  }
  function requireCsrf(req, authenticated) {
    origin(req);
    const supplied = req.headers['x-csrf-token'];
    const expected = csrfFor(authenticated.token);
    if (!p.constantTimeEqual(supplied, expected) || crypto.createHash('sha256').update(expected).digest('hex') !== authenticated.session.csrf_hash) throw new AuthError(403, 'CSRF_REJECTED');
  }
  function publicUser(user) { return { id: user.id, username: user.username, displayName: user.display_name, role: user.role }; }
  function makeSession(user, meta, req, strength) {
    const current = repo.findUserById(user.id);
    if (!current || current.security_version !== user.security_version || current.password_hash !== user.password_hash || current.disabled_at != null || current.deleted_at != null || current.must_change_password) throw fail();
    const at = now(); const token = p.generateToken();
    const expiresAt = at + (meta.ephemeral ? 8 * 3600000 : 7 * 86400000);
    const row = repo.createSession({ userId: user.id, token, csrfToken: csrfFor(token), deviceLabel: meta.deviceLabel, ipAddress: source(req), ephemeral: meta.ephemeral, authStrength: strength, createdAt: at, idleExpiresAt: at + (meta.ephemeral ? 15 * 60000 : 24 * 3600000), expiresAt });
    if (!row) throw fail();
    audit('login.succeeded', user.id, req, { actorSessionId: row.id, authStrength: strength });
    return { token, session: row, user: publicUser(current), ephemeral: meta.ephemeral };
  }
  async function login(req) {
    origin(req);
    const body = req.body || {};
    const identifier = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 255) : (typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 65) : '');
    limit(req, identifier);

    // 邮箱验证码登录
    if (body.loginMethod === 'email-code' && body.email) {
      let user = null;
      try { user = repo.findUserByEmail(identifier); } catch { /* Invalid identifiers follow the same password path. */ }
      if (!user || user.disabled_at != null || user.deleted_at != null) { audit('login.failed', user?.id, req); throw fail(); }
      const pref = repo.email.preference(user.id);
      if (!pref?.email_verified_at || !emailVerification) throw fail();
      const meta = { ephemeral: body.ephemeral === true, deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel.slice(0, 128) : 'Browser' };
      const staged = await emailVerification.send(req, { user, email: pref.email, purpose: 'email-code-login', target: meta });
      return { ...staged, requiresSecondFactor: true, factorMethod: 'email', emailHint: pref.email };
    }

    // 原有密码登录逻辑
    let user = null;
    try { user = body.email ? repo.findUserByEmail(identifier) : repo.findUserByUsername(identifier); } catch { /* Invalid identifiers follow the same password path. */ }
    const valid = await passwordWork(body.password, user?.password_hash);
    if (!valid || !user || user.disabled_at != null || user.deleted_at != null) { audit('login.failed', user?.id, req); throw fail(); }
    const fresh = repo.findUserById(user.id);
    if (!fresh || fresh.security_version !== user.security_version || fresh.password_hash !== user.password_hash || fresh.disabled_at != null || fresh.deleted_at != null) throw fail();
    const meta = { ephemeral: body.ephemeral === true, deviceLabel: typeof body.deviceLabel === 'string' ? body.deviceLabel.slice(0, 128) : 'Browser' };
    const method = verificationMethod(user);
    const factor = repo.getTotpCredential(user.id);
    if (method === 'email') {
      const pref = repo.email.preference(user.id);
      if (!pref?.email_verified_at || !emailVerification) throw fail();
      const staged = await emailVerification.send(req,{user,email:pref.email,purpose:'login',target:meta});
      return { ...staged, requiresSecondFactor:true, factorMethod:'email' };
    }
    if (method === 'totp' && factor?.enabled_at != null) {
      const challenge = p.generateToken();
      const targetId = JSON.stringify(meta); const at = now();
      if (!repo.createLoginChallenge({ userId: user.id, challenge, kind: 'login', targetId, createdAt: at, expiresAt: at + 300000 })) throw fail();
      return { challenge, requiresSecondFactor: true, expiresAt: at + 300000 };
    }
    if (user.must_change_password) return setupChallenge(user, { meta, requirePassword: true, requireFactor: !postLoginFactorSetup && (user.role === 'admin' || user.login_policy === 'strict'), mode: 'initialization' });
    if (method === 'totp') {
      if (postLoginFactorSetup) return setupSession(user, meta, req, 'post-login');
      return setupChallenge(user, { meta, requirePassword: false, requireFactor: true, mode: 'initialization' });
    }
    return makeSession(user, meta, req, 'password');
  }
  function completeLogin(req) {
    origin(req); const body = req.body || {};
    // Account-specific key is selected only after resolving the server-side challenge.
    if (typeof body.challenge !== 'string') { limit(req, `invalid:${source(req)}`); throw fail(); }
    try { p.hashToken(body.challenge); } catch { throw fail(); }
    const emailRow = repo.email.find(body.challenge,now());
    if (emailRow) {
      limit(req,`factor:${emailRow.user_id}`);
      return emailVerification.consume(body.challenge,body.code,{purpose:['login','email-code-login']},row=>{
        const user=repo.findUserById(row.user_id);
        if(!user || (row.purpose === 'login' && verificationMethod(user)!=='email'))throw fail();
        const meta=parseObject(row.target);
        if(user.must_change_password)return setupChallenge(user,{meta,requirePassword:true,requireFactor:false,mode:'password-change'});
        // Email verification is stored separately as a session/user/security-version proof.
        // Keep the schema's password strength; a proof never grants TOTP/admin privileges.
        const result=makeSession(user,meta,req,'password');
        if (row.purpose === 'login') repo.email.prove(result.session.id,user.id,user.security_version,now());
        return result;
      });
    }
    const row = repo.findLoginChallenge(body.challenge, now());
    limit(req, row ? `factor:${row.user_id}` : `invalid:${source(req)}`);
    if (!row || row.kind !== 'login' || row.session_id !== null || row.action !== null) throw fail();
    const user = repo.findUserById(row.user_id); const factor = repo.getTotpCredential(row.user_id);
    let counter = null;
    try {
      if (factor?.enabled_at != null) {
        const secret = p.decryptSecret(JSON.parse(factor.encrypted_secret), encryptionKey, { userId: user.id, purpose: 'totp-secret', keyId });
        counter = p.verifyTotp(secret, body.code, { now: now() });
      }
    } catch { /* Corrupt factor material fails closed. */ }
    if (counter === null) { repo.recordChallengeFailure(body.challenge, now()); audit('login.factor_failed', row.user_id, req); throw fail(); }
    try {
      const result = repo.withLoginChallenge({ challenge: body.challenge, kind: 'login', sessionId: null, action: null, targetId: row.target_id, at: now() }, () => {
        const meta = parseObject(row.target_id);
         const consumed = repo.withTotpCounter({ userId: user.id, counter, at: now() }, () => user.must_change_password ? setupChallenge(user, { meta, requirePassword: true, requireFactor: false, mode: 'password-change' }) : makeSession(user, meta, req, 'totp'));
        if (!consumed) throw fail(); return consumed.result;
      });
      if (!result) throw fail(); return result.result;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      repo.recordChallengeFailure(body.challenge, now()); throw error;
    }
  }
  function setupChallenge(user, payload) {
    const challenge = p.generateToken(); const at = now();
    const result = repo.createLoginChallenge({ userId: user.id, challenge, kind: 'enroll', targetId: JSON.stringify(payload), createdAt: at, expiresAt: at + 300000 });
    if (!result) throw fail();
    return { challenge, requiresSetup: true, requirePassword: payload.requirePassword, requireFactor: payload.requireFactor, expiresAt: at + 300000 };
  }
  function restricted(req) {
    origin(req); const body = req.body || {};
    try { p.hashToken(body.challenge); } catch { throw fail(); }
    const row = repo.findLoginChallenge(body.challenge, now());
    limit(req, row ? `setup:${row.user_id}` : `invalid:${source(req)}`);
    if (!row || row.kind !== 'enroll' || row.session_id !== null || row.action !== null) throw fail();
    return { row, payload: parseObject(row.target_id), body };
  }
  function consumeSetup(row, mutation) {
    const result = repo.withLoginChallenge({ challenge: row.rawChallenge, kind: 'enroll', sessionId: null, action: null, targetId: row.target_id, at: now() }, mutation);
    if (!result) throw fail(); return result.result;
  }
  async function startPostLoginSetup(req) {
    req.allowFactorSetup = true;
    const current = authenticateRequest(req); requireCsrf(req, current);
    limit(req, current.user.username);
    const factor = repo.getTotpCredential(current.user.id);
    const managedSetup = current.user.role === 'admin' || current.user.login_policy === 'strict';
    if (!postLoginFactorSetup || factor?.enabled_at != null || verificationMethod(current.user) === 'email' || !managedSetup) throw fail();
    repo.expireFactorSetupChallenges({ userId: current.user.id, sessionId: current.session.id, at: now() });
    if (!factor) {
      const secret = p.generateTotpSecret();
      repo.setPendingTotp({ userId: current.user.id, encryptedSecret: JSON.stringify(p.encryptSecret(secret, encryptionKey, { userId: current.user.id, purpose: 'totp-secret', keyId })) });
    }
    const staged = repo.getTotpCredential(current.user.id);
    let secret;
    try { secret = p.decryptSecret(JSON.parse(staged.encrypted_secret), encryptionKey, { userId: current.user.id, purpose: 'totp-secret', keyId }); }
    catch { throw fail(); }
    const uri = `otpauth://totp/${encodeURIComponent(`DoNote:${current.user.username}`)}?secret=${encodeURIComponent(secret)}&issuer=DoNote&algorithm=SHA1&digits=6&period=30`;
    const challenge = p.generateToken(); const at = now();
    const targetId = JSON.stringify({ sessionId: current.session.id, securityVersion: current.user.security_version });
    if (!repo.createLoginChallenge({ userId: current.user.id, challenge, sessionId: current.session.id, kind: 'enroll', action: 'post-login-factor-confirm', targetId, createdAt: at, expiresAt: at + 300000 })) throw fail();
    const qrCode = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
    return { challenge, secret, uri, qrCode, expiresAt: at + 300000 };
  }
  function completePostLoginSetup(req) {
    req.allowFactorSetup = true;
    const current = authenticateRequest(req); requireCsrf(req, current);
    if (repo.getTotpCredential(current.user.id)?.enabled_at != null) throw fail();
    if (current.user.role !== 'admin' && current.user.login_policy !== 'strict') throw new AuthError(403, 'MFA_POLICY_REQUIRED');
    limit(req, current.user.username);
    const body = req.body || {}; const challenge = typeof body.challenge === 'string' ? body.challenge : '';
    const row = repo.findLoginChallenge(challenge, now());
    if (!row || row.kind !== 'enroll' || row.action !== 'post-login-factor-confirm' || row.user_id !== current.user.id || row.session_id !== current.session.id) throw fail();
    let counter = null; let secret;
    try { const factor = repo.getTotpCredential(current.user.id); secret = p.decryptSecret(JSON.parse(factor.encrypted_secret), encryptionKey, { userId: current.user.id, purpose: 'totp-secret', keyId }); counter = p.verifyTotp(secret, body.code, { now: now() }); } catch { counter = null; }
    if (counter === null) { repo.recordChallengeFailure(challenge, now()); throw fail(); }
    const result = repo.withLoginChallenge({ challenge, kind: 'enroll', sessionId: current.session.id, action: 'post-login-factor-confirm', targetId: row.target_id, at: now() }, () => {
      const consumed = repo.withTotpCounter({ userId: current.user.id, counter, enroll: true, at: now() }, () => repo.promoteSession({ sessionId: current.session.id, userId: current.user.id, authStrength: 'totp', at: now() }));
      if (!consumed?.result) throw fail();
      repo.email.activateTotp(current.user.id,current.session.id,now());
      const codes = p.generateRecoveryCodes(); repo.addRecoveryCodes(current.user.id, codes, now());
      audit('security.factor_changed', current.user.id, req, { actorSessionId: current.session.id, authStrength: 'totp' });
      return { success: true, recoveryCodes: codes };
    });
    if (!result) throw fail();
    return result.result;
  }
  function skipPostLoginSetup(req) {
    if (!optionalFactorSetup) throw new AuthError(403, 'MFA_POLICY_REQUIRED');
    const current = authenticateRequest(req); requireCsrf(req, current);
    return { success: true, skipped: true };
  }
  function startSetup(req) {
    const { row, payload, body } = restricted(req);
    if (!payload.requireFactor || payload.encryptedSecret) throw fail();
    const secret = p.generateTotpSecret();
    const encryptedSecret = JSON.stringify(p.encryptSecret(secret, encryptionKey, { userId: row.user_id, purpose: 'totp-secret', keyId }));
    const user = repo.findUserById(row.user_id);
    const next = consumeSetup({ ...row, rawChallenge: body.challenge }, () => setupChallenge(user, { ...payload, encryptedSecret }));
    return { ...next, secret };
  }
  async function completeSetup(req) {
    const { row, payload, body } = restricted(req);
    let passwordHash = null;
    if (payload.requirePassword) {
      if (workers >= maxPasswordConcurrency) throw new AuthError(503, 'AUTH_BUSY');
      workers += 1;
      try { p.validateNewPassword(body.newPassword); passwordHash = await p.hashPassword(body.newPassword); }
      catch { repo.recordChallengeFailure(body.challenge, now()); throw new AuthError(400, 'PASSWORD_POLICY', '新密码至少需要 8 个字符，且包含大小写字母、数字和特殊字符'); }
      finally { workers -= 1; }
    }
    let counter = null;
    if (payload.requireFactor) {
      try {
        const secret = p.decryptSecret(JSON.parse(payload.encryptedSecret), encryptionKey, { userId: row.user_id, purpose: 'totp-secret', keyId });
        counter = p.verifyTotp(secret, body.code, { now: now() });
      } catch { /* Fail closed on absent/corrupt staged factor. */ }
      if (counter === null) { repo.recordChallengeFailure(body.challenge, now()); throw fail(); }
    }
    const codes = payload.requireFactor ? p.generateRecoveryCodes() : [];
    return consumeSetup({ ...row, rawChallenge: body.challenge }, () => {
      const current = repo.findUserById(row.user_id);
      if (passwordHash || payload.requireFactor) repo.changePassword({ userId: row.user_id, passwordHash: passwordHash || current.password_hash, mustChangePassword: false, at: now() });
      if (payload.requireFactor) {
        repo.setPendingTotp({ userId: row.user_id, encryptedSecret: payload.encryptedSecret });
        if (!repo.withTotpCounter({ userId: row.user_id, counter, enroll: true, at: now() }, () => true)) throw fail();
        repo.addRecoveryCodes(row.user_id, codes, now());
      }
      audit('security.factor_changed', row.user_id, req, { detail: { reason: payload.mode, result: 'completed' } });
      return { success: true, requiresLogin: true, ...(codes.length ? { recoveryCodes: codes } : {}) };
    });
  }
  async function startRecovery(req) {
    origin(req); const body = req.body || {};
    const identifier = typeof body.email === 'string' ? body.email.trim().toLowerCase() : (typeof body.username === 'string' ? body.username.trim().toLowerCase() : '');
    limit(req, `recovery:${identifier}`);
    let user; try { user = body.email ? repo.findUserByEmail(identifier) : repo.findUserByUsername(identifier); } catch { /* Uniform failure below. */ }
    const valid = await passwordWork(body.password, user?.password_hash);
    const fresh = user && repo.findUserById(user.id);
    if (!valid || !fresh || fresh.security_version !== user.security_version || fresh.password_hash !== user.password_hash || fresh.disabled_at != null || fresh.deleted_at != null || typeof body.recoveryCode !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/.test(body.recoveryCode)) throw fail();
    const recovered = repo.completeRecovery({ userId: user.id, code: body.recoveryCode, at: now() }, () => {
      repo.clearTotp({ userId: user.id, at: now() });
      repo.changePassword({ userId: user.id, passwordHash: fresh.password_hash, mustChangePassword: true, at: now() });
      repo.setLoginPolicy({ userId: user.id, policy: 'strict', at: now() });
      return setupChallenge(repo.findUserById(user.id), { meta: { ephemeral: true, deviceLabel: 'Recovery' }, requirePassword: true, requireFactor: true, mode: 'recovery' });
    });
    if (!recovered) throw fail();
    return recovered.result;
  }
  function me(req) {
    req.allowFactorSetup = true;
    const authenticated = authenticateRequest(req);
    return { requiresFactorSetup: needsFactorSetup(authenticated.user), optionalFactorSetup, user: publicUser(authenticated.user), sessionId: authenticated.session.id, expiresAt: authenticated.session.expires_at, idleExpiresAt: authenticated.session.idle_expires_at, csrfToken: csrfFor(authenticated.token) };
  }
  function logout(req) {
    req.allowFactorSetup = true;
    const authenticated = authenticateRequest(req); requireCsrf(req, authenticated);
    repo.revokeSession({ sessionId: authenticated.session.id, userId: authenticated.user.id, at: now() });
    audit('session.revoked', authenticated.user.id, req, { actorSessionId: authenticated.session.id });
    return authenticated.context;
  }
  function cookieOptions(ephemeral, expiresAt) { return { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', ...(ephemeral ? {} : { maxAge: Math.max(0, expiresAt - now()) }) }; }
  return { verificationMethod, verifyPassword: passwordWork, keyId, setEmailVerification(service) { emailVerification=service; }, get emailVerification() { return emailVerification; }, login, completeLogin, startSetup, completeSetup, startPostLoginSetup, completePostLoginSetup, skipPostLoginSetup, startRecovery, me, logout, authenticateRequest, requireCsrf, requireOrigin: origin, cookieName, cookieOptions };
}
module.exports = { createAuthService, AuthError };
