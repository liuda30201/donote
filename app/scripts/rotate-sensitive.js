#!/usr/bin/env node
'use strict';
// Offline operator tool: no runtime/config imports or environment-derived secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSensitiveKeyring } = require('../src/security/sensitive');
const JOURNAL = '.sensitive-rotation';
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail() { throw new Error('Sensitive rotation rejected; preserve journal and verify offline inputs'); }
function exact(obj, keys) { return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key)); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function directory(file) { const stat = fs.lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) fail(); }
function regular(file, max = MAX_FILE, privateFile = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max || (privateFile && (stat.mode & 0o777) !== 0o600)) fail();
  return stat;
}
function read(file, max, privateFile) { regular(file, max, privateFile); return fs.readFileSync(file); }
function sync(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeNew(file, bytes) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(file, bytes) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.sensitive-rotation.tmp`);
  if (exists(temp)) {
    if (digest(read(temp, MAX_FILE, true)) !== digest(bytes)) fail();
  } else writeNew(temp, bytes);
  // A single deterministic sibling tmp lets recovery finish a fsynced, interrupted rename.
  if (path.dirname(path.resolve(temp)) !== path.dirname(path.resolve(file))) fail();
  fs.renameSync(temp, file); sync(dir);
}
function stagedDirectories(root) {
  return fs.readdirSync(root).filter(name => name.startsWith(`${JOURNAL}.tmp-`)).sort().map(name => {
    if (!/^\.sensitive-rotation\.tmp-[0-9a-f-]{36}$/.test(name)) fail();
    const dir = path.join(root, name); directory(dir);
    if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) fail();
    return dir;
  });
}
function options(argv) {
  const result = {};
  const flags = new Set(['--offline-confirmed', '--apply', '--recover', '--dry-run']);
  const values = new Set(['--data-dir', '--keyring-file', '--active-key-id', '--auth-key-file']);
  while (argv.length) {
    const key = argv.shift();
    if ((!flags.has(key) && !values.has(key)) || Object.hasOwn(result, key)) fail();
    result[key] = flags.has(key) ? true : argv.shift();
    if (!result[key] || (typeof result[key] === 'string' && result[key].startsWith('--'))) fail();
  }
  if (!result['--offline-confirmed'] || !result['--data-dir'] || !result['--keyring-file'] || !result['--active-key-id'] || !result['--auth-key-file']) fail();
  if ((result['--recover'] && !result['--apply']) || (result['--dry-run'] && result['--apply'])) fail();
  return result;
}
function external(root, file) {
  const resolved = fs.realpathSync(file);
  if (path.resolve(file) !== resolved || resolved === root || resolved.startsWith(`${root}${path.sep}`)) fail();
  return resolved;
}
function keyring(root, opts) {
  const file = external(root, opts['--keyring-file']);
  const bytes = read(file, 16384, true);
  const config = JSON.parse(bytes.toString('utf8'));
  if (!exact(config, ['version', 'activeKeyId', 'keys']) || config.version !== 1 || config.activeKeyId !== opts['--active-key-id'] || !config.keys || typeof config.keys !== 'object' || Array.isArray(config.keys)) fail();
  const auth = read(external(root, opts['--auth-key-file']), 32, true);
  if (auth.length !== 32) fail();
  const keys = Object.create(null);
  try {
    for (const [id, encoded] of Object.entries(config.keys)) {
      if (typeof encoded !== 'string' || encoded.length !== 44) fail();
      const key = Buffer.from(encoded, 'base64'); keys[id] = key;
      if (key.length !== 32 || key.toString('base64') !== encoded || crypto.timingSafeEqual(key, auth)) fail();
    }
    return { ring: createSensitiveKeyring({ activeKeyId: config.activeKeyId, keys }), binding: digest(bytes) };
  } finally { auth.fill(0); bytes.fill(0); for (const key of Object.values(keys)) key.fill(0); }
}
function inventory(root) {
  const users = path.join(root, 'users'); directory(users);
  const result = [];
  for (const userId of fs.readdirSync(users).sort()) {
    if (!UUID.test(userId)) fail();
    const dir = path.join(users, userId); directory(dir);
    const file = path.join(dir, 'messages.json');
    if (exists(file)) { regular(file); result.push(userId); }
  }
  // Accounts tool cannot silently omit legacy-root sensitive records.
  if (exists(path.join(root, 'messages.json'))) fail();
  return result;
}
function inspect(bytes, userId, ring, rotate) {
  const state = JSON.parse(bytes.toString('utf8'));
  if (!state || !Array.isArray(state.messages)) fail();
  const seen = new Set(); let count = 0; let changed = 0;
  for (const message of state.messages) {
    if (!message || typeof message.id !== 'string' || seen.has(message.id)) fail();
    seen.add(message.id);
    if (message.sensitive !== true) { if (Object.hasOwn(message, 'encryptedPayload')) fail(); continue; }
    if (message.type !== 'text' || message.content !== null || message.remark !== '' || !Object.hasOwn(message, 'encryptedPayload')) fail();
    const context = { userId, messageId: message.id };
    ring.decrypt(message.encryptedPayload, context); count += 1;
    if (message.encryptedPayload.content.keyId !== ring.activeKeyId) {
      changed += 1;
      if (rotate) message.encryptedPayload = ring.rotate(message.encryptedPayload, context);
    }
  }
  return { bytes: rotate ? Buffer.from(JSON.stringify(state, null, 2)) : bytes, count, changed };
}
function loadJournal(dir) {
  directory(dir);
  if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) fail();
  const journal = JSON.parse(read(path.join(dir, 'journal.json'), 16 * 1024 * 1024, true));
  if (!exact(journal, ['version', 'activeKeyId', 'keyringDigest', 'state', 'entries']) || journal.version !== 1 || !['prepared', 'committed'].includes(journal.state) || !Array.isArray(journal.entries)) fail();
  const seen = new Set();
  for (const entry of journal.entries) {
    if (!exact(entry, ['userId', 'oldDigest', 'newDigest', 'count', 'changed']) || !UUID.test(entry.userId) || seen.has(entry.userId) || !/^[a-f0-9]{64}$/.test(entry.oldDigest) || !/^[a-f0-9]{64}$/.test(entry.newDigest) || !Number.isSafeInteger(entry.count) || !Number.isSafeInteger(entry.changed) || entry.count < entry.changed || entry.changed < 0) fail();
    seen.add(entry.userId);
  }
  return journal;
}
function equivalent(oldBytes, nextBytes, userId, ring) {
  function canonical(bytes) {
    const state = JSON.parse(bytes.toString('utf8'));
    for (const message of state.messages) {
      if (message.sensitive === true) message.encryptedPayload = ring.decrypt(message.encryptedPayload, { userId, messageId: message.id });
    }
    return JSON.stringify(state);
  }
  if (canonical(oldBytes) !== canonical(nextBytes)) fail();
}
function commit(root, dir, journal, ring, binding, hook) {
  if (journal.keyringDigest !== binding || journal.activeKeyId !== ring.activeKeyId) fail();
  const users = inventory(root);
  if (JSON.stringify(users) !== JSON.stringify(journal.entries.map(e => e.userId))) fail();
  // Validate every source, backup and candidate before touching any user message file.
  for (const entry of journal.entries) {
    const old = read(path.join(dir, `${entry.userId}.old`), MAX_FILE, true);
    const next = read(path.join(dir, `${entry.userId}.new`), MAX_FILE, true);
    if (digest(old) !== entry.oldDigest || digest(next) !== entry.newDigest) fail();
    const before = inspect(old, entry.userId, ring, false);
    const after = inspect(next, entry.userId, ring, false);
    if (before.count !== entry.count || before.changed !== entry.changed || after.count !== entry.count || after.changed !== 0) fail();
    equivalent(old, next, entry.userId, ring);
    const current = read(path.join(root, 'users', entry.userId, 'messages.json'));
    if (![entry.oldDigest, entry.newDigest].includes(digest(current))) fail();
    const temp = path.join(root, 'users', entry.userId, '.messages.json.sensitive-rotation.tmp');
    if (exists(temp) && digest(read(temp, MAX_FILE, true)) !== entry.newDigest) fail();
  }
  if (journal.state === 'committed') {
    for (const entry of journal.entries) if (digest(read(path.join(root, 'users', entry.userId, 'messages.json'))) !== entry.newDigest) fail();
    return;
  }
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index]; const file = path.join(root, 'users', entry.userId, 'messages.json');
    const current = digest(read(file));
    if (![entry.oldDigest, entry.newDigest].includes(current)) fail();
    if (current !== entry.newDigest) atomic(file, read(path.join(dir, `${entry.userId}.new`), MAX_FILE, true));
    if (hook) hook('replaced', index); // Library-only fault injection; no CLI/env bypass.
  }
  journal.state = 'committed'; atomic(path.join(dir, 'journal.json'), Buffer.from(JSON.stringify(journal)));
}
function run(argv, { hook } = {}) {
  const opts = options([...argv]);
  const root = fs.realpathSync(opts['--data-dir']);
  if (root !== path.resolve(opts['--data-dir'])) fail(); directory(root);
  const { ring, binding } = keyring(root, opts);
  try {
    const dir = path.join(root, JOURNAL);
    const staged = stagedDirectories(root);
    if (opts['--recover']) {
      if (!exists(dir)) fail(); // No target writes precede publishing a complete prepared journal.
      const journal = loadJournal(dir);
      commit(root, dir, journal, ring, binding, hook);
      return { result: 'recovered', users: journal.entries.length, sensitive: journal.entries.reduce((n, e) => n + e.count, 0) };
    }
    if (exists(dir)) fail();
    // Incomplete preparation directories are retained as evidence; no messages were written.
    void staged;
    const users = inventory(root); const sources = [];
    let totalBytes = 0;
    for (const userId of users) {
      totalBytes += regular(path.join(root, 'users', userId, 'messages.json')).size;
      if (totalBytes > MAX_TOTAL) fail();
    }
    // Phase 1 authenticates every sensitive record before creating candidates or journal.
    for (const userId of users) {
      const bytes = read(path.join(root, 'users', userId, 'messages.json'));
      sources.push({ userId, bytes, ...inspect(bytes, userId, ring, false) });
    }
    const summary = { result: opts['--apply'] ? 'committed' : 'validated', users: users.length, sensitive: sources.reduce((n, s) => n + s.count, 0), rotating: sources.reduce((n, s) => n + s.changed, 0) };
    if (!opts['--apply']) return summary;
    const planned = sources.map(source => ({ ...source, candidate: source.changed ? inspect(source.bytes, source.userId, ring, true).bytes : source.bytes }));
    // Verify inventory and every original byte digest again before durable preparation.
    if (JSON.stringify(inventory(root)) !== JSON.stringify(users)) fail();
    for (const source of planned) if (digest(read(path.join(root, 'users', source.userId, 'messages.json'))) !== digest(source.bytes)) fail();
    const stage = path.join(root, `${JOURNAL}.tmp-${crypto.randomUUID()}`);
    fs.mkdirSync(stage, { mode: 0o700 }); sync(root);
    const journal = { version: 1, activeKeyId: ring.activeKeyId, keyringDigest: binding, state: 'prepared', entries: [] };
    for (const source of planned) {
      writeNew(path.join(stage, `${source.userId}.old`), source.bytes);
      writeNew(path.join(stage, `${source.userId}.new`), source.candidate);
      journal.entries.push({ userId: source.userId, oldDigest: digest(source.bytes), newDigest: digest(source.candidate), count: source.count, changed: source.changed });
      if (hook) hook('staging', journal.entries.length - 1);
    }
    writeNew(path.join(stage, 'journal.json'), Buffer.from(JSON.stringify(journal))); sync(stage);
    // Publish only a complete, fsynced journal; incomplete staging never blocks a fresh retry.
    if (path.dirname(path.resolve(stage)) !== root || path.resolve(dir) !== path.join(root, JOURNAL) || exists(dir)) fail();
    fs.renameSync(stage, dir); sync(root);
    if (hook) hook('prepared', -1);
    commit(root, dir, journal, ring, binding, hook);
    return summary;
  } finally { ring.close(); }
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`); }
  catch { process.stderr.write('Sensitive rotation rejected; preserve journal and verify offline inputs\n'); process.exitCode = 1; }
}
module.exports = { run };
