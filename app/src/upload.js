'use strict';
const fs = require('node:fs/promises');
const { createWriteStream, constants } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const multer = require('multer');
const { STORAGE_ROOT, ACCOUNTS_MODE } = require('./config');
const storage = require('./storage');
const { createQuotaService, QuotaError, measurePhysicalUsage } = require('./quota');
const { ensureDir, toDateFolder, sanitizeFilename, extensionFromMime, withPreferredExt, toPosixPath } = require('./utils');

const operations = new AsyncLocalStorage();
const activeFiles = new Set();
const fallbackLimiter = createQuotaService();
let configuredPolicy = null;
const uploadLimits = Object.freeze({ fileSize: 100 * 1024 * 1024, files: 2, fields: 8, parts: 10, fieldSize: 64 * 1024 });
const MAX_REQUEST_FILE_BYTES = uploadLimits.fileSize * uploadLimits.files;

// Startup contract: storage.configureMutationRunner(service.runMutation), then
// configureUploadPolicy({quotaService:service,getStorageQuotaBytes,afterCommit}).
// admitCandidate may replace the built-in quota calculation; it runs LOCKED.
function configureUploadPolicy(policy) {
  if (policy !== null && (!policy || typeof policy !== 'object')) throw new TypeError('Invalid upload policy');
  configuredPolicy = policy;
}
function resolveUploadPolicy(req) {
  const policy = req?.app?.get('uploadPolicy') || configuredPolicy;
  const quotaService = req?.app?.get('quotaService') || policy?.quotaService || (typeof policy?.admitUsage === 'function' ? policy : null);
  const result = { ...(policy || {}), quotaService };
  if (ACCOUNTS_MODE && (typeof result.admitCandidate !== 'function' &&
      (!quotaService || typeof result.getStorageQuotaBytes !== 'function'))) {
    throw new QuotaError('UPLOAD_POLICY_UNAVAILABLE', 'Upload policy unavailable');
  }
  if (quotaService && typeof quotaService.withUploadLimit !== 'function') throw new QuotaError('UPLOAD_POLICY_UNAVAILABLE', 'Upload policy unavailable');
  return result;
}
function getActiveTempFiles() { return new Set(activeFiles); }
function isActiveUploadPath(filePath) { return activeFiles.has(path.resolve(filePath)); }
function ownFile(filePath, owner = operations.getStore()) {
  if (owner) {
    owner.files.add(filePath);
    activeFiles.add(path.resolve(filePath));
  }
}
function abortError() { return new QuotaError('UPLOAD_CANCELLED', 'Upload cancelled'); }
function assertNotAborted(signal) { if (signal?.aborted) throw abortError(); }
async function unlinkOwned(filePath) {
  try { await fs.unlink(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function withUploadOperation(task, { req, signal, policy = resolveUploadPolicy(req), timeoutMs = 120000 } = {}) {
  const limiter = policy.quotaService || fallbackLimiter;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req?.once('aborted', abort);
  signal?.addEventListener('abort', abort, { once: true });
  if (req?.aborted || signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await limiter.withUploadLimit(() => operations.run({ files: new Set(), signal: controller.signal, policy, published: false }, async () => {
      const op = operations.getStore();
      try { assertNotAborted(op.signal); return await task(op); }
      finally {
        try {
          for (const file of op.files) {
            if (!op.published || file.startsWith(`${path.resolve(STORAGE_ROOT, 'temp')}${path.sep}`)) await unlinkOwned(file);
          }
        } finally {
          for (const file of op.files) {
            const resolved = path.resolve(file);
            activeFiles.delete(resolved);
          }
        }
      }
    }), { signal: controller.signal });
  } finally { clearTimeout(timer); req?.removeListener('aborted', abort); signal?.removeEventListener('abort', abort); }
}

const multerStorage = {
  _handleFile(req, file, cb) {
    const op = operations.getStore();
    const target = path.join(STORAGE_ROOT, 'temp', randomUUID());
    const work = async () => {
      if (!op) throw new QuotaError('UPLOAD_OPERATION_REQUIRED', 'Upload operation required');
      await ensureDir(path.dirname(target));
      assertNotAborted(op.signal);
      if (op.policy.quotaService) await op.policy.quotaService.checkDiskHeadroom(path.dirname(target), uploadLimits.fileSize);
      // Claim a unique path before streaming; no overwrite or arbitrary filename.
      const handle = await fs.open(target, 'wx', 0o600);
      ownFile(target, op);
      let size = 0;
      const meter = new Transform({ transform(chunk, encoding, done) {
        size += chunk.length;
        req.__uploadBytes = (req.__uploadBytes || 0) + chunk.length;
        if (size > uploadLimits.fileSize || req.__uploadBytes > MAX_REQUEST_FILE_BYTES) return done(new QuotaError('UPLOAD_TOO_LARGE', 'Upload too large'));
        done(null, chunk);
      } });
      try {
        await pipeline(file.stream, meter, createWriteStream(target, { fd: handle.fd, autoClose: false }), { signal: op.signal });
        await handle.sync();
      } finally { await handle.close(); }
      return { path: target, size };
    };
    work().then(result => cb(null, result), error => cb(error));
  },
  _removeFile(req, file, cb) { unlinkOwned(file.path).then(() => cb(null), cb); }
};
const uploadMiddleware = multer({ storage: multerStorage, limits: uploadLimits });

function resolveUploadAbsolute(relativePath, userId = null) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) throw new QuotaError('INVALID_PATH', 'Invalid upload path');
  const root = path.resolve(storage.getUploadRoot(userId));
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new QuotaError('INVALID_PATH', 'Invalid upload path');
  return absolute;
}
async function safeUploadPath(relativePath, userId, create = false) {
  const target = resolveUploadAbsolute(relativePath, userId);
  const root = path.resolve(storage.getUploadRoot(userId));
  if (create) await ensureDir(root);
  const components = [root];
  const rel = path.relative(root, path.dirname(target));
  if (rel) for (const part of rel.split(path.sep)) components.push(path.join(components[components.length - 1], part));
  for (const dir of components) {
    if (create) { try { await fs.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new QuotaError('INVALID_PATH', 'Unsafe upload directory');
  }
  return target;
}
async function actualFileBytes(filePath) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)) throw new QuotaError('INVALID_PATH', 'Unsafe upload file');
  return stat.size;
}
async function publishTempFile(tempPath, relativePath, userId) {
  const op = operations.getStore();
  if (!op || !op.files.has(tempPath)) throw new QuotaError('UPLOAD_OPERATION_REQUIRED', 'Unowned temporary file');
  assertNotAborted(op.signal);
  const target = await safeUploadPath(relativePath, userId, true);
  // COPYFILE_EXCL never replaces an existing resource. Keep temp until commit.
  try { await fs.copyFile(tempPath, target, constants.COPYFILE_EXCL); } catch (error) {
    // Failed copies may leave partial output. Only this generated target is owned.
    if (error.code !== 'EEXIST') { ownFile(target); }
    throw error;
  }
  ownFile(target);
  const handle = await fs.open(target, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return actualFileBytes(target);
}
async function writeBinaryToUpload({ category, id, buffer, mimeType, filenameHint, suffix = '', userId = null }) {
  if (!Buffer.isBuffer(buffer) || buffer.length > uploadLimits.fileSize) throw new QuotaError('UPLOAD_TOO_LARGE', 'Invalid upload buffer');
  if (!['files', 'images'].includes(category) || typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9_-]*$/.test(suffix)) throw new QuotaError('INVALID_PATH', 'Invalid upload identity');
  const op = operations.getStore();
  if (ACCOUNTS_MODE && !op) throw new QuotaError('UPLOAD_OPERATION_REQUIRED', 'Upload operation required');
  assertNotAborted(op?.signal);
  const finalName = withPreferredExt(sanitizeFilename(filenameHint || 'file'), extensionFromMime(mimeType));
  const parsed = path.parse(finalName);
  const leaf = category === 'files' ? `${id}-${parsed.name}${parsed.ext}` : `${id}${suffix}${parsed.ext || extensionFromMime(mimeType) || '.bin'}`;
  const relativePath = path.join(category, toDateFolder(), leaf);
  const absolute = await safeUploadPath(relativePath, userId, true);
  if (op?.policy.quotaService) await op.policy.quotaService.checkDiskHeadroom(path.dirname(absolute), buffer.length);
  const handle = await fs.open(absolute, 'wx', 0o600);
  ownFile(absolute);
  try { await handle.writeFile(buffer); await handle.sync(); } catch (error) { await unlinkOwned(absolute); throw error; } finally { await handle.close(); }
  return toPosixPath(relativePath);
}

// Must be called once, not wrapped in commitUserMutation (which acquires the
// same queue). Candidate JSON matches persistCandidateLocked serialization.
async function commitUploadMutation(userId, mutate, { policy = configuredPolicy || {}, signal } = {}) {
  // A queued callback may be started by the previous request's promise chain.
  // Restore this request's owner explicitly when its mutation starts.
  const owner = operations.getStore();
  return storage.withUserMutation(userId, () => operations.run(owner, async () => {
    const op = operations.getStore();
    assertNotAborted(signal || op?.signal);
    const state = storage.getUserState(userId);
    try {
    // Baseline MUST be captured before mutate publishes any attachment files.
    const currentUsage = policy.quotaService || policy.admitCandidate
      ? await measurePhysicalUsage({ messagesFile: storage.getDataFile(userId), uploadRoot: storage.getUploadRoot(userId) })
      : null;
    const candidate = structuredClone(state);
    const result = await mutate(candidate);
    candidate.lastActivity = Date.now();
    const candidateJsonBytes = Buffer.byteLength(JSON.stringify(candidate, null, 2));
    if (policy.admitCandidate) await policy.admitCandidate({ userId, candidate, currentBytes: currentUsage.bytes });
    else if (policy.quotaService) {
      const afterFiles = await measurePhysicalUsage({ messagesFile: storage.getDataFile(userId), uploadRoot: storage.getUploadRoot(userId) });
      const quota = await policy.getStorageQuotaBytes(userId);
      const proposedBytes = afterFiles.uploadsBytes + candidateJsonBytes;
      policy.quotaService.admitUsage({ currentBytes: currentUsage.bytes, addedBytes: Math.max(0, proposedBytes - currentUsage.bytes), releasedBytes: Math.max(0, currentUsage.bytes - proposedBytes), storageQuotaBytes: quota });
    } else if (ACCOUNTS_MODE) throw new QuotaError('UPLOAD_POLICY_UNAVAILABLE', 'Upload policy unavailable');
    assertNotAborted(signal || op?.signal);
    await storage.persistCandidateLocked(userId, candidate);
    if (op) op.published = true; // Never unlink attachments after durable JSON.
    state.messages = candidate.messages; state.lastActivity = candidate.lastActivity;
    if (policy.afterCommit) {
      const actual = await measurePhysicalUsage({ messagesFile: storage.getDataFile(userId), uploadRoot: storage.getUploadRoot(userId) });
      try {
        await policy.afterCommit({ userId, operation: 'upload', bytesDelta: actual.bytes - (currentUsage?.bytes || 0), storageRoot: storage.getUploadRoot(userId), dataFile: storage.getDataFile(userId), actualBytes: actual.bytes });
      } catch (cause) {
        const error = new QuotaError('USAGE_RECONCILE_REQUIRED', 'Upload committed; usage reconciliation required');
        error.committed = true;
        error.cause = cause;
        throw error;
      }
    }
    return result;
    } finally {
      // Roll back owned unpublished targets before releasing the user lock.
      // Otherwise the next mutation could charge another request's failed files.
      if (op && !op.published) for (const file of op.files) await unlinkOwned(file);
    }
  }), { signal: signal || owner?.signal });
}
async function removeFileIfExists(relativePath, userId = null) {
  if (!relativePath) return false;
  try { const absolute = await safeUploadPath(relativePath, userId); if (isActiveUploadPath(absolute)) return false; await fs.unlink(absolute); return true; }
  catch (error) { if (error && ['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}
function getMessageFileRefs(message) {
  if (!message || typeof message.content !== 'object' || !message.content) return [];
  const refs = message.type === 'image' ? [message.content.thumbnailPath, message.content.originalPath] : message.type === 'file' ? [message.content.filePath] : [];
  return [...new Set(refs.filter(ref => typeof ref === 'string'))];
}
async function deleteMessageFiles(message, userId = null) { for (const ref of getMessageFileRefs(message)) await removeFileIfExists(ref, userId); }
module.exports = { uploadMiddleware, uploadLimits, configureUploadPolicy, resolveUploadPolicy, withUploadOperation, commitUploadMutation, publishTempFile, actualFileBytes, getActiveTempFiles, isActiveUploadPath, writeBinaryToUpload, resolveUploadAbsolute, removeFileIfExists, getMessageFileRefs, deleteMessageFiles };
