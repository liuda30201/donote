'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../../src/db');
const { SECURITY_MIGRATION } = require('../../src/db/schema');
const { createRepositories } = require('../../src/db/repositories');
const { createAdminService } = require('../../src/security/admin');
const p = require('../../src/security/primitives');
async function realFixture(t) {
  const f=setup(t); let clock=300000;
  const password='Strong-admin-password-123';
  const admin=f.repo.createUser({username:'realadmin',displayName:'Admin',role:'admin',passwordHash:await p.hashPassword(password),at:clock});
  const secret=p.generateTotpSecret();
  f.repo.setPendingTotp({userId:admin.id,encryptedSecret:JSON.stringify(p.encryptSecret(secret,f.key,{userId:admin.id,purpose:'totp-secret',keyId:'test'}))});
  f.repo.withTotpCounter({userId:admin.id,counter:8,enroll:true,at:clock},()=>true);
  const session=f.repo.createSession({userId:admin.id,token:p.generateToken(),csrfToken:p.generateToken(),authStrength:'totp',createdAt:clock,idleExpiresAt:clock+1000000,expiresAt:clock+2000000});
  const authService={authenticateRequest(){const user=f.repo.findUserById(admin.id);const live=f.repo.activeSession(session.id,admin.id,clock);if(!live)throw Object.assign(new Error(),{status:401,code:'AUTH_FAILED'});return {user,session:live,context:{securityVersion:user.security_version}};},requireOrigin(req){if(req.headers.origin!=='https://test')throw Object.assign(new Error(),{status:403,code:'ORIGIN_REJECTED'});},requireCsrf(req){if(req.headers['x-csrf-token']!=='csrf')throw Object.assign(new Error(),{status:403,code:'CSRF_REJECTED'});}};
  const service=createAdminService({authService,repo:f.repo,encryptionKey:f.key,keyId:'test',now:()=>clock});
  const req=(body={},params={})=>({body,params,headers:{origin:'https://test','x-csrf-token':'csrf'},ip:'127.0.0.1'});
  async function grant(action,targetUserId,values){clock+=30000;return service.reauth(req({action,targetUserId,values,password,code:p.generateTotp(secret,{now:clock})}));}
  return {...f,admin,service,authService,req,grant,code(){return p.generateTotp(secret,{now:clock});},password,advance(ms){clock+=ms;}};
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'donote-admin-')); const db = openDatabase({ storageRoot: root, migrations: [SECURITY_MIGRATION] }); const repo = createRepositories(db);
  t.after(() => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { repo, key: crypto.randomBytes(32) };
}
function request(auth, body = {}, headers = {}) { return { body, headers, ip: '127.0.0.1', app: { get() {} } }; }
function serviceFixture(t) {
  const f = setup(t); const admin = f.repo.createUser({ username: 'admin', displayName: 'Admin', passwordHash: '$argon2id$hash', role: 'admin', at: 100000 });
  const session = f.repo.createSession({ userId: admin.id, token: 'A'.repeat(32), csrfToken: 'B'.repeat(32), authStrength: 'totp', createdAt: 100000, idleExpiresAt: 200000, expiresAt: 300000 });
  const auth = { context: { userId: admin.id, sessionId: session.id, role: 'admin', securityVersion: admin.security_version, authStrength: 'totp' }, user: admin, session, token: 'A'.repeat(32) };
  const authService = { authenticateRequest() { return auth; }, requireOrigin() {}, requireCsrf() {} };
  const secret = JSON.stringify({});
  f.repo.setPendingTotp({ userId: admin.id, encryptedSecret: secret });
  const service = createAdminService({ authService, repo: f.repo, encryptionKey: f.key, keyId: 'test', now: () => 100100 });
  return { ...f, admin, session, auth, authService, service };
}
test('rejects non-admin access and invalid page values', t => {
  const f = setup(t); const user = f.repo.createUser({ username: 'userone', displayName: 'User', passwordHash: '$argon2id$hash', at: 100000 });
  const authService = { authenticateRequest() { return { user, session: { auth_strength: 'totp', is_ephemeral: 0 }, context: {} }; }, requireOrigin() {} };
  const service = createAdminService({ authService, repo: f.repo, encryptionKey: crypto.randomBytes(32), keyId: 'test' });
  assert.throws(() => service.users(request(authService)), { code: 'ADMIN_FACTOR_REQUIRED' });
  assert.throws(() => service.users({ ...request(authService), query: { limit: '101' } }), { code: 'ADMIN_FACTOR_REQUIRED' });
});
test('lists only repository summaries and enforces exact admin factor', t => {
  const f = serviceFixture(t); const result = f.service.users(request(f.authService));
  assert.ok(Array.isArray(result.users)); assert.equal('password_hash' in result.users[0], false);
  f.auth.session.auth_strength = 'password'; assert.throws(() => f.service.users(request(f.authService)), { code: 'ADMIN_FACTOR_REQUIRED' });
});
test('admin reauth creates users and grant is single-use', async t => {
  const f=await realFixture(t); const values={username:'manageduser',displayName:'Managed',role:'user',password:'Managed-password-123'}; const grant=await f.grant('admin.user.create',null,values); const req=f.req(values);req.headers['x-operation-grant']=grant.grant; const result=await f.service.create(req); assert.equal(result.success,true); assert.equal(f.repo.findUserByUsername('manageduser').must_change_password,1); assert.equal(f.repo.listUsers({}).some(row=>row.password_hash),false); await assert.rejects(f.service.create(req),{code:'GRANT_REJECTED'});
});
test('disable binds exact values and invalidates target session and recovery', async t=>{
  const f=await realFixture(t);const user=f.repo.createUser({username:'targetuser',displayName:'Target',passwordHash:'internal'});const session=f.repo.createSession({userId:user.id,token:'T'.repeat(32),csrfToken:'C'.repeat(32),createdAt:300000,idleExpiresAt:1000000,expiresAt:2000000});f.repo.addRecoveryCodes(user.id,['Z'.repeat(32)]);
  const g=await f.grant('admin.user.disable',user.id,{disabled:true});const req=f.req({disabled:false},{id:user.id});req.headers['x-operation-grant']=g.grant;await assert.rejects(f.service.disable(req),{code:'GRANT_REJECTED'});req.body.disabled=true;assert.equal((await f.service.disable(req)).success,true);assert.equal(f.repo.findSessionByToken('T'.repeat(32),340000),null);assert.equal(f.repo.consumeRecoveryCode({userId:user.id,code:'Z'.repeat(32)}),false);
});
test('rejects stale target versions and expired admin grants',async t=>{
  const f=await realFixture(t);const user=f.repo.createUser({username:'targetuser',displayName:'Target',passwordHash:'internal'});const g=await f.grant('admin.user.role',user.id,{role:'admin'});f.repo.setRole({userId:user.id,role:'user'});const req=f.req({role:'admin'},{id:user.id});req.headers['x-operation-grant']=g.grant;await assert.rejects(f.service.role(req),{code:'GRANT_REJECTED'});
  const next=await f.grant('admin.user.disable',user.id,{disabled:true});const req2=f.req({disabled:true},{id:user.id});req2.headers['x-operation-grant']=next.grant;f.advance(120001);await assert.rejects(f.service.disable(req2),{code:'GRANT_REJECTED'});
});
test('last admin rollback preserves administrator and consumes no mutation',async t=>{
  const f=await realFixture(t);const g=await f.grant('admin.user.disable',f.admin.id,{disabled:true});const req=f.req({disabled:true},{id:f.admin.id});req.headers['x-operation-grant']=g.grant;await assert.rejects(f.service.disable(req),{code:'LAST_ADMIN'});assert.equal(f.repo.findUserById(f.admin.id).disabled_at,null);await assert.rejects(f.service.disable(req),{code:'LAST_ADMIN'});
});
test('admin reset hashes password and preserves enabled TOTP',async t=>{
  const f=await realFixture(t);const user=f.repo.createUser({username:'resetuser',displayName:'Reset',passwordHash:'internal'});f.repo.setPendingTotp({userId:user.id,encryptedSecret:'cipher'});f.repo.withTotpCounter({userId:user.id,counter:1,enroll:true},()=>true);const values={password:'New-reset-password-123'};const g=await f.grant('admin.user.reset-password',user.id,values);const req=f.req(values,{id:user.id});req.headers['x-operation-grant']=g.grant;const result=await f.service.resetPassword(req);assert.equal(result.user.mustChangePassword,true);assert.ok(await p.verifyPassword(values.password,f.repo.findUserById(user.id).password_hash));assert.notEqual(f.repo.getTotpCredential(user.id),null);
});
test('reauth rejects Origin, CSRF and TOTP replay',async t=>{
 const f=await realFixture(t);const values={username:'originuser',displayName:'Origin',role:'user',password:'Origin-password-123'};const bad=f.req({action:'admin.user.create',values,password:f.password,code:f.code()});bad.headers.origin='https://evil';await assert.rejects(f.service.reauth(bad),{code:'ORIGIN_REJECTED'});const csrf=f.req({action:'admin.user.create',values,password:f.password,code:f.code()});csrf.headers['x-csrf-token']='bad';await assert.rejects(f.service.reauth(csrf),{code:'CSRF_REJECTED'});const g=await f.grant('admin.user.create',null,values);await assert.rejects(f.service.reauth(f.req({action:'admin.user.create',values,password:f.password,code:f.code()})),{code:'AUTH_FAILED'});const req=f.req(values);req.headers['x-operation-grant']=g.grant;await f.service.create(req);await assert.rejects(f.service.create(req),{code:'GRANT_REJECTED'});
});
test('requires explicit encryption key and key id', () => {
  assert.throws(() => createAdminService({ authService: {}, repo: {}, encryptionKey: Buffer.alloc(1), keyId: 'x' }), TypeError);
});
