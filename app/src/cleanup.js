const fs = require('fs/promises');
const path = require('path');
const { MULTI_USER_MODE, EXPIRE_TIME, STORAGE_ROOT, FILE_CLEANUP_INTERVAL_MINUTES } = require('./config');
const { getUserState, hasUserState, loadPersistedState, getUploadRoot, getDataFile, withUserMutation, persistCandidateLocked } = require('./storage');
const { deleteMessageFiles, getMessageFileRefs, getActiveTempFiles, isActiveUploadPath, resolveUploadPolicy } = require('./upload');
const { measurePhysicalUsage } = require('./quota');
const { toPosixPath } = require('./utils');
const { cleanupExpiredShares, deleteSharesByMessageId } = require('./share');
const { socketHelper } = require('./socket');

// The scheduler serializes each kind of cleanup for its entire async lifetime.
// Per-user orphan cleanup also shares work with direct callers (see below).

// 清理过期数据
async function cleanupExpiredDataLocked(userId = null) {
  const state = getUserState(userId);
  const now = Date.now();
  const keptMessages = [];
  const expiredMessages = [];

  for (const msg of state.messages) {
    if (msg.favorite || now - msg.timestamp <= EXPIRE_TIME) {
      keptMessages.push(msg);
    } else {
      expiredMessages.push(msg);
    }
  }

  if (expiredMessages.length === 0) return;

  const candidate = structuredClone(state);
  candidate.messages = keptMessages;
  candidate.lastActivity = Date.now();
  await persistCandidateLocked(userId, candidate);
  state.messages = candidate.messages;
  state.lastActivity = candidate.lastActivity;

  // 广播通知客户端移除过期消息
  if (socketHelper && socketHelper.io) {
    for (const msg of expiredMessages) {
      socketHelper.broadcastDelete(userId, msg.id);
    }
  }

  // 清理关联分享
  // 注意：Promise.allSettled 永远不会 reject，挂 .catch 是死代码（真实错误藏在
  // 每个 settled 结果的 reason 里）。这里改为按结果逐条打印，错误不再被吞掉。
  const shareResults = await Promise.allSettled(
    expiredMessages.map((msg) => deleteSharesByMessageId(msg.id, userId))
  );
  for (const result of shareResults) {
    if (result.status === 'rejected') {
      console.error('清理过期分享失败:', result.reason);
    }
  }

  // 清理过期文件
  const fileResults = await Promise.allSettled(
    expiredMessages.map((msg) => deleteMessageFiles(msg, userId))
  );
  for (const result of fileResults) {
    if (result.status === 'rejected') console.error('清理过期文件失败:', result.reason);
  }
}

async function cleanupExpiredData(userId = null, options = {}) {
  return withUserMutation(userId, async () => {
    const before = await measurePhysicalUsage({ messagesFile: getDataFile(userId), uploadRoot: getUploadRoot(userId) });
    await cleanupExpiredDataLocked(userId);
    let policy = null;
    try { policy = resolveUploadPolicy(); } catch { /* startup cleanup may run before app policy injection */ }
    if (policy?.afterCommit) {
      const actual = await measurePhysicalUsage({ messagesFile: getDataFile(userId), uploadRoot: getUploadRoot(userId) });
      try { await policy.afterCommit({ userId, operation: 'cleanup-expired', bytesDelta: actual.bytes - before.bytes, storageRoot: getUploadRoot(userId), dataFile: getDataFile(userId), actualBytes: actual.bytes }); }
      catch (error) { console.error('清理后usage对账失败:', error); }
    }
  }, options);
}

// 清理所有用户过期数据
async function cleanupAllUsersExpiredData() {
  if (MULTI_USER_MODE) {
    const usersDir = path.join(STORAGE_ROOT, 'users');
    let userDirs = [];
    try {
      const entries = await fs.readdir(usersDir, { withFileTypes: true });
      userDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('扫描用户目录失败:', error);
      }
      return;
    }

    for (const userId of userDirs) {
      if (!hasUserState(userId)) {
        await loadPersistedState(userId);
      }
      await cleanupExpiredData(userId);
    }
  } else {
    await cleanupExpiredData(null);
  }
}

// 递归列出所有文件
async function listAllFilesRecursive(baseDir) {
  const out = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && !isActiveUploadPath(fullPath) && !getActiveTempFiles().has(path.resolve(fullPath))) {
        out.push(fullPath);
      }
    }
  }

  await walk(baseDir);
  return out;
}

// 递归删除空目录
async function removeEmptyDirsRecursive(dirPath, isRoot = true) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await removeEmptyDirsRecursive(path.join(dirPath, entry.name), false);
  }

  const after = await fs.readdir(dirPath, { withFileTypes: true }).catch((error) => {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  });

  if (!isRoot && after.length === 0) {
    await fs.rmdir(dirPath).catch((error) => {
      if (error && error.code === 'ENOENT') return;
      throw error;
    });
  }
}

// 清理孤儿磁盘文件
//
// 单飞（single-flight）语义：
//   原来的 `if (cleanupRunning) return;` 配一个模块级布尔量，在多用户模式下会漏掉
//   绝大部分用户 —— 定时任务循环调用 cleanupOrphanDiskFiles(uid) 时，只有第一个
//   用户真正执行，其余用户因为标志位还是 true 直接 return，孤儿文件永远清不掉。
//   而且「正在清理」和「已跳过」对调用方无法区分。
// 现在：并发请求同一个 userId 时复用同一个 Promise；不同 userId 各自独立执行。
const orphanCleanupInflight = new Map();

async function cleanupOrphanDiskFilesLocked(userId = null) {
  const key = userId || '\u0000single';
  const running = orphanCleanupInflight.get(key);
  if (running) return running;

  const task = (async () => {
    const uploadRoot = getUploadRoot(userId);
    const state = getUserState(userId);
    const before = await measurePhysicalUsage({ messagesFile: getDataFile(userId), uploadRoot });
    const activeTemps = getActiveTempFiles();

    const referenced = new Set();
    for (const msg of state.messages) {
      const refs = getMessageFileRefs(msg);
      refs.forEach((item) => referenced.add(item));
    }

    const allFiles = await listAllFilesRecursive(uploadRoot);
    let removedCount = 0;

    for (const absolutePath of allFiles) {
      if (activeTemps.has(path.resolve(absolutePath)) || isActiveUploadPath(absolutePath)) continue;
      const relativePath = toPosixPath(path.relative(uploadRoot, absolutePath));
      if (!referenced.has(relativePath)) {
        await fs.unlink(absolutePath).catch((error) => {
          if (error && error.code === 'ENOENT') return;
          throw error;
        });
        removedCount += 1;
      }
    }

    await removeEmptyDirsRecursive(uploadRoot, true);

    if (removedCount > 0) console.log(`孤儿文件清理完成，用户 ${userId || '单用户'} 删除 ${removedCount} 个文件`);
    let policy = null;
    try { policy = resolveUploadPolicy(); } catch { /* startup cleanup may run before app policy injection */ }
    if (policy?.afterCommit) {
      const actual = await measurePhysicalUsage({ messagesFile: getDataFile(userId), uploadRoot });
      try { await policy.afterCommit({ userId, operation: 'cleanup-orphans', bytesDelta: actual.bytes - before.bytes, storageRoot: uploadRoot, dataFile: getDataFile(userId), actualBytes: actual.bytes }); }
      catch (error) { console.error('孤儿清理后usage对账失败:', error); }
    }
    return removedCount;
  })().catch((error) => {
    console.error(`孤儿文件清理失败 (用户 ${userId || '单用户'}):`, error);
    return 0;
  }).finally(() => {
    orphanCleanupInflight.delete(key);
  });

  orphanCleanupInflight.set(key, task);
  return task;
}

async function cleanupOrphanDiskFiles(userId = null, options = {}) {
  return withUserMutation(userId, () => cleanupOrphanDiskFilesLocked(userId), options);
}

// 清理所有用户孤儿文件
async function cleanupAllUsersOrphanFiles() {
  if (MULTI_USER_MODE) {
    const usersDir = path.join(STORAGE_ROOT, 'users');
    let userDirs = [];
    try {
      const entries = await fs.readdir(usersDir, { withFileTypes: true });
      userDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('扫描用户目录失败:', error);
      }
    }

    for (const userId of userDirs) {
      await cleanupOrphanDiskFiles(userId);
    }
  } else {
    await cleanupOrphanDiskFiles(null);
  }
}

// 启动清理定时任务
function startCleanupSchedulers() {
  let stopped = false;
  let stopTask = null;
  const active = new Map();
  function run(kind, job) {
    if (stopped) return;
    if (active.has(kind)) return active.get(kind);
    const task = Promise.resolve().then(job)
      .catch((error) => console.error(`清理任务失败 (${kind}):`, error))
      .finally(() => active.delete(kind));
    active.set(kind, task);
    return task;
  }
  run('expired', cleanupAllUsersExpiredData);
  run('shares', cleanupExpiredShares);
  const timers = [
    setInterval(() => run('expired', cleanupAllUsersExpiredData), 5 * 60 * 1000),
    setInterval(() => run('orphans', cleanupAllUsersOrphanFiles), FILE_CLEANUP_INTERVAL_MINUTES * 60 * 1000),
    setInterval(() => run('shares', cleanupExpiredShares), 5 * 60 * 1000)
  ];
  // Remain callable for existing callers; await the return value for safe shutdown.
  return function stop() {
    if (stopTask) return stopTask;
    stopped = true;
    timers.forEach(clearInterval);
    stopTask = Promise.all([...active.values(), ...orphanCleanupInflight.values()]).then(() => undefined);
    return stopTask;
  };
}

module.exports = {
  cleanupExpiredData,
  cleanupAllUsersExpiredData,
  cleanupOrphanDiskFiles,
  cleanupAllUsersOrphanFiles,
  startCleanupSchedulers
};