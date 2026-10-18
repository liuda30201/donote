'use strict';
const crypto=require('node:crypto');
const {AuthError}=require('./auth-service');
const {EMAIL_REAUTH_ACTIONS}=require('./operations');
const p=require('./primitives');
function createEmailVerification({repo,authService,mailer,encryptionKey,now=Date.now}) {
  const fail=()=>new AuthError(401,'AUTH_FAILED');
  const codeHash=(token,code)=>crypto.createHmac('sha256',encryptionKey).update(`email-code:${token}:${code}`).digest('hex');
  const mask=email=>email ? `${email.slice(0,1)}***@${email.split('@')[1]}` : null;
  function normalize(value) { if(typeof value!=='string'||value.length>254||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value.trim()))throw new AuthError(400,'INVALID_EMAIL'); return value.trim().toLowerCase(); }
  const buckets=new Map();
  function rate(req) {const at=now();for(const [k,v]of buckets)if(v.until<=at)buckets.delete(k);const key=String(req.ip||req.socket?.remoteAddress||'unknown');const b=buckets.get(key)||{n:0,until:at+3600000};if(b.n>=30||buckets.size>=10000)throw new AuthError(429,'AUTH_RATE_LIMIT');b.n++;buckets.set(key,b);}
  async function send(req,{user,email,purpose,sessionId=null,target={}}) {
    rate(req);
    if(!mailer?.available)throw new AuthError(503,'MAIL_UNAVAILABLE');
    const token=p.generateToken(),code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),at=now();
    if(!repo.email.reserve({userId:user.id,token,codeHash:codeHash(token,code),purpose,sessionId,target,version:user.security_version,at}))throw new AuthError(429,'EMAIL_RATE_LIMIT');
    try {await mailer.sendCode({to:email,code,purpose});} catch {repo.email.cancel(token,now());throw new AuthError(503,'MAIL_UNAVAILABLE');}
    if(!repo.email.find(token,now()))throw fail();
    return {challenge:token,expiresAt:at+300000,emailHint:mask(email)};
  }
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
  async function sendReauth(req){const c=current(req),pref=repo.email.preference(c.user.id);if(authService.verificationMethod(c.user)!=='email'||!pref?.email_verified_at)throw fail();const action=req.body?.action;if(!EMAIL_REAUTH_ACTIONS.has(action))throw new AuthError(400,'INVALID_ACTION');return send(req,{user:c.user,email:pref.email,purpose:'reauth',sessionId:c.session.id,target:{action,...(req.body.targetSessionId?{targetSessionId:req.body.targetSessionId}:{})}});}
  async function startBind(req){const c=current(req);if(c.session.is_ephemeral)throw new AuthError(403,'TEMPORARY_SESSION');if(c.user.role==='admin'||c.user.login_policy==='strict')throw new AuthError(403,'MFA_POLICY_REQUIRED');const email=normalize(req.body?.email);await verifyCurrent(req,c);return send(req,{user:c.user,email,purpose:'bind',sessionId:c.session.id,target:{email}});}
  function confirmBind(req){const c=current(req);if(c.session.is_ephemeral)throw new AuthError(403,'TEMPORARY_SESSION');if(c.user.role==='admin'||c.user.login_policy==='strict')throw new AuthError(403,'MFA_POLICY_REQUIRED');consume(req.body?.challenge,req.body?.code,{userId:c.user.id,purpose:'bind',sessionId:c.session.id},row=>{let email;try{const parsed=JSON.parse(row.target);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||typeof parsed.email!=='string')throw fail();email=normalize(parsed.email);if(email!==parsed.email)throw fail();}catch{throw fail();}repo.email.setPreference({userId:c.user.id,method:'email',email,at:now()});repo.addAudit({actorId:c.user.id,targetId:c.user.id,action:'security.factor_changed',at:now(),detail:{authMethod:'email'}});});return {success:true,requiresLogin:true};}
  async function change(req){const c=current(req);if(c.session.is_ephemeral)throw new AuthError(403,'TEMPORARY_SESSION');if(c.user.role==='admin'||c.user.login_policy==='strict')throw new AuthError(403,'MFA_POLICY_REQUIRED');const method=req.body?.method;if(!['password','totp','email'].includes(method))throw new AuthError(400,'INVALID_METHOD');if(method==='email'){const pref=repo.email.preference(c.user.id);if(!pref?.email_verified_at||!pref.email)throw new AuthError(400,'EMAIL_NOT_VERIFIED');}if(method==='totp'&&repo.getTotpCredential(c.user.id)?.enabled_at==null)throw new AuthError(400,'TOTP_SETUP_REQUIRED');await verifyCurrent(req,c);if(method==='email')repo.email.setPreference({userId:c.user.id,method,email:undefined,at:now()});else repo.email.setPreference({userId:c.user.id,method,at:now()});repo.addAudit({actorId:c.user.id,targetId:c.user.id,action:'security.factor_changed',at:now(),detail:{authMethod:method}});return {success:true,requiresLogin:true};}
  return {send,check,consume,settings,sendReauth,startBind,confirmBind,change};
}
module.exports={createEmailVerification};
