'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createQuotaService, QuotaError } = require('./quota');

// One process owns all writes. JSON is authoritative; SQLite usage is reconciled.
function configureAccountQuota({ storage, upload, repo, env = process.env, storageRoot }) {
  const configured = env.DONOTE_DEFAULT_QUOTA_BYTES;
  if (configured !== undefined && !/^(0|[1-9][0-9]*)$/.test(configured)) throw new TypeError('Invalid DONOTE_DEFAULT_QUOTA_BYTES');
  const defaultQuotaBytes = configured === undefined ? undefined : Number(configured);
  const quotaService = createQuotaService({ defaultQuotaBytes });
  const context = new AsyncLocalStorage();
  const blocked = new Set();
  const usagePaths = userId => ({ messagesFile: storage.getDataFile(userId), uploadRoot: storage.getUploadRoot(userId) });
  function account(userId) {
    const user = repo.findUserById(userId);
    if (!user || user.deleted_at != null) throw new QuotaError('ACCOUNT_UNAVAILABLE', 'Account unavailable');
    return user;
  }
  async function reconcile(userId) {
    const measured = await quotaService.measurePhysicalUsage(usagePaths(userId));
    if (!repo.setStorageUsage({ userId, storageBytes: measured.bytes })) throw new QuotaError('USAGE_RECONCILE_REQUIRED', 'Storage reconciliation required');
    return measured;
  }
  storage.configureMutationRunner((userId, task, options) => quotaService.runMutation(userId, async () => {
    if (blocked.has(userId)) throw new QuotaError('USAGE_RECONCILE_REQUIRED', 'Storage reconciliation required');
    account(userId);
    const baseline = await quotaService.measurePhysicalUsage(usagePaths(userId));
    return context.run({ userId, baseline }, async () => {
      try { return await task(); }
      finally {
        try { await reconcile(userId); }
        catch { blocked.add(userId); }
      }
    });
  }, options));
  storage.configurePersistencePolicy({
    async beforePersist(userId, candidate) {
      const current = context.getStore();
      if (!current || current.userId !== userId || blocked.has(userId)) throw new QuotaError('MUTATION_REQUIRED', 'Storage mutation required');
      const measured = await quotaService.measurePhysicalUsage(usagePaths(userId));
      const jsonBytes = Buffer.byteLength(JSON.stringify(candidate, null, 2));
      quotaService.admitUsage({ currentBytes: current.baseline.bytes, proposedBytes: measured.uploadsBytes + jsonBytes, storageQuotaBytes: account(userId).storage_quota_bytes });
      await quotaService.checkDiskHeadroom(storageRoot, jsonBytes);
    },
    async afterPersist(userId) {
      // A durable JSON commit must publish memory/retain attachments even if the
      // derived usage update fails. Block subsequent writes until restart.
      try { await reconcile(userId); } catch { blocked.add(userId); }
    }
  });
  const uploadPolicy = {
    quotaService,
    getStorageQuotaBytes: userId => account(userId).storage_quota_bytes,
    async afterCommit({ userId }) {
      try { await reconcile(userId); } catch { blocked.add(userId); }
    }
  };
  upload.configureUploadPolicy(uploadPolicy);
  return { quotaService, uploadPolicy, isBlocked: userId => blocked.has(userId),
    async reconcileUsers(users) {
      for (const { id } of users) {
        account(id);
        await quotaService.runMutation(id, async () => { await reconcile(id); });
      }
    }
  };
}
module.exports = { configureAccountQuota };
