'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { run } = require('../../scripts/rotate-sensitive');
const { createSensitiveKeyring } = require('../../src/security/sensitive');
const CLI = path.resolve(__dirname, '../../scripts/rotate-sensitive.js');
const USERS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'synthetic-sensitive-rotation-'));
  // Only remove the exact fixture directory returned by mkdtemp, never a data-dir input.
  t.after(() => { assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(base).startsWith('synthetic-sensitive-rotation-')); fs.rmSync(base, { recursive: true, force: true }); });
  const root = path.join(base, 'data'); fs.mkdirSync(path.join(root, 'users'), { recursive: true });
  const old = crypto.randomBytes(32); const current = crypto.randomBytes(32); const auth = crypto.randomBytes(32);
  const config = { version: 1, activeKeyId: 'current', keys: { old: old.toString('base64'), current: current.toString('base64') } };
  const keyFile = path.join(base, 'keys.json'); const authFile = path.join(base, 'auth.key');
  fs.writeFileSync(keyFile, JSON.stringify(config), { mode: 0o600 }); fs.writeFileSync(authFile, auth, { mode: 0o600 });
  const ring = createSensitiveKeyring({ activeKeyId: 'old', keys: { old } });
  const files = [];
  for (const userId of USERS) {
    const dir = path.join(root, 'users', userId); fs.mkdirSync(dir);
    const encryptedPayload = ring.encrypt({ content: 'synthetic-sensitive-body', remark: 'synthetic-secret-remark' }, { userId, messageId: 'synthetic-message' });
    const state = { messages: [{ id: 'synthetic-message', type: 'text', timestamp: 100, sensitive: true, content: null, remark: '', favorite: true, encryptedPayload }, { id: 'plain', type: 'text', timestamp: 101, content: 'synthetic ordinary', remark: '' }], lastActivity: 101 };
    const file = path.join(dir, 'messages.json'); fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); files.push(file);
  }
  ring.close();
  const argv = ['--offline-confirmed', '--data-dir', root, '--keyring-file', keyFile, '--active-key-id', 'current', '--auth-key-file', authFile];
  return { base, root, files, keyFile, authFile, config, argv, old, current };
}
function snapshot(files) { return files.map(file => fs.readFileSync(file, 'utf8')); }
function assertCurrent(f) {
  const ring = createSensitiveKeyring({ activeKeyId: 'current', keys: { current: f.current } });
  try {
    for (let i = 0; i < f.files.length; i += 1) {
      const state = JSON.parse(fs.readFileSync(f.files[i]));
      assert.equal(state.messages[0].encryptedPayload.content.keyId, 'current');
      assert.deepEqual(ring.decrypt(state.messages[0].encryptedPayload, { userId: USERS[i], messageId: 'synthetic-message' }), { content: 'synthetic-sensitive-body', remark: 'synthetic-secret-remark' });
      assert.equal(state.messages[1].content, 'synthetic ordinary');
      assert.equal(state.lastActivity, 101);
    }
  } finally { ring.close(); }
}
test('CLI defaults to read-only dry-run and redacts stdout/stderr', t => {
  const f = fixture(t); const before = snapshot(f.files);
  const result = spawnSync(process.execPath, [CLI, ...f.argv], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { result: 'validated', users: 2, sensitive: 2, rotating: 2 });
  assert.deepEqual(snapshot(f.files), before);
  assert.equal(fs.existsSync(path.join(f.root, '.sensitive-rotation')), false);
  for (const value of ['synthetic-sensitive-body', 'synthetic-secret-remark', f.config.keys.old, f.config.keys.current]) assert.equal((result.stdout + result.stderr).includes(value), false);
});
test('apply validates then rotates every user, retains original ciphertext and old key recovery', t => {
  const f = fixture(t); const before = snapshot(f.files);
  const result = run([...f.argv, '--apply']); assert.equal(result.result, 'committed'); assertCurrent(f);
  const dir = path.join(f.root, '.sensitive-rotation');
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json')));
  assert.equal(journal.state, 'committed'); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (let i = 0; i < USERS.length; i += 1) assert.equal(fs.readFileSync(path.join(dir, `${USERS[i]}.old`), 'utf8'), before[i]);
  const oldRing = createSensitiveKeyring({ activeKeyId: 'old', keys: { old: f.old } });
  assert.equal(oldRing.decrypt(JSON.parse(before[0]).messages[0].encryptedPayload, { userId: USERS[0], messageId: 'synthetic-message' }).content, 'synthetic-sensitive-body'); oldRing.close();
  assert.equal(run([...f.argv, '--apply', '--recover']).result, 'recovered');
});
test('all-user authentication failure, plaintext residue, or missing old key yields zero writes', t => {
  const f = fixture(t);
  const damaged = JSON.parse(fs.readFileSync(f.files[1])); damaged.messages[0].encryptedPayload.remark.tag = 'AA=='; fs.writeFileSync(f.files[1], JSON.stringify(damaged));
  const before = snapshot(f.files); assert.throws(() => run([...f.argv, '--apply'])); assert.deepEqual(snapshot(f.files), before);
  assert.equal(fs.existsSync(path.join(f.root, '.sensitive-rotation')), false);
  damaged.messages[0].content = 'synthetic residue'; fs.writeFileSync(f.files[1], JSON.stringify(damaged));
  assert.throws(() => run([...f.argv, '--apply']));
  const config = { ...f.config, keys: { current: f.config.keys.current } }; fs.writeFileSync(f.keyFile, JSON.stringify(config));
  assert.throws(() => run(f.argv)); assert.equal(fs.existsSync(path.join(f.root, '.sensitive-rotation')), false);
});
test('real SIGKILL after first replacement recovers deterministically using durable journal', t => {
  const f = fixture(t); const before = snapshot(f.files);
  const code = `const {run}=require(${JSON.stringify(CLI)});run(JSON.parse(process.argv[1]),{hook:(phase,index)=>{if(phase==='replaced'&&index===0)process.kill(process.pid,'SIGKILL')}});`;
  const killed = spawnSync(process.execPath, ['-e', code, JSON.stringify([...f.argv, '--apply'])], { encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL');
  assert.notEqual(snapshot(f.files)[0], before[0]); assert.equal(snapshot(f.files)[1], before[1]);
  assert.throws(() => run([...f.argv, '--apply']));
  const recovered = spawnSync(process.execPath, [CLI, ...f.argv, '--apply', '--recover'], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr); assertCurrent(f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.sensitive-rotation', 'journal.json'))).state, 'committed');
});
test('recovery rejects changed sources, tampered candidates and missing old keys before additional writes', t => {
  const f = fixture(t);
  assert.throws(() => run([...f.argv, '--apply'], { hook: phase => { if (phase === 'prepared') throw new Error('synthetic interruption'); } }));
  const before = snapshot(f.files);
  fs.writeFileSync(f.keyFile, JSON.stringify({ ...f.config, keys: { current: f.config.keys.current } }));
  assert.throws(() => run([...f.argv, '--apply', '--recover'])); assert.deepEqual(snapshot(f.files), before);
  fs.writeFileSync(f.keyFile, JSON.stringify(f.config));
  const candidate = path.join(f.root, '.sensitive-rotation', `${USERS[1]}.new`);
  const saved = fs.readFileSync(candidate); fs.appendFileSync(candidate, ' ');
  assert.throws(() => run([...f.argv, '--apply', '--recover'])); assert.deepEqual(snapshot(f.files), before);
  fs.writeFileSync(candidate, saved);
  fs.appendFileSync(f.files[1], ' ');
  const changed = snapshot(f.files);
  assert.throws(() => run([...f.argv, '--apply', '--recover'])); assert.deepEqual(snapshot(f.files), changed);
});
test('preparation interruption never writes targets; fresh apply retains abandoned stage as evidence', t => {
  const f = fixture(t); const before = snapshot(f.files);
  assert.throws(() => run([...f.argv, '--apply'], { hook: phase => { if (phase === 'staging') throw new Error('synthetic interruption'); } }));
  assert.deepEqual(snapshot(f.files), before);
  assert.equal(fs.existsSync(path.join(f.root, '.sensitive-rotation')), false);
  const stages = fs.readdirSync(f.root).filter(name => name.startsWith('.sensitive-rotation.tmp-'));
  assert.equal(stages.length, 1);
  assert.equal(run([...f.argv, '--apply']).result, 'committed'); assertCurrent(f);
  assert.equal(fs.existsSync(path.join(f.root, stages[0])), true);
});
test('recovery verifies plaintext and metadata equivalence even if candidate hash is rewritten', t => {
  const f = fixture(t);
  assert.throws(() => run([...f.argv, '--apply'], { hook: phase => { if (phase === 'prepared') throw new Error('synthetic interruption'); } }));
  const dir = path.join(f.root, '.sensitive-rotation'); const file = path.join(dir, `${USERS[0]}.new`);
  const state = JSON.parse(fs.readFileSync(file)); state.messages[1].content = 'synthetic malicious replacement';
  const next = Buffer.from(JSON.stringify(state)); fs.writeFileSync(file, next);
  const journalFile = path.join(dir, 'journal.json'); const journal = JSON.parse(fs.readFileSync(journalFile));
  journal.entries[0].newDigest = crypto.createHash('sha256').update(next).digest('hex'); fs.writeFileSync(journalFile, JSON.stringify(journal));
  const before = snapshot(f.files); assert.throws(() => run([...f.argv, '--apply', '--recover'])); assert.deepEqual(snapshot(f.files), before);
});
test('CLI rejects online ambiguity, unsafe key placement/permissions, linked files and duplicate arguments', t => {
  const f = fixture(t);
  assert.throws(() => run(f.argv.filter(arg => arg !== '--offline-confirmed')));
  assert.throws(() => run([...f.argv, '--data-dir', f.root]));
  assert.throws(() => run([...f.argv, '--apply', '--dry-run']));
  fs.chmodSync(f.keyFile, 0o644); assert.throws(() => run(f.argv)); fs.chmodSync(f.keyFile, 0o600);
  const inside = path.join(f.root, 'unsafe-keyring.json'); fs.writeFileSync(inside, JSON.stringify(f.config), { mode: 0o600 });
  const insideArgs = [...f.argv]; insideArgs[insideArgs.indexOf('--keyring-file') + 1] = inside; assert.throws(() => run(insideArgs));
  const symbolic = path.join(f.base, 'keyring-link'); fs.symlinkSync(f.keyFile, symbolic);
  const linkedArgs = [...f.argv]; linkedArgs[linkedArgs.indexOf('--keyring-file') + 1] = symbolic; assert.throws(() => run(linkedArgs));
  const sameAsAuth = { ...f.config, keys: { ...f.config.keys, current: fs.readFileSync(f.authFile).toString('base64') } };
  fs.writeFileSync(f.keyFile, JSON.stringify(sameAsAuth)); assert.throws(() => run(f.argv)); fs.writeFileSync(f.keyFile, JSON.stringify(f.config));
  fs.linkSync(f.files[0], path.join(f.base, 'linked-messages')); assert.throws(() => run([...f.argv, '--apply']));
  assert.equal(fs.existsSync(path.join(f.root, '.sensitive-rotation')), false);
});
