'use strict';
const { createHash, randomUUID } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
function createEmailRepository(db) {
  const enabled = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='verification_preferences'").get());
  const tx = db.transaction(fn => fn()).immediate;
  function preference(userId) { return enabled ? db.prepare('SELECT * FROM verification_preferences WHERE user_id=?').get(userId) || null : null; }
  function emailInUse(email) { return enabled && Boolean(db.prepare('SELECT 1 FROM verification_preferences WHERE email=? COLLATE NOCASE LIMIT 1').get(email)); }
  function setInitialPreference({userId, email, at}) {
    if (!enabled) throw new Error('Email verification schema unavailable');
    db.prepare('INSERT INTO verification_preferences(user_id,method,email,email_verified_at,updated_at) VALUES (? ,\'password\',?,?,?)').run(userId, email, at, at);
  }
  function setPreference({userId, method, email, at}) {
    if (!['password','email','totp'].includes(method)) throw new TypeError('Invalid verification method');
    const previous = preference(userId);
    const address = email === undefined ? previous?.email || null : email;
    if (method === 'email' && !address) throw new Error('Verified email required');
    return tx(() => {
      if (address && db.prepare('SELECT 1 FROM verification_preferences WHERE email=? COLLATE NOCASE AND user_id<>? LIMIT 1').get(address,userId)) { const error = new Error('Email already in use'); error.code = 'EMAIL_CONFLICT'; throw error; }
      db.prepare('INSERT INTO verification_preferences(user_id,method,email,email_verified_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET method=excluded.method,email=excluded.email,email_verified_at=excluded.email_verified_at,updated_at=excluded.updated_at').run(userId,method,address,address ? (email === undefined ? previous.email_verified_at : at) : null,at);
      db.prepare('UPDATE users SET security_version=security_version+1,updated_at=? WHERE id=?').run(at,userId);
      db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?').run(at,userId);
      db.prepare('UPDATE email_challenges SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=?').run(at,userId);
      db.prepare('UPDATE login_challenges SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=?').run(at,userId);
      db.prepare('UPDATE operation_grants SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=?').run(at,userId);
      return preference(userId);
    });
  }
  function reserve({userId,token,codeHash,purpose,sessionId=null,target,version,at}) {
    return tx(() => {
      const recent=db.prepare('SELECT created_at FROM email_challenges WHERE user_id=? AND purpose=? AND security_version=? ORDER BY created_at DESC LIMIT 1').get(userId,purpose,version);
      if (recent && at-recent.created_at<60000) return false;
      const count=db.prepare('SELECT count(*) AS n FROM email_challenges WHERE user_id=? AND created_at>?').get(userId,at-3600000).n;
      if(count>=10) return false;
      db.prepare('UPDATE email_challenges SET consumed_at=? WHERE user_id=? AND purpose=? AND session_id IS ? AND consumed_at IS NULL').run(at,userId,purpose,sessionId);
      db.prepare('INSERT INTO email_challenges(id,user_id,token_hash,code_hash,purpose,session_id,target,security_version,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),userId,digest(token),codeHash,purpose,sessionId,JSON.stringify(target),version,at,at+300000);
      return true;
    });
  }
  function find(token,at) {
    if(!enabled || typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.prepare('SELECT c.* FROM email_challenges c JOIN users u ON c.user_id=u.id WHERE token_hash=? AND consumed_at IS NULL AND attempts<5 AND c.expires_at>? AND c.created_at<=? AND c.security_version=u.security_version AND u.disabled_at IS NULL AND u.deleted_at IS NULL').get(digest(token),at,at)||null;
  }
  function failure(token) { db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE token_hash=? AND consumed_at IS NULL').run(digest(token)); }
  function cancel(token,at) { db.prepare('UPDATE email_challenges SET consumed_at=? WHERE token_hash=?').run(at,digest(token)); }
  function cancelRegistration(token,at) { db.prepare('UPDATE registration_challenges SET consumed_at=? WHERE token_hash=?').run(at,digest(token)); }
  function consume(token,at,mutation) { return tx(() => { const row=find(token,at); if(!row)return null; db.prepare('UPDATE email_challenges SET consumed_at=? WHERE id=?').run(at,row.id); const result=mutation(row); if(result?.then)throw new TypeError('Synchronous transaction required'); return {result}; }); }
  function prove(sessionId,userId,version,at) { db.prepare('INSERT OR REPLACE INTO email_session_proofs VALUES (?,?,?,?)').run(sessionId,userId,version,at); }
  function hasProof(sessionId,userId,version) { return enabled && Boolean(db.prepare('SELECT 1 FROM email_session_proofs WHERE session_id=? AND user_id=? AND security_version=?').get(sessionId,userId,version)); }
  function activateTotp(userId,sessionId,at) {
    if(!enabled)return;
    db.prepare("INSERT INTO verification_preferences(user_id,method,updated_at) VALUES (?,'totp',?) ON CONFLICT(user_id) DO UPDATE SET method='totp',updated_at=excluded.updated_at").run(userId,at);
    db.prepare('UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND id<>?').run(at,userId,sessionId);
    db.prepare('UPDATE email_challenges SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=?').run(at,userId);
  }
  function registrationCount(sourceHash, at) { return enabled ? db.prepare('SELECT count(*) AS n FROM registration_challenges WHERE source_hash=? AND created_at>?').get(sourceHash, at-3600000).n : 0; }
  function reserveRegistration({token, username, displayName, email, sourceHash, passwordHash, codeHash, at}) {
    if (!enabled) return false;
    return tx(() => {
      db.prepare('DELETE FROM registration_challenges WHERE created_at<=?').run(at-3600000);
      const recent = db.prepare('SELECT created_at FROM registration_challenges WHERE email=? AND consumed_at IS NULL AND created_at>? ORDER BY created_at DESC LIMIT 1').get(email, at - 60000);
      if (recent) return false;
      const count = db.prepare('SELECT count(*) AS n FROM registration_challenges WHERE email=? AND created_at>?').get(email, at - 3600000).n;
      if (count >= 5 || registrationCount(sourceHash, at) >= 10) return false;
      db.prepare('UPDATE registration_challenges SET blocked=1 WHERE email=? AND consumed_at IS NULL').run(email);
      db.prepare('INSERT INTO registration_challenges(id,token_hash,username,display_name,email,source_hash,password_hash,code_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), digest(token), username, displayName, email, sourceHash, passwordHash, codeHash, at, at + 300000);
      return true;
    });
  }
  function findRegistration(token, at) {
    if (!enabled || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.prepare('SELECT * FROM registration_challenges WHERE token_hash=? AND consumed_at IS NULL AND blocked=0 AND attempts<5 AND expires_at>? AND created_at<=?').get(digest(token), at, at) || null;
  }
  function registrationFailure(token) { db.prepare('UPDATE registration_challenges SET attempts=attempts+1,blocked=CASE WHEN attempts+1>=5 THEN 1 ELSE blocked END WHERE token_hash=? AND consumed_at IS NULL').run(digest(token)); }
  function consumeRegistration(token, at, mutation) {
    return tx(() => {
      const row = findRegistration(token, at);
      if (!row) return null;
      const conflict = emailInUse(row.email);
      db.prepare('UPDATE registration_challenges SET consumed_at=? WHERE id=?').run(at, row.id);
      if (conflict) return { result: { success: true } };
      const result = mutation(row);
      if (result?.then) throw new TypeError('Synchronous transaction required');
      return { result };
    });
  }
  return { preference,emailInUse,setInitialPreference,setPreference,reserve,find,failure,cancel,consume,prove,hasProof,activateTotp,registrationCount,reserveRegistration,findRegistration,registrationFailure,consumeRegistration,cancelRegistration };
}
module.exports={createEmailRepository};
