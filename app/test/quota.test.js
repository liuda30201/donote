'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  QuotaError,
  DEFAULT_QUOTA_BYTES,
  resolveQuotaBytes,
  calculateProposedUsage,
  evaluateUsage,
  admitUsage,
  measurePhysicalUsage,
  checkDiskHeadroom,
  createQuotaService
} = require('../src/quota');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'donote-quota-'));
  const user = path.join(root, 'user');
  await fs.mkdir(path.join(user, 'uploads', 'nested'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, user, messages: path.join(user, 'messages.json'), uploads: path.join(user, 'uploads') };
}

function expectCode(error, code) {
  assert.ok(error instanceof QuotaError);
  assert.equal(error.code, code);
}

test('measures exact physical JSON and nested regular upload bytes', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.messages, Buffer.from('{"messages":[]}'));
  await fs.writeFile(path.join(f.uploads, 'a.bin'), Buffer.alloc(7));
  await fs.writeFile(path.join(f.uploads, 'nested', 'b.bin'), Buffer.alloc(13));
  assert.deepEqual(await measurePhysicalUsage({ messagesFile: f.messages, uploadRoot: f.uploads }), {
    bytes: 35, messagesBytes: 15, uploadsBytes: 20, fileCount: 2
  });
});

test('missing roots are zero and symlinks, hard links and special files fail closed', async t => {
  const f = await fixture(t);
  assert.deepEqual(await measurePhysicalUsage({ messagesFile: f.messages, uploadRoot: f.uploads }), { bytes: 0, messagesBytes: 0, uploadsBytes: 0, fileCount: 0 });
  await fs.writeFile(f.messages, 'x');
  const linked = path.join(f.uploads, 'linked');
  await fs.symlink(f.messages, linked);
  await assert.rejects(measurePhysicalUsage({ messagesFile: f.messages, uploadRoot: f.uploads }), error => { expectCode(error, 'SYMLINK_REJECTED'); return true; });
  await fs.unlink(linked);
  await fs.writeFile(path.join(f.uploads, 'a'), 'x');
  const hard = path.join(f.uploads, 'hard');
  await fs.link(path.join(f.uploads, 'a'), hard);
  await assert.rejects(measurePhysicalUsage({ messagesFile: f.messages, uploadRoot: f.uploads }), error => { expectCode(error, 'LINKED_FILE_REJECTED'); return true; });
});

test('quota zero resolves to explicit default and reductions are allowed while over quota', () => {
  assert.equal(resolveQuotaBytes(0), DEFAULT_QUOTA_BYTES);
  assert.equal(resolveQuotaBytes(0, 1234), 1234);
  assert.equal(resolveQuotaBytes(99, 1234), 99);
  assert.equal(calculateProposedUsage({ currentBytes: 20, addedBytes: 4, releasedBytes: 3 }), 21);
  assert.equal(evaluateUsage({ currentBytes: 120, proposedBytes: 110, storageQuotaBytes: 100 }).allowed, true);
  assert.throws(() => admitUsage({ currentBytes: 100, proposedBytes: 101, storageQuotaBytes: 100 }), error => { expectCode(error, 'QUOTA_EXCEEDED'); return true; });
});

test('per-user FIFO preserves order and permits different users concurrently', async () => {
  const service = createQuotaService({ maxMutationWaiters: 10, mutationWaitTimeoutMs: 1000 });
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = service.runMutation('alice', async () => { order.push('a1'); await gate; order.push('a1done'); });
  const second = service.runMutation('alice', async () => { order.push('a2'); });
  const other = service.runMutation('bob', async () => { order.push('b1'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['a1', 'b1']);
  release();
  await Promise.all([first, second, other]);
  assert.deepEqual(order, ['a1', 'b1', 'a1done', 'a2']);
});

test('queue bounds, cancellation and timeout are deterministic', async () => {
  const service = createQuotaService({ maxMutationWaiters: 1, mutationWaitTimeoutMs: 20 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = service.runMutation('u', async () => gate);
  const queued = service.runMutation('u', async () => true);
  await assert.rejects(service.runMutation('u', async () => true), error => { expectCode(error, 'MUTATION_QUEUE_FULL'); return true; });
  await assert.rejects(queued, error => { expectCode(error, 'MUTATION_TIMEOUT'); return true; });
  release();
  await active;

  const controller = new AbortController();
  const active2 = service.runMutation('v', async () => new Promise(resolve => setTimeout(resolve, 15)));
  const cancelled = service.runMutation('v', async () => true, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, error => { expectCode(error, 'MUTATION_CANCELLED'); return true; });
  await active2;
});

test('upload limiter enforces cap and disk headroom uses injected statfs', async () => {
  const service = createQuotaService({ maxConcurrentUploads: 1, maxUploadWaiters: 2, uploadWaitTimeoutMs: 1000, minFreeBytes: 10 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0; let peak = 0;
  const one = service.withUploadLimit(async () => { active++; peak = Math.max(peak, active); await gate; active--; });
  const two = service.withUploadLimit(async () => { active++; peak = Math.max(peak, active); active--; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 1);
  release();
  await Promise.all([one, two]);
  assert.equal(peak, 1);
  const checked = await checkDiskHeadroom({ rootPath: '/explicit', requiredBytes: 20, minFreeBytes: 10, statfs: async () => ({ bavail: 3, bsize: 10 }) });
  assert.equal(checked.freeBytes, 30);
  await assert.rejects(checkDiskHeadroom({ rootPath: '/explicit', requiredBytes: 21, minFreeBytes: 10, statfs: async () => ({ bavail: 3, bsize: 10 }) }), error => { expectCode(error, 'DISK_HEADROOM'); return true; });
});

test('reconcile reports physical usage and persistence failures fail closed', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.messages, '1234');
  await fs.writeFile(path.join(f.uploads, 'x'), '123456');
  const service = createQuotaService({ defaultQuotaBytes: 20 });
  const result = await service.reconcileUsage({ userId: 'u', messagesFile: f.messages, uploadRoot: f.uploads, storageQuotaBytes: 0 });
  assert.equal(result.usageBytes, 10);
  assert.equal(result.quotaBytes, 20);
  let saved;
  await service.reconcileUsage({ messagesFile: f.messages, uploadRoot: f.uploads, persistUsage: async value => { saved = value; } });
  assert.equal(saved.storageBytes, 10);
  await assert.rejects(service.reconcileUsage({ messagesFile: f.messages, uploadRoot: f.uploads, persistUsage: async () => { throw new Error('disk'); } }), error => { expectCode(error, 'RECONCILE_PERSIST_FAILED'); return true; });
});
