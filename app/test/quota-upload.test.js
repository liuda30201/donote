'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQuotaService, QuotaError } = require('../src/quota');

test('upload quota primitives enforce actual bytes and global concurrency', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-upload-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = createQuotaService({ maxConcurrentUploads: 1, maxUploadWaiters: 1 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0; let peak = 0;
  const first = service.withUploadLimit(async () => { active++; peak = Math.max(peak, active); await gate; active--; });
  const second = service.withUploadLimit(async () => { active++; peak = Math.max(peak, active); active--; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(peak, 1);
});

test('quota admission rejects growth but allows reduction of over-quota usage', () => {
  const service = createQuotaService({ defaultQuotaBytes: 100 });
  assert.throws(() => service.admitUsage({ currentBytes: 100, proposedBytes: 101, storageQuotaBytes: 0 }), e => e.code === 'QUOTA_EXCEEDED');
  assert.equal(service.admitUsage({ currentBytes: 120, proposedBytes: 110, storageQuotaBytes: 100 }).allowed, true);
});

test('abort signal cancels queued upload before it starts', async () => {
  const service = createQuotaService({ maxConcurrentUploads: 1, maxUploadWaiters: 2 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = service.withUploadLimit(() => gate);
  const controller = new AbortController();
  const queued = service.withUploadLimit(() => true, { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, error => error instanceof QuotaError && error.code === 'UPLOAD_CANCELLED');
  release();
  await active;
});
