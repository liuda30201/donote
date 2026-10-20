'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase } = require('../../src/db');
const { ACCOUNT_MIGRATIONS } = require('../../src/db/schema');
const { createRepositories } = require('../../src/db/repositories');
const { initializeAdmin } = require('../../src/security/bootstrap-admin');
const { createAuthService } = require('../../src/security/auth-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-admin-'));
  const db = openDatabase({ storageRoot: root, migrations: ACCOUNT_MIGRATIONS });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repo = createRepositories(db);
  const env = { ADMIN_EMAIL: 'Admin@Example.com', ADMIN_PASSWORD: 'Bootstrap-password-2026!' };
  return { db, repo, env };
}

test('environment admin uses email login and requires enrollment before private access', async t => {
  const f = fixture(t);
  assert.equal(await initializeAdmin(f), true);
  const user = f.repo.findUserByEmail('admin@example.com');
  assert.equal(user.role, 'admin');
  assert.equal(f.repo.findUserByUsername('admin'), null);
  assert.notEqual(user.password_hash, f.env.ADMIN_PASSWORD);
  const service = createAuthService({ repo: f.repo, allowedOrigins: ['https://test.local'], encryptionKey: crypto.randomBytes(32), keyId: 'test', postLoginFactorSetup: true });
  const result = await service.login({ body: { email: f.env.ADMIN_EMAIL, password: f.env.ADMIN_PASSWORD }, headers: { origin: 'https://test.local' } });
  assert.equal(result.requiresFactorSetup, true);
  assert.throws(() => service.authenticateRequest({ headers: { cookie: `__Host-dn_session=${result.token}` } }), { code: 'AUTH_FAILED' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('changed environment never overwrites existing credentials or creates another admin', async t => {
  const f = fixture(t);
  await initializeAdmin(f);
  const original = f.repo.findUserByEmail('admin@example.com');
  assert.equal(await initializeAdmin({ ...f, env: { ADMIN_EMAIL: 'other@example.com', ADMIN_PASSWORD: 'Replacement-password-2026!' } }), false);
  assert.deepEqual(f.repo.findUserByEmail('admin@example.com'), original);
  assert.equal(f.repo.findUserByEmail('other@example.com'), null);
});

test('invalid configuration creates no user and audit failure rolls initialization back', async t => {
  const f = fixture(t);
  assert.equal(await initializeAdmin({ ...f, env: {} }), false);
  await assert.rejects(initializeAdmin({ ...f, env: { ...f.env, ADMIN_EMAIL: 'invalid' } }));
  await assert.rejects(initializeAdmin({ ...f, env: { ADMIN_EMAIL: f.env.ADMIN_EMAIL } }));
  const addAudit = f.repo.addAudit;
  f.repo.addAudit = () => { throw new Error('audit unavailable'); };
  await assert.rejects(initializeAdmin(f), /audit unavailable/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM verification_preferences').get().n, 0);
  f.repo.addAudit = addAudit;
  assert.equal(await initializeAdmin(f), true);
});
