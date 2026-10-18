'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { verifyPassword } = require('../src/security/primitives');
const tool = path.resolve(__dirname, '../scripts/accounts.js');
const backupTool = path.resolve(__dirname, '../../scripts/lib/backup-data.js');
const secret = 'Synthetic-only-Password-1234!';
const accountTool = require('../scripts/accounts');
async function migrationFixture(t) {
  const { root, data } = setup(t);
  fs.mkdirSync(path.join(data, 'uploads', 'files'), { recursive: true }); fs.writeFileSync(path.join(data, 'uploads', 'files', 'sample.txt'), 'Synthetic attachment');
  fs.writeFileSync(path.join(data, 'messages.json'), JSON.stringify({ messages: [{ type: 'file', content: { filePath: 'files/sample.txt' } }] }));
  const backup = path.join(root, 'backup.tar.gz'); assert.equal(spawnSync(process.execPath, [backupTool, data, backup]).status, 0);
  const init = run(data, 'init-admin', ['--offline-confirmed'], { username: 'migration-target', password: secret }); assert.equal(init.status, 0, init.stderr);
  const target = JSON.parse(init.stdout).userId;
  return { root, data, backup, target, args: ['migrate', '--data-dir', data, '--offline-confirmed', '--source-user', 'legacy', '--target-user', target, '--backup', backup] };
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'donote-migration-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('donote-migration-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  return { root, data };
}
function run(data, command, extra = [], input) {
  return spawnSync(process.execPath, [tool, command, '--data-dir', data, ...extra], { input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8' });
}
test('init-admin creates a real SQLite admin with Argon2id and audit, never emits secrets', async t => {
  const { data } = setup(t);
  const result = run(data, 'init-admin', ['--offline-confirmed'], { username: 'First.Admin', password: secret });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stdout.includes('$argon2'));
  const db = new Database(path.join(data, 'donote.db'));
  try {
    const user = db.prepare('SELECT * FROM users').get();
    assert.equal(user.role, 'admin'); assert.equal(user.username, 'first.admin');
    assert.equal(user.must_change_password, 1);
    assert.equal(await verifyPassword(secret, user.password_hash), true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, 1);
  } finally { db.close(); }
  const second = run(data, 'init-admin', ['--offline-confirmed'], { username: 'another', password: secret });
  assert.notEqual(second.status, 0);
  const check = new Database(path.join(data, 'donote.db')); assert.equal(check.prepare('SELECT count(*) AS n FROM users').get().n, 1); check.close();
});
test('init-admin rejects missing offline confirmation, weak password and argv password without emitting it', t => {
  const { data } = setup(t);
  for (const [flags, input] of [[[], { username: 'admin', password: secret }], [['--offline-confirmed'], { username: 'admin', password: 'short' }], [['--offline-confirmed', '--password', secret], {}]]) {
    const result = run(data, 'init-admin', flags, input);
    assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret));
  }
  assert.equal(fs.existsSync(path.join(data, 'donote.db')), false);
});
test('migration dry-run verifies existing account and real migration retains source with bound audit', t => {
  const { data, root } = setup(t);
  fs.writeFileSync(path.join(data, 'messages.json'), JSON.stringify({ messages: [{ type: 'text', content: '合成资料' }] }));
  const backup = path.join(root, 'backup.tar.gz');
  const made = spawnSync(process.execPath, [backupTool, data, backup], { encoding: 'utf8' }); assert.equal(made.status, 0, made.stderr);
  const flags = ['--offline-confirmed', '--source-user', 'legacy', '--target-user', '12345678-1234-4234-8234-123456789abc', '--backup', backup];
  assert.notEqual(run(data, 'migrate', [...flags, '--dry-run']).status, 0);
  assert.equal(fs.existsSync(path.join(data, 'donote.db')), false);
  const init = run(data, 'init-admin', ['--offline-confirmed'], { username: 'migration-admin', password: secret }); assert.equal(init.status, 0, init.stderr);
  const target = JSON.parse(init.stdout).userId; flags[flags.indexOf('--target-user') + 1] = target;
  const before = fs.readFileSync(path.join(data, 'messages.json'));
  const result = run(data, 'migrate', [...flags, '--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).executable, true);
  assert.deepEqual(fs.readFileSync(path.join(data, 'messages.json')), before);
  assert.equal(fs.existsSync(path.join(data, 'users')), false);
  const migrated = run(data, 'migrate', flags); assert.equal(migrated.status, 0, migrated.stderr);
  assert.deepEqual(fs.readFileSync(path.join(data, 'users', target, 'messages.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(data, 'messages.json')), before);
  const db = new Database(path.join(data, 'donote.db')); assert.equal(db.prepare('SELECT storage_bytes FROM users WHERE id=?').get(target).storage_bytes, before.length); assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='data.migrated'").get().n, 1); db.close();
  assert.notEqual(run(data, 'migrate', flags).status, 0);
  const recovered = run(data, 'migrate-recover', ['--offline-confirmed', '--migration-id', JSON.parse(migrated.stdout).migrationId]); assert.equal(recovered.status, 0, recovered.stderr);
  fs.writeFileSync(backup, 'corrupt'); assert.notEqual(run(data, 'migrate', [...flags, '--dry-run']).status, 0);
});
test('migration rollback after publication and recovery after committed journal interruption', async t => {
  const fixture = await migrationFixture(t); const { data, target, args } = fixture;
  await assert.rejects(accountTool.main(args, { afterPublish() { throw new Error('Injected after rename'); } }));
  assert.equal(fs.existsSync(path.join(data, 'users', target)), false);
  let db = new Database(path.join(data, 'donote.db')); assert.equal(db.prepare('SELECT storage_bytes FROM users WHERE id=?').get(target).storage_bytes, 0); assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='data.migrated'").get().n, 0); db.close();
  await assert.rejects(accountTool.main(args, { afterCommit() { throw new Error('Injected journal interruption'); } }));
  const home = path.join(data, '.account-migrations'); const pending = fs.readdirSync(home).find(id => JSON.parse(fs.readFileSync(path.join(home, id, 'journal.json'))).state === 'PREPARED'); assert.ok(pending);
  const result = run(data, 'migrate-recover', ['--offline-confirmed', '--migration-id', pending]); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).result, 'committed');
  assert.equal(fs.readFileSync(path.join(data, 'users', target, 'uploads', 'files', 'sample.txt'), 'utf8'), 'Synthetic attachment');
  assert.equal(fs.readFileSync(path.join(data, 'uploads', 'files', 'sample.txt'), 'utf8'), 'Synthetic attachment');
});
test('migration refuses backup/source drift, nonexistent accounts and audit failure', async t => {
  const { data, target, args } = await migrationFixture(t);
  const sourceFile = path.join(data, 'uploads', 'files', 'sample.txt'); fs.writeFileSync(sourceFile, 'Changed');
  await assert.rejects(accountTool.main([...args, '--dry-run']), /does not match/);
  fs.writeFileSync(sourceFile, 'Synthetic attachment');
  const missing = [...args]; missing[missing.indexOf('--target-user') + 1] = '12345678-1234-4234-8234-123456789abc'; await assert.rejects(accountTool.main(missing), /existing active empty/);
  const db = new Database(path.join(data, 'donote.db')); db.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON audit_log WHEN NEW.action='data.migrated' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END"); db.close();
  await assert.rejects(accountTool.main(args), /synthetic audit failure/);
  assert.equal(fs.existsSync(path.join(data, 'users', target)), false);
  const check = new Database(path.join(data, 'donote.db')); assert.equal(check.prepare('SELECT storage_bytes FROM users WHERE id=?').get(target).storage_bytes, 0); check.close();
});
test('SIGKILL after publication rolls SQLite back and recovery retracts destination', async t => {
  const { data, target, args } = await migrationFixture(t);
  const child = spawnSync(process.execPath, ['-e', "require(process.argv[1]).main(JSON.parse(process.argv[2]), {afterPublish() { process.kill(process.pid, 'SIGKILL'); }}).catch(() => process.exit(2))", tool, JSON.stringify(args)], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(data, 'users', target)), true);
  const home = path.join(data, '.account-migrations'); const id = fs.readdirSync(home)[0];
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, id, 'journal.json'))).state, 'PREPARED');
  const db = new Database(path.join(data, 'donote.db')); assert.equal(db.prepare("SELECT count(*) n FROM audit_log WHERE action='data.migrated'").get().n, 0); assert.equal(db.prepare('SELECT storage_bytes FROM users WHERE id=?').get(target).storage_bytes, 0); db.close();
  const recovered = run(data, 'migrate-recover', ['--offline-confirmed', '--migration-id', id]); assert.equal(recovered.status, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout).result, 'rolled_back');
  assert.equal(fs.existsSync(path.join(data, 'users', target)), false);
  assert.equal(fs.readFileSync(path.join(home, id, 'stage', 'uploads', 'files', 'sample.txt'), 'utf8'), 'Synthetic attachment');
  assert.equal(fs.readFileSync(path.join(data, 'uploads', 'files', 'sample.txt'), 'utf8'), 'Synthetic attachment');
});
test('migration rejects symlink and malformed journals before recovery', async t => {
  const { data, args, target } = await migrationFixture(t); const id = '12345678-1234-4234-8234-123456789abc'; const dir = path.join(data, '.account-migrations', id); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'journal.json'); fs.symlinkSync('/tmp/missing-journal', file);
  await assert.rejects(accountTool.main([...args, '--dry-run']), /Unsafe journal/);
  assert.equal(path.resolve(file), path.join(data, '.account-migrations', id, 'journal.json')); fs.unlinkSync(file);
  const valid = { version: 1, id, source: 'legacy', target, sourceDigest: 'a'.repeat(64), backupDigest: 'b'.repeat(64), storageBytes: 1, state: 'PREPARED' };
  for (const patch of [{ sourceDigest: 12 }, { backupDigest: 'bad' }, { storageBytes: -1 }, { storageBytes: '1' }, { source: '../escape' }, { state: 'UNKNOWN' }, { target: null }]) {
    fs.writeFileSync(file, JSON.stringify({ ...valid, ...patch }));
    await assert.rejects(accountTool.main(['migrate-recover', '--data-dir', data, '--offline-confirmed', '--migration-id', id]), /Invalid migration journal/);
    await assert.rejects(accountTool.main([...args, '--dry-run']), /Invalid migration journal/);
  }
});
test('migration rejects existing targets and missing referenced attachments', t => {
  const { root, data } = setup(t);
  fs.writeFileSync(path.join(data, 'messages.json'), '{"messages":[]}');
  const backup = path.join(root, 'backup.tar.gz');
  assert.equal(spawnSync(process.execPath, [backupTool, data, backup]).status, 0);
  const target = '12345678-1234-4234-8234-123456789abc';
  const flags = ['--offline-confirmed', '--dry-run', '--source-user', 'legacy', '--target-user', target, '--backup', backup];
  fs.mkdirSync(path.join(data, 'users', target), { recursive: true });
  assert.notEqual(run(data, 'migrate', flags).status, 0);
  const other = '22345678-1234-4234-8234-123456789abc';
  fs.writeFileSync(path.join(data, 'messages.json'), JSON.stringify({ messages: [{ type: 'file', content: { filePath: 'files/missing.txt' } }] }));
  assert.notEqual(run(data, 'migrate', flags.map(value => value === target ? other : value)).status, 0);
});
