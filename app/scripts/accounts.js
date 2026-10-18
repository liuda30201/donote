#!/usr/bin/env node
'use strict';

// Offline operator tooling. Never imports runtime/config or reads process.env secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { openDatabase } = require('../src/db');
const { ACCOUNT_MIGRATIONS } = require('../src/db/schema');
const { createRepositories } = require('../src/db/repositories');
const { hashPassword } = require('../src/security/primitives');

function fail(message) { throw new Error(message); }
function options(argv) {
  const command = argv.shift();
  const result = { command };
  const flags = new Set(['--offline-confirmed', '--dry-run']);
  const values = new Set(['--data-dir', '--source-user', '--target-user', '--backup', '--migration-id']);
  while (argv.length) {
    const key = argv.shift();
    if ((!flags.has(key) && !values.has(key)) || key in result) fail('Unknown or duplicate option');
    result[key] = flags.has(key) ? true : argv.shift();
    if (!result[key] || (typeof result[key] === 'string' && result[key].startsWith('--'))) fail('Missing option value');
  }
  if (!['init-admin', 'migrate', 'migrate-recover'].includes(command) || !result['--data-dir']) fail('Specify init-admin or migrate and --data-dir');
  return result;
}
function rootDirectory(value) {
  const root = path.resolve(value);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Data directory must exist and must not be a symlink');
  return root;
}
async function inputJson() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) fail('Input exceeds 8192 bytes');
  }
  let input;
  try { input = JSON.parse(text); } catch { fail('Invalid input JSON'); }
  if (!input || Array.isArray(input) || typeof input !== 'object') fail('Input must be a JSON object');
  if (Object.keys(input).some(key => !['username', 'password', 'displayName'].includes(key))) fail('Unsupported input field');
  return input;
}
function inspectSource(root, sourceUser) {
  const base = sourceUser === 'legacy' ? root : path.join(root, 'users', sourceUser);
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) fail('Unsafe source user directory');
  const inventory = [];
  function walk(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('Source contains links or special files');
    if (stat.isDirectory()) {
      inventory.push({ path: relative, type: 'directory' });
      for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), `${relative}/${name}`);
    } else {
      if (stat.nlink !== 1) fail('Source contains linked file');
      const content = fs.readFileSync(file);
      inventory.push({ path: relative, type: 'file', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') });
    }
  }
  walk(path.join(base, 'messages.json'), 'messages.json');
  if (fs.existsSync(path.join(base, 'uploads'))) walk(path.join(base, 'uploads'), 'uploads');
  const state = JSON.parse(fs.readFileSync(path.join(base, 'messages.json'), 'utf8'));
  if (!state || !Array.isArray(state.messages)) fail('Invalid message state');
  for (const message of state.messages) {
    const content = message && message.content;
    if (!content || typeof content !== 'object') continue;
    const refs = message.type === 'image' ? [content.originalPath, content.thumbnailPath] : message.type === 'file' ? [content.filePath] : [];
    for (const ref of refs.filter(value => value !== undefined)) {
      if (typeof ref !== 'string' || !ref || ref.includes('\\') || ref.split('/').includes('..') || path.posix.isAbsolute(ref)) fail('Unsafe attachment reference');
      const normalized = path.posix.normalize(`uploads/${ref}`);
      if (!inventory.some(item => item.path === normalized && item.type === 'file')) fail('Referenced attachment is missing');
    }
  }
  return { base, messageCount: state.messages.length, entries: inventory };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function inventoryDigest(entries) { return digest(JSON.stringify(entries)); }
function syncPath(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function safeDirectory(dir) { const stat = fs.lstatSync(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Unsafe directory'); }
function saveJournal(dir, value) {
  const temp = path.join(dir, 'journal.tmp'); const file = path.join(dir, 'journal.json');
  const fd = fs.openSync(temp, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file); syncPath(dir);
}
function backupBinding(backup, source, entries) {
  const validator = path.resolve(__dirname, '../../scripts/lib/restore-validate.py');
  const checked = spawnSync('python3', [validator, backup], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (checked.error || checked.status !== 0) fail('Backup validation failed');
  const code = `import sys,tarfile,json,hashlib,posixpath\nprefix='' if sys.argv[2]=='legacy' else 'users/'+sys.argv[2]+'/'\nout=[]\nwith tarfile.open(sys.argv[1], 'r:*') as tf:\n for m in tf.getmembers():\n  n=posixpath.normpath(m.name)\n  if not n.startswith(prefix): continue\n  r=n[len(prefix):]\n  if r!='messages.json' and r!='uploads' and not r.startswith('uploads/'): continue\n  e={'path':r,'type':'directory' if m.isdir() else 'file'}\n  if m.isfile():\n   h=hashlib.sha256(); size=0\n   with tf.extractfile(m) as f:\n    while True:\n     b=f.read(1048576)\n     if not b: break\n     h.update(b); size+=len(b)\n   e.update(size=size,sha256=h.hexdigest())\n  out.append(e)\nprint(json.dumps(out))`;
  const inspected = spawnSync('python3', ['-c', code, backup, source], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (inspected.error || inspected.status !== 0) fail('Backup source inspection failed');
  const archived = JSON.parse(inspected.stdout);
  const canonical = values => JSON.stringify([...values].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (canonical(archived) !== canonical(entries)) fail('Backup does not match current source');
  return digest(fs.readFileSync(backup));
}
function existingDatabase(root, readonly = false) {
  const filename = path.join(root, 'donote.db'); const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1) fail('Existing account database required');
  if (readonly) return new (require('better-sqlite3'))(filename, { readonly: true, fileMustExist: true });
  return openDatabase({ storageRoot: root, migrations: ACCOUNT_MIGRATIONS });
}
function targetAccount(repo, target) {
  const user = repo.findUserById(target);
  if (!user || user.disabled_at != null || user.deleted_at != null || user.storage_bytes !== 0) fail('Target must be an existing active empty account');
  return user;
}
function migrationLock(root, recover) {
  const file = path.join(root, '.account-migration.lock');
  if (exists(file) && recover) {
    const stat = fs.lstatSync(file); if (!stat.isFile() || stat.nlink !== 1) fail('Unsafe migration lock');
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) fail('Invalid lock');
    try { process.kill(lock.pid, 0); fail('Migration process still running'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (path.resolve(file) !== path.join(root, '.account-migration.lock')) fail('Unsafe lock path');
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); fs.closeSync(fd); syncPath(root);
  return () => { if (path.resolve(file) !== path.join(root, '.account-migration.lock')) fail('Unsafe lock path'); fs.unlinkSync(file); syncPath(root); };
}
function auditFor(repo, journal) {
  const row = repo.findMigrationAudit({ userId: journal.target, migrationId: journal.id });
  if (!row) return null;
  const detail = JSON.parse(row.detail);
  if (detail.source !== journal.sourceDigest || detail.result !== journal.backupDigest) fail('Migration audit binding mismatch');
  return row;
}
function readJournal(dir, id) {
  const file = path.join(dir, 'journal.json'); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('Unsafe journal');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!journal || Array.isArray(journal) || journal.version !== 1 || journal.id !== id ||
      typeof journal.target !== 'string' || !UUID.test(journal.target) ||
      typeof journal.source !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(journal.source) || journal.source === journal.target ||
      !hex(journal.sourceDigest) || !hex(journal.backupDigest) ||
      !Number.isSafeInteger(journal.storageBytes) || journal.storageBytes < 0 ||
      !['PREPARED', 'COMMITTED', 'ROLLED_BACK'].includes(journal.state)) fail('Invalid migration journal');
  return journal;
}
function recoverMigration(root, id) {
  if (!UUID.test(id || '')) fail('Specify UUID --migration-id');
  const home = path.join(root, '.account-migrations'); safeDirectory(home);
  const dir = path.join(home, id); safeDirectory(dir);
  const journal = readJournal(dir, id);
  const users = path.join(root, 'users'); safeDirectory(users);
  const destination = path.join(users, journal.target); const stage = path.join(dir, 'stage');
  const db = existingDatabase(root);
  try {
    const repo = createRepositories(db); const audit = auditFor(repo, journal);
    if (audit) {
      if (exists(stage) || !exists(destination) || inventoryDigest(inspectSource(root, journal.target).entries) !== journal.sourceDigest) fail('Committed directory does not match journal');
      const user = repo.findUserById(journal.target); if (!user || user.storage_bytes !== journal.storageBytes) fail('Committed account storage mismatch');
      journal.state = 'COMMITTED';
    } else {
      if (journal.state === 'COMMITTED') fail('Committed journal has no audit');
      if (exists(destination)) {
        if (exists(stage) || inventoryDigest(inspectSource(root, journal.target).entries) !== journal.sourceDigest) fail('Ambiguous migration publication');
        if (path.resolve(destination) !== path.join(users, journal.target) || path.resolve(stage) !== path.join(dir, 'stage')) fail('Unsafe recovery paths');
        fs.renameSync(destination, stage); syncPath(users); syncPath(dir);
      }
      journal.state = 'ROLLED_BACK';
    }
    saveJournal(dir, journal); return { result: journal.state.toLowerCase(), migrationId: id };
  } finally { db.close(); }
}
function executeMigration(root, args, hooks = {}) {
  const source = args['--source-user']; const target = args['--target-user'];
  if (!source || (source !== 'legacy' && !/^[a-zA-Z0-9_-]{1,64}$/.test(source))) fail('Specify safe source');
  if (!UUID.test(target || '') || source === target) fail('Specify distinct UUID target');
  if (!args['--backup']) fail('Specify backup');
  const backup = path.resolve(args['--backup']); const stat = fs.lstatSync(backup);
  if (!stat.isFile() || stat.nlink !== 1 || backup === root || backup.startsWith(root + path.sep)) fail('Backup must be an external regular non-linked file');
  const users = path.join(root, 'users'); if (exists(users)) safeDirectory(users);
  const destination = path.join(users, target); if (exists(destination)) fail('Target already exists');
  const home = path.join(root, '.account-migrations');
  if (exists(home)) { safeDirectory(home); for (const name of fs.readdirSync(home)) { if (!UUID.test(name)) fail('Unknown migration workspace'); const dir = path.join(home, name); safeDirectory(dir); const j = readJournal(dir, name); if (!['COMMITTED', 'ROLLED_BACK'].includes(j.state)) fail('Recover pending migration first'); if (j.state === 'COMMITTED' && j.source === source) fail('Source already migrated'); } }
  const inventory = inspectSource(root, source); const sourceDigest = inventoryDigest(inventory.entries); const backupDigest = backupBinding(backup, source, inventory.entries);
  const storageBytes = inventory.entries.reduce((total, e) => total + (e.size || 0), 0); if (!Number.isSafeInteger(storageBytes)) fail('Source too large');
  const probe = existingDatabase(root, true); try { targetAccount(createRepositories(probe), target); } finally { probe.close(); }
  if (args['--dry-run']) return { result: 'validated', executable: true, sourceUser: source, targetUser: target, sourceDigest, backupDigest, messageCount: inventory.messageCount, storageBytes };
  if (!exists(users)) { fs.mkdirSync(users, { mode: 0o700 }); syncPath(root); }
  if (!exists(home)) { fs.mkdirSync(home, { mode: 0o700 }); syncPath(root); }
  const id = crypto.randomUUID(); const dir = path.join(home, id); fs.mkdirSync(dir, { mode: 0o700 }); syncPath(home);
  const stage = path.join(dir, 'stage'); fs.mkdirSync(stage, { mode: 0o700 });
  const journal = { version: 1, id, source, target, sourceDigest, backupDigest, storageBytes, state: 'PREPARED' };
  // Journal exists before copying; interruption at any point is recoverable without modifying source.
  saveJournal(dir, journal);
  for (const entry of inventory.entries) {
    const output = path.join(stage, entry.path);
    if (entry.type === 'directory') fs.mkdirSync(output, { mode: 0o700 });
    else { fs.copyFileSync(path.join(inventory.base, entry.path), output, fs.constants.COPYFILE_EXCL); fs.chmodSync(output, 0o600); syncPath(output); }
  }
  for (const entry of [...inventory.entries].reverse()) if (entry.type === 'directory') syncPath(path.join(stage, entry.path)); syncPath(stage); syncPath(dir);
  const staged = inspectSource(stage, 'legacy');
  if (inventoryDigest(staged.entries) !== sourceDigest) fail('Staged data mismatch');
  const db = existingDatabase(root); let committed = false;
  try {
    const repo = createRepositories(db);
    db.transaction(() => {
      targetAccount(repo, target); if (exists(destination)) fail('Target conflict');
      if (inventoryDigest(inspectSource(root, source).entries) !== sourceDigest || digest(fs.readFileSync(backup)) !== backupDigest) fail('Source or backup changed');
      repo.setStorageUsage({ userId: target, storageBytes }); repo.revokeAllSessions({ userId: target });
      repo.addAudit({ targetId: target, action: 'data.migrated', detail: { reason: id, source: sourceDigest, result: backupDigest } });
      if (hooks.beforePublish) hooks.beforePublish();
      if (path.resolve(stage) !== path.join(dir, 'stage') || path.resolve(destination) !== path.join(users, target)) fail('Unsafe publish paths');
      fs.renameSync(stage, destination); syncPath(users); syncPath(dir);
      if (hooks.afterPublish) hooks.afterPublish();
    }).immediate();
    committed = true;
    if (hooks.afterCommit) hooks.afterCommit();
    journal.state = 'COMMITTED'; saveJournal(dir, journal);
    return { result: 'migrated', migrationId: id, targetUser: target, sourceDigest, backupDigest, messageCount: inventory.messageCount, storageBytes };
  } catch (error) {
    if (!committed) {
      if (exists(destination)) {
        if (exists(stage) || inventoryDigest(inspectSource(root, target).entries) !== sourceDigest) fail('Rollback requires manual recovery');
        if (path.resolve(destination) !== path.join(users, target) || path.resolve(stage) !== path.join(dir, 'stage')) fail('Unsafe rollback paths');
        fs.renameSync(destination, stage); syncPath(users); syncPath(dir);
      }
      journal.state = 'ROLLED_BACK'; saveJournal(dir, journal);
    }
    throw error;
  } finally { db.close(); }
}
async function main(argv, hooks = {}) {
  const args = options([...argv]);
  const root = rootDirectory(args['--data-dir']);
  if (args.command === 'init-admin') {
    if (!args['--offline-confirmed']) fail('Stop all writers and supply --offline-confirmed');
    if (['--source-user', '--target-user', '--backup', '--dry-run'].some(key => args[key])) fail('Unsupported init-admin option');
    const input = await inputJson();
    // Hash before opening the DB so malformed passwords do not initialize storage.
    const passwordHash = await hashPassword(input.password);
    const db = openDatabase({ storageRoot: root, migrations: ACCOUNT_MIGRATIONS });
    try {
      const user = db.transaction(() => {
        if (db.prepare('SELECT count(*) AS n FROM users').get().n !== 0) fail('Initialization refused: accounts already exist');
        const repositories = createRepositories(db);
        const account = repositories.createUser({ username: input.username, displayName: input.displayName || input.username, passwordHash, role: 'admin', mustChangePassword: true });
        repositories.addAudit({ actorId: account.id, targetId: account.id, action: 'user.created', detail: { source: 'offline-init' } });
        return account;
      }).immediate();
      console.log(JSON.stringify({ result: 'created', userId: user.id, username: user.username, mustChangePassword: true }));
    } finally { db.close(); }
    return;
  }
  if (args.command === 'migrate-recover') {
    if (!args['--offline-confirmed'] || args['--dry-run'] || args['--source-user'] || args['--target-user'] || args['--backup']) fail('Recovery requires offline confirmation and migration ID only');
    const release = migrationLock(root, true);
    try { console.log(JSON.stringify(recoverMigration(root, args['--migration-id']))); } finally { release(); }
    return;
  }
  if (args['--migration-id']) fail('Migration ID only accepted for recovery');
  if (!args['--offline-confirmed']) fail('Stop all writers and supply --offline-confirmed');
  if (args['--dry-run']) { if (exists(path.join(root, '.account-migration.lock'))) fail('Migration in progress'); console.log(JSON.stringify(executeMigration(root, args, hooks))); }
  else { const release = migrationLock(root, false); try { console.log(JSON.stringify(executeMigration(root, args, hooks))); } finally { release(); } }
  return;
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { console.error('Account tool failed. Check command options, offline state and input; credentials are never printed.'); process.exitCode = 1; });
module.exports = { main };
