'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { QuotaError } = require('../src/quota');

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function loadStorage(root) {
  const filename = path.join(__dirname, '../src/storage.js');
  const source = await fs.readFile(filename, 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(id) {
      if (id === 'fs/promises') return fs;
      if (id === './config') return { MULTI_USER_MODE: true, STORAGE_ROOT: root, UPLOAD_ROOT: path.join(root, 'uploads'), userPasswordMap: new Map() };
      if (id === './utils') return { ensureDir: dir => fs.mkdir(dir, { recursive: true }), clampPageSize: x => x };
      return require(id);
    },
    console, structuredClone, setImmediate, clearImmediate, Date
  }, { filename });
  return module.exports;
}

async function fixture(t, { quota = 1024, repoOverrides = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = await loadStorage(root);
  const user = { id: 'user-1', deleted_at: null, storage_quota_bytes: quota, storage_bytes: 0 };
  const usage = [];
  const repo = {
    findUserById(id) { return id === user.id || id === 'user-2' ? { ...user, id } : null; },
    setStorageUsage({ userId, storageBytes }) { if (repoOverrides.fail) throw new Error('db unavailable'); usage.push({ userId, storageBytes }); user.storage_bytes = storageBytes; return user; },
    ...repoOverrides
  };
  const upload = { configureUploadPolicy(policy) { this.policy = policy; } };
  const { configureAccountQuota } = require('../src/quota-runtime');
  const runtime = configureAccountQuota({ storage, upload, repo, env: { DONOTE_DEFAULT_QUOTA_BYTES: '2048' }, storageRoot: root });
  return { root, storage, repo, upload, runtime, user, usage };
}

test('reconcile measures real messages and upload files and persists usage', async t => {
  const f = await fixture(t, { quota: 4096 });
  const file = f.storage.getDataFile(f.user.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"messages":[]}');
  await fs.mkdir(f.storage.getUploadRoot(f.user.id), { recursive: true });
  await fs.writeFile(path.join(f.storage.getUploadRoot(f.user.id), 'one.bin'), Buffer.alloc(7));
  const result = await f.runtime.quotaService.reconcileUsage({ userId: f.user.id, messagesFile: file, uploadRoot: f.storage.getUploadRoot(f.user.id), storageQuotaBytes: f.user.storage_quota_bytes, persistUsage: ({ userId, storageBytes }) => f.repo.setStorageUsage({ userId, storageBytes }) });
  assert.equal(result.usageBytes, result.messagesBytes + result.uploadsBytes);
  assert.equal(result.uploadsBytes, 7);
  assert.equal(f.user.storage_bytes, result.usageBytes);
});

test('over-quota candidate is rejected before JSON and memory commit', async t => {
  const f = await fixture(t, { quota: 10 });
  await assert.rejects(f.storage.commitUserMutation(f.user.id, state => { state.messages.push({ id: 'large', payload: 'x'.repeat(200) }); }), error => error instanceof QuotaError && error.code === 'QUOTA_EXCEEDED');
  assert.equal(f.storage.getUserState(f.user.id).messages.length, 0);
  await assert.rejects(fs.access(f.storage.getDataFile(f.user.id)), { code: 'ENOENT' });
});

test('per-user mutations are FIFO while different users proceed concurrently', async t => {
  const f = await fixture(t, { quota: 10000 });
  const queue = require('../src/quota').createQuotaService({ defaultQuotaBytes: 10000, mutationWaitTimeoutMs: 1000 });
  const order = [];
  const firstGate = deferred();
  const otherGate = deferred();
  const firstStarted = deferred();
  const otherStarted = deferred();
  const first = queue.runMutation(f.user.id, async () => { order.push('first-start'); firstStarted.resolve(); await firstGate.promise; });
  const second = queue.runMutation(f.user.id, async () => { order.push('second-start'); });
  const other = queue.runMutation('user-2', async () => { order.push('other-start'); otherStarted.resolve(); await otherGate.promise; });
  const tasks = [first, second, other];
  try {
    await Promise.all([firstStarted.promise, otherStarted.promise]);
    assert.equal(order.includes('first-start'), true);
    assert.equal(order.includes('second-start'), false);
    assert.equal(order.includes('other-start'), true);
  } finally {
    firstGate.resolve();
    otherGate.resolve();
    await Promise.allSettled(tasks);
  }
  assert.equal(order.indexOf('first-start') < order.indexOf('second-start'), true);
  assert.equal(order.includes('other-start'), true);
  await queue.drain();
});

test('durable JSON and memory survive usage DB failure, then block later writes', async t => {
  const f = await fixture(t, { quota: 1000, repoOverrides: { fail: true } });
  await f.storage.commitUserMutation(f.user.id, state => { state.messages.push({ id: 'durable' }); });
  assert.equal(f.runtime.isBlocked(f.user.id), true);
  assert.equal(f.storage.getUserState(f.user.id).messages[0].id, 'durable');
  assert.equal(JSON.parse(await fs.readFile(f.storage.getDataFile(f.user.id), 'utf8')).messages[0].id, 'durable');
  await assert.rejects(f.storage.commitUserMutation(f.user.id, state => { state.messages.push({ id: 'blocked' }); }), error => error.code === 'USAGE_RECONCILE_REQUIRED');
  assert.equal(f.storage.getUserState(f.user.id).messages.length, 1);
});

test('invalid global default quota is rejected at account setup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-invalid-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = await loadStorage(root);
  const upload = { configureUploadPolicy() {} };
  const repo = { findUserById() { return null; } };
  const { configureAccountQuota } = require('../src/quota-runtime');
  assert.throws(() => configureAccountQuota({ storage, upload, repo, env: { DONOTE_DEFAULT_QUOTA_BYTES: '01' }, storageRoot: root }), /Invalid DONOTE_DEFAULT_QUOTA_BYTES/);
});
