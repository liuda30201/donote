'use strict';
const crypto=require('node:crypto');
const {AuthError}=require('./auth-service');
const {EMAIL_REAUTH_ACTIONS}=require('./operations');
const p=require('./primitives');
function createEmailVerification({repo,authService,mailer,encryptionKey,now=Date.now}) {
  const fail=()=>new AuthError(401,'AUTH_FAILED');
  const source=req=>String(req.ip||req.socket?.remoteAddress||'unknown').slice(0,128);
  const sourceHash=req=>crypto.createHmac('sha256',encryptionKey).update(`registration-source:${source(req)}`).digest('hex');
  const codeHash=(token,code)=>crypto.createHmac('sha256',encryptionKey).update(`email-code:${token}:${code}`).digest('hex');
  const mask=email=>email ? `${email.slice(0,1)}***@${email.split('@')[1]}` : null;
  function normalize(value) { if(typeof value!=='string'||value.length>254||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value.trim()))throw new AuthError(400,'INVALID_EMAIL'); return value.trim().toLowerCase(); }
  const buckets=new Map();
  function rate(req, scope = '') {const at=now();for(const [k,v]of buckets)if(v.until<=at)buckets.delete(k);const ip=String(req.ip||req.socket?.remoteAddress||'unknown');const keys=[`ip:${ip}`,...(scope?[`scope:${scope}`]:[])];if(buckets.size>=10000)throw new AuthError(429,'AUTH_RATE_LIMIT');for(const key of keys){const b=buckets.get(key)||{n:0,until:at+3600000};const cap=key.startsWith('ip:')?30:10;if(b.n>=cap)throw new AuthError(429,'AUTH_RATE_LIMIT');b.n++;buckets.set(key,b);}}
  async function send(req,{user,email,purpose,sessionId=null,target={}}) {
    rate(req);
    if(!mailer?.available)throw new AuthError(503,'MAIL_UNAVAILABLE');
    const token=p.generateToken(),code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),at=now();
    if(!repo.email.reserve({userId:user.id,token,codeHash:codeHash(token,code),purpose,sessionId,target,version:user.security_version,at}))throw new AuthError(429,'EMAIL_RATE_LIMIT');
    try {await mailer.sendCode({to:email,code,purpose});} catch {repo.email.cancel(token,now());throw new AuthError(503,'MAIL_UNAVAILABLE');}
    if(!repo.email.find(token,now()))throw fail();
    return {challenge:token,expiresAt:at+300000,emailHint:mask(email)};
  }
  function validateRegistration(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AuthError(400,'INVALID_REGISTRATION');
    const email = normalize(payload.email);
    const username = email.split('@')[0];
    if (!username || username.length > 64) throw new AuthError(400,'INVALID_REGISTRATION');
    return { username, displayName: username, email };
  }
  let registrationWorkers = 0;
  async function startRegistration(req) {
    originCheck(req);
    if (registrationWorkers >= 2) throw new AuthError(503,'AUTH_BUSY');
    registrationWorkers++;
    try { return await prepareRegistration(req); }
    finally { registrationWorkers--; }
  }
  async function prepareRegistration(req) {
    rate(req);
    if (!mailer?.available) throw new AuthError(503,'MAIL_UNAVAILABLE');
    const {username,displayName,email}=validateRegistration(req.body);
    const password = req.body?.password;
    try { p.validateNewPassword(password, email); } catch { throw new AuthError(400,'PASSWORD_POLICY'); }
    const ipHash=sourceHash(req);
    if (repo.email.registrationCount(ipHash,now()) >= 10) throw new AuthError(429,'REGISTRATION_RATE_LIMIT');
    let passwordHash;
    try { passwordHash = await p.hashPassword(password); } catch { throw new AuthError(400,'PASSWORD_POLICY'); }
    const token=p.generateToken(),code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),at=now();
    if (!repo.email.reserveRegistration({token,username,displayName,email,sourceHash:sourceHash(req),passwordHash,codeHash:codeHash(token,code),at})) throw new AuthError(429,'REGISTRATION_RATE_LIMIT');
    try { await mailer.sendCode({to:email,code,purpose:'account registration'}); }
    catch { repo.email.cancelRegistration(token,now()); throw new AuthError(503,'MAIL_UNAVAILABLE'); }
    if (!repo.email.findRegistration(token,now())) throw fail();
    return {success:true,challenge:token,expiresAt:at+300000,emailHint:mask(email)};
  }
  function completeRegistration(req) {
    originCheck(req);
    rate(req);
    const body=req.body||{};
    const row=repo.email.findRegistration(body.challenge,now());
    if(!row) throw fail();
    if(typeof body.code !== 'string' || !/^[0-9]{6}$/.test(body.code) || !p.constantTimeEqual(row.code_hash,codeHash(body.challenge,body.code))){repo.email.registrationFailure(body.challenge);throw fail();}
    try {
      const result=repo.email.consumeRegistration(body.challenge,now(),entry=>{
        const user=repo.createUser({username:entry.username,displayName:entry.display_name,passwordHash:entry.password_hash,role:'user',emailAccount:true,mustChangePassword:false,at:now()});
        repo.email.setInitialPreference({userId:user.id,email:entry.email,at:now()});
        repo.addAudit({actorId:user.id,targetId:user.id,action:'user.created',ipAddress:source(req),at:now(),detail:{reason:'self-registration',authMethod:'email'}});
        return {success:true};
      });
      if(!result)throw fail();
      return result.result;
    } catch(error) {
      if(error.code==='USER_CONFLICT'||error.code==='EMAIL_CONFLICT'||error.code==='SQLITE_CONSTRAINT_UNIQUE') throw new AuthError(409,'REGISTRATION_UNAVAILABLE');
      throw error;
    }
  }
  function originCheck(req) { if(!authService) throw new AuthError(503,'AUTH_UNAVAILABLE'); authService.requireOrigin(req); }
  function check(token,code,{userId,purpose,sessionId=null,target}={}) {
    const row=repo.email.find(token,now());
    if(!row||row.purpose!==purpose||row.session_id!==sessionId||(userId&&row.user_id!==userId)||(target!==undefined&&row.target!==JSON.stringify(target)))throw fail();
    if(typeof code!=='string'||!/^\d{6}$/.test(code)||!p.constantTimeEqual(row.code_hash,codeHash(token,code))) {repo.email.failure(token);throw fail();}
    return row;
  }
  function consume(token,code,scope,mutation) {check(token,code,scope);const r=repo.email.consume(token,now(),mutation);if(!r)throw fail();return r.result;}
  function current(req){const c=authService.authenticateRequest(req);authService.requireCsrf(req,c);return c;}
  async function verifyCurrent(req,c) {
    rate(req);
    const expected=c.user;
    if(!await authService.verifyPassword(req.body?.password,expected.password_hash))throw fail();
    const fresh=repo.findUserById(expected.id);
    if(!repo.activeSession(c.session.id,expected.id,now())||fresh.security_version!==expected.security_version||fresh.password_hash!==expected.password_hash)throw fail();
    const method=authService.verificationMethod(fresh);
    if(method==='totp') {
      const factor=repo.getTotpCredential(fresh.id);let counter=null;
      try {const secret=p.decryptSecret(JSON.parse(factor.encrypted_secret),encryptionKey,{userId:fresh.id,purpose:'totp-secret',keyId:authService.keyId});counter=p.verifyTotp(secret,req.body.code,{now:now()});}catch{}
      if(counter===null||!repo.withTotpCounter({userId:fresh.id,counter,at:now()},()=>true))throw fail();
    } else if(method==='email') consume(req.body.emailChallenge,req.body.code,{userId:fresh.id,purpose:'reauth',sessionId:c.session.id,target:{action:'verification.change'}},()=>true);
    return c;
  }
  function settings(req) {const c=authService.authenticateRequest(req),pref=repo.email.preference(c.user.id);return {method:authService.verificationMethod(c.user),emailHint:mask(pref?.email),emailAvailable:Boolean(mailer?.available),managed:c.user.role==='admin'||c.user.login_policy==='strict'};}
  function registrationAvailable() { return Boolean(mailer?.available); }
  async function sendReauth(req){const c=current(req),pref=repo.email.preference(c.user.id);if(authService.verificationMethod(c.user)!=='email'||!pref?.email_verified_at)throw fail();const action=req.body?.action;if(!EMAIL_REAUTH_ACTIONS.has(action))throw new AuthError(400,'INVALID_ACTION');return send(req,{user:c.user,email:pref.email,purpose:'reauth',sessionId:c.session.id,target:{action,...(req.body.targetSessionId?{targetSessionId:req.body.targetSessionId}:{})}});}
  async function startBind(req){const c=current(req);if(c.session.is_ephemeral)throw new AuthError(403,'TEMPORARY_SESSION');if(c.user.role==='admin'||c.user.login_policy==='strict')throw new AuthError(403,'MFA_POLICY_REQUIRED');const email=normalize(req.body?.email);await verifyCurrent(req,c);return send(req,{user:c.user,email,purpose:'bind',sessionId:c.session.id,target:{email}});}
  function confirmBind(req){const c=current(req);if(c.session.is_ephemeral)throw new AuthError(403,'TEMPORARY_SESSION');if(c.user.role==='admin'||c.user.login_policy==='strict')throw new AuthError(403,'MFA_POLICY_REQUIRED');consume(req.body?.challenge,req.body?.code,{userId:c.user.id,purpose:'bind',sessionId:c.session.id},row=>{let email;try{const parsed=JSON.parse(row.target);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||typeof parsed.email!=='string')throw fail();email=normalize(parsed.email);if(email!==parsed.email)throw fail();}catch{throw fail();}try { repo.email.setPreference({userId:c.user.id,method:'email',email,at:now()}); } catch(error) { if(error.code==='EMAIL_CONFLICT') throw new AuthError(409,'EMAIL_CONFLICT'); throw error; }repo.addAudit({actorId:c.user.id,targetId:c.user.id,action:'security.factor_changed',at:now(),detail:{authMethod:'email'}});});return {success:true,requiresLogin:true};}
  async function change(req){const c=current(req);if(c.session.is_ephemeral)throw new AuthError(403,'TEMPORARY_SESSION');if(c.user.role==='admin'||c.user.login_policy==='strict')throw new AuthError(403,'MFA_POLICY_REQUIRED');const method=req.body?.method;if(!['password','totp','email'].includes(method))throw new AuthError(400,'INVALID_METHOD');if(method==='email'){const pref=repo.email.preference(c.user.id);if(!pref?.email_verified_at||!pref.email)throw new AuthError(400,'EMAIL_NOT_VERIFIED');}if(method==='totp'&&repo.getTotpCredential(c.user.id)?.enabled_at==null)throw new AuthError(400,'TOTP_SETUP_REQUIRED');await verifyCurrent(req,c);if(method==='email')repo.email.setPreference({userId:c.user.id,method,email:undefined,at:now()});else repo.email.setPreference({userId:c.user.id,method,at:now()});repo.addAudit({actorId:c.user.id,targetId:c.user.id,action:'security.factor_changed',at:now(),detail:{authMethod:method}});return {success:true,requiresLogin:true};}
  return {send,check,consume,settings,registrationAvailable,sendReauth,startBind,confirmBind,change,startRegistration,completeRegistration};
}
module.exports={createEmailVerification};
