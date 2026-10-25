'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// Q01 intentionally has no configuration or database imports. The application
// supplies the account value and the global default explicitly at startup.
const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MUTATION_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MUTATION_WAITERS = 256;
const DEFAULT_MAX_UPLOAD_WAITERS = 64;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;

class QuotaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new QuotaError(code, message, details);
}

function isSafeByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertByteCount(value, name = 'bytes') {
  if (!isSafeByteCount(value)) {
    fail('INVALID_BYTES', `${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_OPTION', `${name} must be a positive safe integer`);
  }
  return value;
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_OPTION', `${name} must be a non-negative safe integer`);
  }
  return value;
}

function resolveQuotaBytes(storageQuotaBytes, defaultQuotaBytes = DEFAULT_QUOTA_BYTES) {
  assertByteCount(defaultQuotaBytes, 'defaultQuotaBytes');
  const accountQuota = storageQuotaBytes === undefined || storageQuotaBytes === null
    ? 0
    : storageQuotaBytes;
  assertByteCount(accountQuota, 'storageQuotaBytes');
  // Zero inherits the default quota; disabling storage requires a separate policy.
  return accountQuota === 0 ? defaultQuotaBytes : accountQuota;
}

function calculateProposedUsage({ currentBytes, addedBytes = 0, releasedBytes = 0 } = {}) {
  assertByteCount(currentBytes, 'currentBytes');
  assertByteCount(addedBytes, 'addedBytes');
  assertByteCount(releasedBytes, 'releasedBytes');
  if (releasedBytes > currentBytes) {
    fail('INVALID_USAGE_DELTA', 'releasedBytes cannot exceed currentBytes');
  }
  const result = currentBytes - releasedBytes;
  if (addedBytes > Number.MAX_SAFE_INTEGER - result) {
    fail('USAGE_OVERFLOW', 'proposed usage exceeds the safe integer range');
  }
  return result + addedBytes;
}

function evaluateUsage({ currentBytes, proposedBytes, addedBytes, releasedBytes, storageQuotaBytes = 0, defaultQuotaBytes = DEFAULT_QUOTA_BYTES } = {}) {
  assertByteCount(currentBytes, 'currentBytes');
  const hasProposed = proposedBytes !== undefined;
  if (hasProposed && (addedBytes !== undefined || releasedBytes !== undefined)) {
    fail('INVALID_ARGUMENT', 'provide proposedBytes or an add/release delta, not both');
  }
  const proposed = hasProposed
    ? assertByteCount(proposedBytes, 'proposedBytes')
    : calculateProposedUsage({ currentBytes, addedBytes, releasedBytes });
  const quotaBytes = resolveQuotaBytes(storageQuotaBytes, defaultQuotaBytes);
  // A pre-existing over-quota account must be able to delete/reduce data. An
  // operation that grows usage is rejected until it is back within the cap.
  const allowed = proposed <= quotaBytes || proposed <= currentBytes;
  return {
    allowed,
    currentBytes,
    proposedBytes: proposed,
    quotaBytes,
    remainingBytes: proposed >= quotaBytes ? 0 : quotaBytes - proposed,
    exceededByBytes: proposed > quotaBytes ? proposed - quotaBytes : 0,
    isReduction: proposed < currentBytes
  };
}

function admitUsage(input) {
  const result = evaluateUsage(input);
  if (!result.allowed) {
    fail('QUOTA_EXCEEDED', 'storage quota exceeded', {
      currentBytes: result.currentBytes,
      proposedBytes: result.proposedBytes,
      quotaBytes: result.quotaBytes,
      exceededByBytes: result.exceededByBytes
    });
  }
  return result;
}

function assertUserId(userId) {
  if (userId !== null && userId !== undefined && (typeof userId !== 'string' || userId.length === 0)) {
    fail('INVALID_USER', 'userId must be a non-empty string or null');
  }
  return userId === null || userId === undefined ? '\u0000single-user' : userId;
}

function normalizePath(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_PATH', `${name} must be a non-empty path`);
  }
  return path.resolve(value);
}

function normalizeUsagePaths(options = {}) {
  const userRoot = options.userRoot === undefined ? options.dataRoot : options.userRoot;
  const messagesFile = options.messagesFile || options.messageFile ||
    (userRoot === undefined ? null : path.join(normalizePath(userRoot, 'userRoot'), 'messages.json'));
  const uploadRoot = options.uploadRoot ||
    (userRoot === undefined ? null : path.join(normalizePath(userRoot, 'userRoot'), 'uploads'));
  if (!messagesFile || !uploadRoot) {
    fail('INVALID_ARGUMENT', 'messagesFile and uploadRoot (or userRoot) are required');
  }
  return {
    messagesFile: normalizePath(messagesFile, 'messagesFile'),
    uploadRoot: normalizePath(uploadRoot, 'uploadRoot')
  };
}

async function lstat(fsApi, target) {
  try {
    return { exists: true, stat: await fsApi.lstat(target) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, stat: null };
    fail('PATH_STAT_FAILED', 'unable to inspect a storage path');
  }
}

// Parent directories belong to the operator and may themselves be symlinks
// Validate the explicit root/leaf and every child
// encountered during the recursive scan; do not reject trusted parents.
async function inspectPathComponents(target, fsApi) {
  const result = await lstat(fsApi, path.resolve(target));
  if (!result.exists) return result;
  if (result.stat.isSymbolicLink()) fail('SYMLINK_REJECTED', 'symbolic links are not permitted in storage paths');
  return result;
}

function addBytes(total, value) {
  if (!isSafeByteCount(value) || value > Number.MAX_SAFE_INTEGER - total) {
    fail('USAGE_OVERFLOW', 'storage usage exceeds the safe integer range');
  }
  return total + value;
}

async function scanUploadRoot(uploadRoot, fsApi) {
  const rootResult = await inspectPathComponents(uploadRoot, fsApi);
  if (!rootResult.exists) return { bytes: 0, fileCount: 0 };
  if (rootResult.stat.isSymbolicLink()) fail('SYMLINK_REJECTED', 'symbolic links are not permitted in storage paths');
  if (!rootResult.stat.isDirectory()) fail('INVALID_PATH', 'uploadRoot must be a directory');

  let total = 0;
  let fileCount = 0;
  const pending = [uploadRoot];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await fsApi.readdir(current, { withFileTypes: true });
    } catch {
      fail('PATH_READ_FAILED', 'unable to enumerate the upload directory');
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const result = await lstat(fsApi, fullPath);
      if (!result.exists) {
        // A concurrent writer removed a file. Reconciliation is fail-closed;
        // callers can retry after the user mutation queue is idle.
        fail('PATH_CHANGED', 'storage changed while usage was being measured');
      }
      const stat = result.stat;
      if (stat.isSymbolicLink()) fail('SYMLINK_REJECTED', 'symbolic links are not permitted in storage paths');
      if (stat.isDirectory()) {
        pending.push(fullPath);
      } else if (stat.isFile()) {
        if (stat.nlink !== undefined && stat.nlink !== 1) {
          fail('LINKED_FILE_REJECTED', 'linked files are not permitted in storage paths');
        }
        total = addBytes(total, stat.size);
        fileCount += 1;
      } else {
        fail('SPECIAL_FILE_REJECTED', 'special files are not permitted in storage paths');
      }
    }
  }
  return { bytes: total, fileCount };
}

async function scanMessageFile(messagesFile, fsApi) {
  const result = await inspectPathComponents(messagesFile, fsApi);
  if (!result.exists) return 0;
  if (result.stat.isSymbolicLink()) fail('SYMLINK_REJECTED', 'symbolic links are not permitted in storage paths');
  if (!result.stat.isFile()) fail('SPECIAL_FILE_REJECTED', 'messagesFile must be a regular file');
  if (result.stat.nlink !== undefined && result.stat.nlink !== 1) {
    fail('LINKED_FILE_REJECTED', 'linked files are not permitted in storage paths');
  }
  return result.stat.size;
}

/**
 * Measure the physical account footprint. The result is deliberately an
 * object so reconciliation can report the JSON and attachment portions while
 * `bytes` remains the value persisted as users.storage_bytes.
 */
async function measurePhysicalUsage(options = {}) {
  const paths = normalizeUsagePaths(options);
  const fsApi = options.fsApi || fs;
  const messagesBytes = await scanMessageFile(paths.messagesFile, fsApi);
  const uploads = await scanUploadRoot(paths.uploadRoot, fsApi);
  const bytes = addBytes(messagesBytes, uploads.bytes);
  return {
    bytes,
    messagesBytes,
    uploadsBytes: uploads.bytes,
    fileCount: uploads.fileCount
  };
}

async function measurePhysicalBytes(options = {}) {
  return (await measurePhysicalUsage(options)).bytes;
}

function normalizeStatfsResult(stats) {
  if (!stats || typeof stats !== 'object') fail('DISK_STAT_INVALID', 'disk statistics are invalid');
  const blocksAvailable = stats.bavail ?? stats.bfree;
  const blockSize = stats.bsize ?? stats.frsize;
  if (!Number.isSafeInteger(blocksAvailable) || blocksAvailable < 0 ||
      !Number.isSafeInteger(blockSize) || blockSize < 1 ||
      blocksAvailable > Math.floor(Number.MAX_SAFE_INTEGER / blockSize)) {
    fail('DISK_STAT_INVALID', 'disk statistics are invalid');
  }
  return blocksAvailable * blockSize;
}

async function checkDiskHeadroom({ rootPath, path: pathValue, requiredBytes = 0, minFreeBytes = 0, statfs } = {}) {
  const target = normalizePath(rootPath || pathValue, 'rootPath');
  assertByteCount(requiredBytes, 'requiredBytes');
  assertByteCount(minFreeBytes, 'minFreeBytes');
  const statfsFn = statfs || fs.statfs;
  if (typeof statfsFn !== 'function') fail('DISK_STAT_UNAVAILABLE', 'filesystem free-space statistics are unavailable');
  let stats;
  try {
    stats = await statfsFn(target);
  } catch {
    fail('DISK_STAT_FAILED', 'unable to inspect filesystem free space');
  }
  const freeBytes = normalizeStatfsResult(stats);
  const requiredTotal = addBytes(requiredBytes, minFreeBytes);
  if (freeBytes < requiredTotal) {
    fail('DISK_HEADROOM', 'minimum free disk headroom is unavailable', {
      freeBytes,
      requiredBytes,
      minFreeBytes,
      requiredTotal
    });
  }
  return { freeBytes, requiredBytes, minFreeBytes, requiredTotal };
}

function normalizeTimeout(value, name, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < 0) fail('INVALID_OPTION', `${name} must be a non-negative finite number`);
  return result;
}

function cancellationError(code, message) {
  return new QuotaError(code, message);
}

class UserMutationQueue {
  constructor({ maxWaiters, timeoutMs }) {
    this.maxWaiters = maxWaiters;
    this.timeoutMs = timeoutMs;
    this.states = new Map();
    this.pendingCount = 0;
    this.drainWaiters = [];
  }

  run(userId, task, options = {}) {
    if (typeof task !== 'function') fail('INVALID_ARGUMENT', 'mutation task must be a function');
    const key = assertUserId(userId);
    const signal = options.signal;
    if (signal && signal.aborted) {
      return Promise.reject(cancellationError('MUTATION_CANCELLED', 'mutation was cancelled before it started'));
    }
    if (this.pendingCount >= this.maxWaiters) {
      return Promise.reject(new QuotaError('MUTATION_QUEUE_FULL', 'mutation queue is full'));
    }
    const timeoutMs = normalizeTimeout(options.timeoutMs, 'mutation timeoutMs', this.timeoutMs);
    let state = this.states.get(key);
    if (!state) {
      state = { userId, running: false, entries: [] };
      this.states.set(key, state);
    }

    return new Promise((resolve, reject) => {
      const entry = {
        userId,
        task,
        signal,
        resolve,
        reject,
        started: false,
        timer: null,
        abortHandler: null
      };
      const removePending = (error) => {
        if (entry.started) return false;
        const index = state.entries.indexOf(entry);
        if (index < 0) return false;
        state.entries.splice(index, 1);
        this.pendingCount -= 1;
        if (entry.timer) clearTimeout(entry.timer);
        if (signal && entry.abortHandler) signal.removeEventListener('abort', entry.abortHandler);
        reject(error);
        this.cleanupState(key, state);
        this.pump(key, state);
        return true;
      };
      entry.removePending = removePending;
      if (signal) {
        entry.abortHandler = () => removePending(cancellationError('MUTATION_CANCELLED', 'mutation was cancelled while waiting'));
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      if (timeoutMs !== Infinity && timeoutMs > 0) {
        entry.timer = setTimeout(() => removePending(new QuotaError('MUTATION_TIMEOUT', 'mutation queue wait timed out')), timeoutMs);
      } else if (timeoutMs === 0) {
        entry.timer = setTimeout(() => removePending(new QuotaError('MUTATION_TIMEOUT', 'mutation queue wait timed out')), 0);
      }
      state.entries.push(entry);
      this.pendingCount += 1;
      this.pump(key, state);
    });
  }

  pump(key, state = this.states.get(key)) {
    if (!state || state.running || state.entries.length === 0) {
      this.cleanupState(key, state);
      this.resolveDrainsIfIdle();
      return;
    }
    const entry = state.entries.shift();
    this.pendingCount -= 1;
    entry.started = true;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.abortHandler) entry.signal.removeEventListener('abort', entry.abortHandler);
    state.running = true;
    Promise.resolve()
      .then(() => entry.task({ userId: entry.userId, signal: entry.signal }))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        state.running = false;
        this.cleanupState(key, state);
        this.pump(key, state);
        this.resolveDrainsIfIdle();
      });
  }

  cleanupState(key, state) {
    if (state && !state.running && state.entries.length === 0) this.states.delete(key);
  }

  resolveDrainsIfIdle() {
    if (this.states.size !== 0 || this.pendingCount !== 0) return;
    const waiters = this.drainWaiters.splice(0);
    waiters.forEach(resolve => resolve());
  }

  drain() {
    if (this.states.size === 0 && this.pendingCount === 0) return Promise.resolve();
    return new Promise(resolve => this.drainWaiters.push(resolve));
  }

  stats() {
    return {
      activeUsers: Array.from(this.states.values()).filter(state => state.running).length,
      pendingWaiters: this.pendingCount,
      users: Array.from(this.states.values()).map(state => ({
        userId: state.userId,
        running: state.running,
        pending: state.entries.length
      }))
    };
  }
}

class UploadLimiter {
  constructor({ maxConcurrent, maxWaiters, timeoutMs }) {
    this.maxConcurrent = maxConcurrent;
    this.maxWaiters = maxWaiters;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.pending = [];
    this.drainWaiters = [];
  }

  run(task, options = {}) {
    if (typeof task !== 'function') fail('INVALID_ARGUMENT', 'upload task must be a function');
    const signal = options.signal;
    if (signal && signal.aborted) {
      return Promise.reject(cancellationError('UPLOAD_CANCELLED', 'upload was cancelled before it started'));
    }
    if (this.pending.length >= this.maxWaiters) {
      return Promise.reject(new QuotaError('UPLOAD_QUEUE_FULL', 'upload queue is full'));
    }
    const timeoutMs = normalizeTimeout(options.timeoutMs, 'upload timeoutMs', this.timeoutMs);
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, started: false, timer: null, abortHandler: null };
      const removePending = (error) => {
        if (entry.started) return false;
        const index = this.pending.indexOf(entry);
        if (index < 0) return false;
        this.pending.splice(index, 1);
        if (entry.timer) clearTimeout(entry.timer);
        if (signal && entry.abortHandler) signal.removeEventListener('abort', entry.abortHandler);
        reject(error);
        this.resolveDrainsIfIdle();
        this.pump();
        return true;
      };
      entry.removePending = removePending;
      if (signal) {
        entry.abortHandler = () => removePending(cancellationError('UPLOAD_CANCELLED', 'upload was cancelled while waiting'));
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      if (timeoutMs !== Infinity && timeoutMs > 0) {
        entry.timer = setTimeout(() => removePending(new QuotaError('UPLOAD_TIMEOUT', 'upload queue wait timed out')), timeoutMs);
      } else if (timeoutMs === 0) {
        entry.timer = setTimeout(() => removePending(new QuotaError('UPLOAD_TIMEOUT', 'upload queue wait timed out')), 0);
      }
      this.pending.push(entry);
      this.pump();
    });
  }

  pump() {
    while (this.active < this.maxConcurrent && this.pending.length) {
      const entry = this.pending.shift();
      entry.started = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.signal && entry.abortHandler) entry.signal.removeEventListener('abort', entry.abortHandler);
      this.active += 1;
      Promise.resolve()
        .then(() => entry.task({ signal: entry.signal }))
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
          this.resolveDrainsIfIdle();
        });
    }
  }

  resolveDrainsIfIdle() {
    if (this.active !== 0 || this.pending.length !== 0) return;
    const waiters = this.drainWaiters.splice(0);
    waiters.forEach(resolve => resolve());
  }

  drain() {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise(resolve => this.drainWaiters.push(resolve));
  }

  stats() {
    return { active: this.active, pendingWaiters: this.pending.length, maxConcurrent: this.maxConcurrent };
  }
}

function createQuotaService(options = {}) {
  const defaultQuotaBytes = options.defaultQuotaBytes === undefined
    ? DEFAULT_QUOTA_BYTES
    : assertNonNegativeInteger(options.defaultQuotaBytes, 'defaultQuotaBytes');
  const maxMutationWaiters = options.maxMutationWaiters === undefined
    ? DEFAULT_MAX_MUTATION_WAITERS
    : assertNonNegativeInteger(options.maxMutationWaiters, 'maxMutationWaiters');
  const maxUploadWaiters = options.maxUploadWaiters === undefined
    ? DEFAULT_MAX_UPLOAD_WAITERS
    : assertNonNegativeInteger(options.maxUploadWaiters, 'maxUploadWaiters');
  const maxConcurrentUploads = options.maxConcurrentUploads === undefined
    ? DEFAULT_MAX_CONCURRENT_UPLOADS
    : assertPositiveInteger(options.maxConcurrentUploads, 'maxConcurrentUploads');
  const mutationTimeoutMs = options.mutationWaitTimeoutMs === undefined
    ? DEFAULT_MUTATION_TIMEOUT_MS
    : normalizeTimeout(options.mutationWaitTimeoutMs, 'mutationWaitTimeoutMs', DEFAULT_MUTATION_TIMEOUT_MS);
  const uploadTimeoutMs = options.uploadWaitTimeoutMs === undefined
    ? DEFAULT_UPLOAD_TIMEOUT_MS
    : normalizeTimeout(options.uploadWaitTimeoutMs, 'uploadWaitTimeoutMs', DEFAULT_UPLOAD_TIMEOUT_MS);
  const minFreeBytes = options.minFreeBytes === undefined
    ? 0
    : assertNonNegativeInteger(options.minFreeBytes, 'minFreeBytes');
  const statfs = options.statfs;
  const mutations = new UserMutationQueue({ maxWaiters: maxMutationWaiters, timeoutMs: mutationTimeoutMs });
  const uploads = new UploadLimiter({ maxConcurrent: maxConcurrentUploads, maxWaiters: maxUploadWaiters, timeoutMs: uploadTimeoutMs });

  async function reconcileUsage(input = {}) {
    if (typeof input.persistUsage !== 'undefined' && typeof input.persistUsage !== 'function') {
      fail('INVALID_ARGUMENT', 'persistUsage must be a function');
    }
    const details = await measurePhysicalUsage(input);
    const currentBytes = input.currentBytes === undefined ? details.bytes : assertByteCount(input.currentBytes, 'currentBytes');
    const quota = resolveQuotaBytes(input.storageQuotaBytes, input.defaultQuotaBytes === undefined ? defaultQuotaBytes : input.defaultQuotaBytes);
    const admission = evaluateUsage({ currentBytes, proposedBytes: details.bytes, storageQuotaBytes: input.storageQuotaBytes, defaultQuotaBytes: quota });
    const result = {
      userId: input.userId === undefined ? null : input.userId,
      usageBytes: details.bytes,
      messagesBytes: details.messagesBytes,
      uploadsBytes: details.uploadsBytes,
      fileCount: details.fileCount,
      quotaBytes: quota,
      overQuota: details.bytes > quota,
      canGrow: admission.allowed,
      admission
    };
    if (input.persistUsage) {
      try {
        await input.persistUsage({ userId: result.userId, storageBytes: result.usageBytes, usageBytes: result.usageBytes });
      } catch {
        fail('RECONCILE_PERSIST_FAILED', 'unable to persist reconciled storage usage');
      }
    }
    return result;
  }

  async function reconcileUsers(entries, options = {}) {
    if (!Array.isArray(entries)) fail('INVALID_ARGUMENT', 'reconcile entries must be an array');
    const results = [];
    for (const entry of entries) {
      try {
        results.push(await reconcileUsage({ ...entry, persistUsage: entry.persistUsage || options.persistUsage }));
      } catch (error) {
        if (error instanceof QuotaError && error.code === 'RECONCILE_PERSIST_FAILED') throw error;
        fail('RECONCILE_FAILED', 'storage usage reconciliation failed', { userId: entry && entry.userId });
      }
    }
    return results;
  }

  return Object.freeze({
    defaultQuotaBytes,
    minFreeBytes,
    runMutation(userId, task, taskOptions) { return mutations.run(userId, task, taskOptions); },
    withUserMutation(userId, task, taskOptions) { return mutations.run(userId, task, taskOptions); },
    withUploadLimit(task, taskOptions) { return uploads.run(task, taskOptions); },
    runUpload(task, taskOptions) { return uploads.run(task, taskOptions); },
    measurePhysicalUsage,
    measurePhysicalBytes,
    measureUsage: measurePhysicalBytes,
    calculateProposedUsage,
    evaluateUsage(input) {
      return evaluateUsage({ ...input, defaultQuotaBytes: input?.defaultQuotaBytes === undefined ? defaultQuotaBytes : input.defaultQuotaBytes });
    },
    admitUsage(input) {
      return admitUsage({ ...input, defaultQuotaBytes: input?.defaultQuotaBytes === undefined ? defaultQuotaBytes : input.defaultQuotaBytes });
    },
    resolveQuotaBytes(storageQuotaBytes) { return resolveQuotaBytes(storageQuotaBytes, defaultQuotaBytes); },
    checkDiskHeadroom(rootPath, requiredBytes = 0, extra = {}) {
      return checkDiskHeadroom({ rootPath, requiredBytes, minFreeBytes: extra.minFreeBytes === undefined ? minFreeBytes : extra.minFreeBytes, statfs: extra.statfs || statfs });
    },
    reconcileUsage,
    reconcileUsers,
    mutationStats() { return mutations.stats(); },
    uploadStats() { return uploads.stats(); },
    async drain() { await mutations.drain(); await uploads.drain(); }
  });
}

module.exports = {
  DEFAULT_QUOTA_BYTES,
  QuotaError,
  isSafeByteCount,
  resolveQuotaBytes,
  calculateProposedUsage,
  evaluateUsage,
  admitUsage,
  measurePhysicalUsage,
  measurePhysicalBytes,
  measureUsage: measurePhysicalBytes,
  checkDiskHeadroom,
  createQuotaService
};
