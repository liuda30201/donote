'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../../src/db');
const { ACCOUNT_MIGRATIONS } = require('../../src/db/schema');
const { createRepositories } = require('../../src/db/repositories');

test('upgrades email challenge purposes without losing existing challenges', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dn-email-migration-'));
  let db;
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db = openDatabase({ storageRoot: root, migrations: ACCOUNT_MIGRATIONS.slice(0, 4) });
  const repo = createRepositories(db);
  const user = repo.createUser({ username: 'migration-email', displayName: 'Migration Email', passwordHash: 'test-hash' });
  assert.equal(repo.email.reserve({ userId: user.id, token: 'existing-token', codeHash: 'existing-code-hash', purpose: 'login', target: {}, version: user.security_version, at: 1000 }), true);
  const existing = db.prepare('SELECT * FROM email_challenges').get();
  db.close();

  db = openDatabase({ storageRoot: root, migrations: ACCOUNT_MIGRATIONS });
  assert.deepEqual(db.prepare('SELECT * FROM email_challenges').get(), existing);
  const upgraded = createRepositories(db);
  assert.equal(upgraded.email.reserve({ userId: user.id, token: 'new-email-code-token', codeHash: 'new-email-code-hash', purpose: 'email-code-login', target: {}, version: user.security_version, at: 61000 }), true);
  assert.equal(db.prepare('SELECT count(*) AS count FROM email_challenges').get().count, 2);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
