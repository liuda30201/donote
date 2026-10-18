'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const { openDatabase } = require('../../src/db'); const { SECURITY_MIGRATION } = require('../../src/db/schema'); const { createRepositories } = require('../../src/db/repositories');
const p = require('../../src/security/primitives'); const { createAuthService } = require('../../src/security/auth-service');

test('password await cannot issue challenge after concurrent security-version change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-race-'));
  const db = openDatabase({ storageRoot: root, migrations: [SECURITY_MIGRATION] }); t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = createRepositories(db); const password = 'synthetic-race-password';
  const user = base.createUser({ username: 'race-user', displayName: 'Race', passwordHash: await p.hashPassword(password) });
  let first = true; let challengeCreated = false;
  const repo = { ...base,
    findUserByUsername(name) {
      const snapshot = base.findUserByUsername(name);
      if (first) { first = false; queueMicrotask(() => base.revokeAllSessions({ userId: user.id })); }
      return snapshot;
    },
    createLoginChallenge(...args) { challengeCreated = true; return base.createLoginChallenge(...args); }
  };
  const service = createAuthService({ repo, allowedOrigins: ['https://test.local'], encryptionKey: crypto.randomBytes(32), keyId: 'test' });
  await assert.rejects(service.login({ body: { username: user.username, password }, headers: { origin: 'https://test.local' }, ip: '127.0.0.1' }), { code: 'AUTH_FAILED' });
  assert.equal(challengeCreated, false); assert.equal(base.listSessions(user.id).length, 0);
});
