'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const { openDatabase } = require('../../src/db'); const { SECURITY_MIGRATION } = require('../../src/db/schema'); const { createRepositories } = require('../../src/db/repositories');
const p = require('../../src/security/primitives'); const { createAuthService } = require('../../src/security/auth-service');
for (const optionalFactorSetup of [false, true]) test(`post-entry QR enrollment, optional=${optionalFactorSetup}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-qr-'));
  const db = openDatabase({ storageRoot: root, migrations: [SECURITY_MIGRATION] });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = createRepositories(db); let at = Date.now();
  const service = createAuthService({ repo, allowedOrigins: ['https://test.local'], encryptionKey: crypto.randomBytes(32), keyId: 'test', now: () => at, postLoginFactorSetup: true, optionalFactorSetup });
  const password = 'synthetic-password-for-qr';
  const user = repo.createUser({ username: 'qr-admin', displayName: 'QR', role: 'admin', mustChangePassword: false, passwordHash: await p.hashPassword(password) });
  const login = await service.login({ body: { username: user.username, password }, headers: { origin: 'https://test.local' } });
  assert.equal(login.requiresFactorSetup, true);
  const req = body => ({ body, headers: { origin: 'https://test.local', cookie: `__Host-dn_session=${login.token}` } });
  const me = service.me(req({})); assert.equal(me.requiresFactorSetup, true);
  const write = body => { const request = req(body); request.headers['x-csrf-token'] = me.csrfToken; return request; };
  if (optionalFactorSetup) { assert.equal(service.authenticateRequest(req({})).user.id, user.id); assert.equal(service.skipPostLoginSetup(write({})).skipped, true); }
  else { assert.throws(() => service.authenticateRequest(req({}))); assert.throws(() => service.skipPostLoginSetup(write({}))); }
  const staged = await service.startPostLoginSetup(write({}));
  assert.match(staged.qrCode, /^data:image\/png;base64,/); assert.equal(new URL(staged.uri).searchParams.get('secret'), staged.secret);
  assert.throws(() => service.completePostLoginSetup(write({ challenge: staged.challenge, code: 'bad' })));
  const complete = service.completePostLoginSetup(write({ challenge: staged.challenge, code: p.generateTotp(staged.secret, { now: at }) }));
  assert.equal(complete.recoveryCodes.length, 10); assert.equal(service.authenticateRequest(req({})).session.auth_strength, 'totp');
  assert.equal(service.me(req({})).requiresFactorSetup, false);
  assert.throws(() => service.completePostLoginSetup(write({ challenge: staged.challenge, code: p.generateTotp(staged.secret, { now: at }) })));
  const nextLogin = await service.login({ body: { username: user.username, password }, headers: { origin: 'https://test.local' } });
  assert.equal(nextLogin.requiresSecondFactor, true);
});
