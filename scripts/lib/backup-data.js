#!/usr/bin/env node
'use strict';

// O01 format 1: data paths stay relative to the data root for O02 restore.
// Every regular file has a SHA-256; directories (including empty ones) are listed.
// This is not a write barrier. Stop all writers before a consistent backup.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function fail(message) { throw new Error(message); }
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function assertLegacyOnly(root) {
  for (const name of ['donote.db', 'donote.db-wal', 'donote.db-shm']) {
    try { fs.lstatSync(path.join(root, name)); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    fail('SQLite backup unsupported: stop writers and use a separately verified checkpoint/snapshot workflow; refusing to omit database');
  }
  if (process.env.AUTH_MODE === 'accounts') fail('Accounts backup is not yet supported by this legacy helper');
  const keyFile = process.env.AUTH_KEY_FILE;
  if (keyFile) {
    const resolved = fs.realpathSync(keyFile);
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) fail('AUTH_KEY_FILE must be outside the data backup tree');
  }
}
function inventory(root) {
  assertLegacyOnly(root);
  const entries = [];
  function visit(relative) {
    // Only application temporary paths are excluded, not arbitrary attachments.
    // Exclude only the application root temp workspace and atomic message temp files.
    // User IDs and attachment names may legitimately contain "temp".
    if (relative === 'temp' || relative.startsWith('temp/')) return;
    if (path.basename(relative) === 'messages.json.tmp' && /^(messages\.json\.tmp|users\/[^/]+\/messages\.json\.tmp)$/.test(relative)) return;
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      fail(`Unsupported link or special file: ${relative}`);
    }
    const entry = { path: relative, type: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777 };
    if (stat.isFile()) {
      entry.size = stat.size;
      entry.sha256 = sha256(absolute);
      if (path.basename(relative) === 'messages.json') {
        const state = JSON.parse(fs.readFileSync(absolute, 'utf8'));
        if (!state || typeof state !== 'object' || !Array.isArray(state.messages)) {
          fail(`Invalid message state: ${relative}`);
        }
      }
    }
    entries.push(entry);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    }
  }
  for (const name of ['messages.json', 'uploads', 'shares', 'users', '.mode']) {
    const absolute = path.join(root, name);
    // lstat catches dangling links; absence is allowed only for optional roots.
    try { fs.lstatSync(absolute); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const isFile = name === 'messages.json' || name === '.mode';
    const stat = fs.lstatSync(absolute);
    if (isFile ? !stat.isFile() : !stat.isDirectory()) fail(`Unexpected file type: ${name}`);
    visit(name);
  }
  const has = (relative) => entries.some(entry => entry.path === relative && entry.type === 'file');
  const users = entries.filter(entry => /^users\/[^/]+$/.test(entry.path));
  for (const user of users) {
    if (user.type !== 'directory' || !has(`${user.path}/messages.json`)) {
      fail(`Missing required user messages: ${user.path}/messages.json`);
    }
  }
  if (entries.some(entry => entry.path === 'uploads') && !has('messages.json')) {
    fail('Legacy uploads present without required messages.json');
  }
  if (!has('messages.json') && users.length === 0) fail('No message data found; refusing an empty backup');
  // Validate attachment references under each owner's upload root before publication.
  for (const entry of entries.filter(item => item.type === 'file' && /^(messages\.json|users\/[^/]+\/messages\.json)$/.test(item.path))) {
    const state = JSON.parse(fs.readFileSync(path.join(root, entry.path), 'utf8'));
    const owner = path.posix.dirname(entry.path);
    for (const message of state.messages) {
      const content = message && message.content;
      if (!content || typeof content !== 'object') continue;
      const refs = message.type === 'file' ? [content.filePath] : message.type === 'image' ? [content.thumbnailPath, content.originalPath] : [];
      for (const ref of refs.filter(value => value !== undefined)) {
        if (typeof ref !== 'string' || !ref || ref.includes('\\') || ref.includes('\0') || path.posix.isAbsolute(ref) || ref.split('/').some(part => part === '..' || part === '.')) {
          fail(`Unsafe attachment reference in ${entry.path}`);
        }
        const relative = path.posix.join(owner === '.' ? '' : owner, 'uploads', ref);
        if (!has(relative)) fail(`Missing referenced attachment: ${relative}`);
      }
    }
  }
  return entries;
}
function main() {
  const [sourceArg, archiveArg] = process.argv.slice(2);
  if (!sourceArg || !archiveArg) fail('Usage: backup-data.js DATA_DIR NEW_ARCHIVE');
  process.umask(0o077);
  const source = fs.realpathSync(sourceArg);
  if (!fs.statSync(source).isDirectory()) fail('Data root must be a directory');
  const outputParent = fs.realpathSync(path.dirname(path.resolve(archiveArg)));
  const archive = path.join(outputParent, path.basename(archiveArg));
  if (archive === source || archive.startsWith(`${source}${path.sep}`)) fail('Archive must be outside data');
  try { fs.lstatSync(archive); fail('Archive already exists'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const tmpParent = fs.realpathSync(os.tmpdir());
  const stage = fs.mkdtempSync(path.join(tmpParent, 'donote-backup-'));
  let outputStage;
  let entries = [];
  try {
    outputStage = fs.mkdtempSync(path.join(outputParent, '.donote-backup-'));
    const pendingArchive = path.join(outputStage, 'archive.tar.gz');
    entries = inventory(source);
    for (const entry of entries) {
      const target = path.join(stage, entry.path);
      if (entry.type === 'directory') fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(source, entry.path), target, fs.constants.COPYFILE_EXCL);
        if (sha256(target) !== entry.sha256) fail(`File changed while copying: ${entry.path}`);
        fs.chmodSync(target, entry.mode);
      }
    }
    if (JSON.stringify(inventory(source)) !== JSON.stringify(entries)) fail('Data changed during backup; stop writers and retry');
    let applicationVersion = null;
    if (fs.existsSync('/app/package.json')) applicationVersion = JSON.parse(fs.readFileSync('/app/package.json', 'utf8')).version;
    const manifest = {
      format: 'donote-backup', formatVersion: 1, applicationVersion,
      createdAt: new Date().toISOString(), consistency: 'requires-stopped-writers', storageMode: 'legacy',
      userMapping: entries.filter(entry => /^users\/[^/]+$/.test(entry.path)).map(entry => ({ sourceId: entry.path.slice(6), directory: entry.path })),
      exclusions: ['root temp/ workspace', 'root/users/<id> atomic messages.json.tmp files'],
      checksumAlgorithm: 'sha256', entries
    };
    fs.writeFileSync(path.join(stage, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    // Apply directory modes last so copying works even with read-only directories.
    for (const entry of [...entries].reverse()) {
      if (entry.type === 'directory') fs.chmodSync(path.join(stage, entry.path), entry.mode);
    }
    const result = spawnSync('tar', ['-czf', pendingArchive, '-C', stage, '.'], {
      stdio: 'inherit',
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`tar failed (${result.status}${result.signal ? `, ${result.signal}` : ''})`);
    fs.chmodSync(pendingArchive, 0o600);
    const check = spawnSync('tar', ['-tzf', pendingArchive], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (check.error) throw check.error;
    if (check.status !== 0) fail(`Archive verification failed (${check.status})`);
    // Docker runs as root to read historical attachments, but the finished
    // archive must be owned by the invoking host user. Permission failures abort.
    if (process.env.BACKUP_UID !== undefined || process.env.BACKUP_GID !== undefined) {
      const uid = Number(process.env.BACKUP_UID);
      const gid = Number(process.env.BACKUP_GID);
      if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) fail('Invalid backup owner');
      fs.chownSync(pendingArchive, uid, gid);
    }
    // Same-filesystem link is atomic and refuses to overwrite an existing path.
    fs.linkSync(pendingArchive, archive);
    console.log(`Backup verified: ${entries.filter(entry => entry.type === 'file').length} files, ${manifest.userMapping.length} users`);
  } finally {
    // These are exact mkdtemp-owned paths, never source or pre-existing backups.
    if (path.dirname(stage) !== tmpParent || !path.basename(stage).startsWith('donote-backup-')) fail('Unsafe staging path');
    // Restore traversal permissions before removing a read-only staged tree.
    for (const entry of entries) {
      if (entry.type === 'directory') {
        const target = path.join(stage, entry.path);
        if (fs.existsSync(target)) fs.chmodSync(target, 0o700);
      }
    }
    fs.rmSync(stage, { recursive: true, force: true });
    if (outputStage) {
      if (path.dirname(outputStage) !== outputParent || !path.basename(outputStage).startsWith('.donote-backup-')) fail('Unsafe output staging path');
      fs.rmSync(outputStage, { recursive: true, force: true });
    }
  }
}
try { main(); } catch (error) { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; }
