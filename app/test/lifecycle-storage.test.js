const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function loadModule(name, dependencies, globals = {}) {
  const filename = path.join(__dirname, '../src', name);
  const source = await fs.readFile(filename, 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(id) { return Object.hasOwn(dependencies, id) ? dependencies[id] : require(id); },
    console: { log() {}, error() {} }, setImmediate, clearImmediate,
    setInterval, clearInterval, ...globals
  }, { filename });
  return module.exports;
}
async function storageFixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = await loadModule('storage.js', {
    'fs/promises': { ...fs, ...overrides },
    './config': { MULTI_USER_MODE: true, STORAGE_ROOT: root, UPLOAD_ROOT: path.join(root, 'uploads'), userPasswordMap: new Map() },
    './utils': { ensureDir: dir => fs.mkdir(dir, { recursive: true }), clampPageSize: x => x }
  });
  return { root, storage };
}

test('flush writes only dirty users to isolated real data files', async t => {
  const { storage } = await storageFixture(t);
  storage.getUserState('a').messages.push({ id: 'a' });
  storage.getUserState('untouched');
  storage.schedulePersist('a');
  await storage.flushPendingPersist();
  assert.equal(storage.hasPendingPersist(), false);
  assert.equal(JSON.parse(await fs.readFile(storage.getDataFile('a'), 'utf8')).messages[0].id, 'a');
  await assert.rejects(fs.access(storage.getDataFile('untouched')), { code: 'ENOENT' });
});

test('flush shares an active drain and persists changes made during IO', async t => {
  const started = deferred(), release = deferred();
  let writes = 0;
  const { storage } = await storageFixture(t, {
    async open(...args) {
      const handle = await fs.open(...args);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => {
        if (++writes === 1) { started.resolve(); await release.promise; }
        return writeFile(...writeArgs);
      };
      return handle;
    }
  });
  storage.getUserState('a').messages.push({ id: 'first' });
  storage.schedulePersist('a');
  const flushing = storage.flushPendingPersist();
  await started.promise;
  storage.getUserState('a').messages.push({ id: 'second' });
  storage.schedulePersist('a');
  assert.equal(storage.flushPendingPersist(), flushing);
  release.resolve();
  await flushing;
  assert.equal(writes, 2);
  assert.equal(JSON.parse(await fs.readFile(storage.getDataFile('a'), 'utf8')).messages.length, 2);
  assert.equal(storage.hasPendingPersist(), false);
});

test('failure rejects flush, retains dirty users and does not busy retry; explicit retry succeeds', async t => {
  let failing = true, attempts = 0;
  const { storage } = await storageFixture(t, {
    async open(...args) {
      const handle = await fs.open(...args);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => {
        attempts++;
        if (failing && String(args[0]).includes('/a/')) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
        return writeFile(...writeArgs);
      };
      return handle;
    }
  });
  storage.schedulePersist('a'); storage.schedulePersist('b');
  await assert.rejects(storage.flushPendingPersist(), error => error.name === 'AggregateError' && error.errors[0].code === 'EIO');
  assert.equal(storage.hasPendingPersist(), true);
  assert.equal(attempts, 2);
  await turn(); await turn();
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await fs.readFile(storage.getDataFile('b'), 'utf8')).messages.length, 0);
  failing = false;
  await storage.flushPendingPersist();
  assert.equal(attempts, 3);
  assert.equal(storage.hasPendingPersist(), false);
});

async function schedulerFixture(job) {
  const timers = [];
  const cleanup = await loadModule('cleanup.js', {
    './config': { MULTI_USER_MODE: false, EXPIRE_TIME: Infinity, FILE_CLEANUP_INTERVAL_MINUTES: 30 },
    './storage': { getUserState: () => ({ messages: [] }), hasUserState: () => false },
    './upload': {}, './utils': {}, './socket': {}, './quota': { measurePhysicalUsage: async () => ({ bytes: 0 }) },
    './share': { cleanupExpiredShares: job, deleteSharesByMessageId: async () => {} }
  }, {
    setInterval(fn) { const timer = { fn, cleared: false }; timers.push(timer); return timer; },
    clearInterval(timer) { timer.cleared = true; }
  });
  return { stop: cleanup.startCleanupSchedulers(), timers };
}

test('stop waits for initial cleanup and blocks queued interval callbacks', async () => {
  const release = deferred(); let calls = 0;
  const { stop, timers } = await schedulerFixture(async () => { calls++; await release.promise; });
  const stopping = stop();
  assert.equal(stop(), stopping);
  let done = false; stopping.then(() => { done = true; });
  await turn();
  assert.equal(calls, 1); assert.equal(done, false);
  assert.ok(timers.every(timer => timer.cleared));
  timers.forEach(timer => timer.fn());
  release.resolve(); await stopping;
  timers.forEach(timer => timer.fn()); await turn();
  assert.equal(calls, 1);
});

test('same-kind interval cleanup never overlaps; stop waits for active rejection', async () => {
  const release = deferred(); let calls = 0;
  const { stop, timers } = await schedulerFixture(async () => {
    calls++;
    if (calls === 2) { await release.promise; throw new Error('cleanup failed'); }
  });
  await turn();
  timers[2].fn(); timers[2].fn();
  await turn(); assert.equal(calls, 2);
  const stopping = stop(); let done = false; stopping.then(() => { done = true; });
  await turn(); assert.equal(done, false);
  release.resolve(); await stopping;
  timers[2].fn(); await turn(); assert.equal(calls, 2);
});
