const fs = require('fs/promises');
const path = require('path');
const {
  PORT,
  MULTI_USER_MODE,
  ACCOUNTS_MODE,
  MIGRATE_DEFAULT_USER,
  EXPIRE_HOURS,
  STORAGE_ROOT,
  UPLOAD_ROOT,
  FILE_CLEANUP_INTERVAL_MINUTES,
  userPasswordMap,
  userIdSet
} = require('./src/config');
const { ensureDir } = require('./src/utils');
const { loadPersistedState, migrateLegacyData, SINGLE_USER_DATA_FILE, flushPendingPersist } = require('./src/storage');
const { createShutdown } = require('./src/shutdown');
const { cleanupOrphanDiskFiles, cleanupExpiredData, startCleanupSchedulers } = require('./src/cleanup');
const { createApp } = require('./src/app');
const { deleteAllShares, SHARE_DIR } = require('./src/share');

const MODE_FILE = path.join(STORAGE_ROOT, '.mode');

// 检查并处理运行模式变化
async function checkModeChange() {
  const currentMode = MULTI_USER_MODE ? 'multi' : 'single';

  try {
    const savedMode = await fs.readFile(MODE_FILE, 'utf8').catch(() => null);

    if (savedMode && savedMode.trim() !== currentMode) {
      console.log(`检测到运行模式变化: ${savedMode.trim()} -> ${currentMode}`);
      console.log('清理所有分享数据...');
      await deleteAllShares();
    }

    // 保存当前模式
    await ensureDir(STORAGE_ROOT);
    await fs.writeFile(MODE_FILE, currentMode, 'utf8');
  } catch (error) {
    console.error('检查模式变化失败:', error);
  }
}

async function start() {
  let shutdownRequested = false;
  let shutdownReady;
  let startupStopTimer;
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    // Startup may itself be waiting on I/O. Bound signal handling from receipt.
    startupStopTimer = setTimeout(() => {
      console.error('服务初始化期间关闭超时');
      process.exit(1);
    }, 25000);
    shutdownReady?.();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);
  await ensureDir(STORAGE_ROOT);
  const security = ACCOUNTS_MODE ? require('./src/security/runtime').createSecurityRuntime({ storageRoot: STORAGE_ROOT }) : null;

  let stopCleanupSchedulers;
  let application;
  let quotaRuntime;
  try {
  if (ACCOUNTS_MODE) quotaRuntime = require('./src/quota-runtime').configureAccountQuota({ storage: require('./src/storage'), upload: require('./src/upload'), repo: security.repo, storageRoot: STORAGE_ROOT });
  // 检查运行模式变化
  await checkModeChange();

  // 多用户模式
  if (ACCOUNTS_MODE) {
    const users = security.repo.listActiveUserIds();
    for (const { id } of users) {
      const loaded = await loadPersistedState(id, { validateSensitive: security.sensitiveService?.validateRecord, strict: true });
      if (loaded.status === 'error' || loaded.status === 'corrupt') throw new Error('Account storage could not be safely loaded');
    }
    await quotaRuntime.reconcileUsers(users);
  } else if (MULTI_USER_MODE) {
    // 检查是否需要迁移单用户数据
    if (MIGRATE_DEFAULT_USER) {
      try {
        const migrated = await migrateLegacyData(MIGRATE_DEFAULT_USER);
        if (migrated) {
          await loadPersistedState(MIGRATE_DEFAULT_USER);
        }
      } catch (error) {
        console.error('迁移数据失败:', error);
      }
    } else {
      // 检查是否有遗留的单用户数据
      try {
        await fs.access(SINGLE_USER_DATA_FILE);
        console.warn('⚠️ 检测到单用户数据遗留，请设置 MIGRATE_DEFAULT_USER=<userId> 指定迁移目标');
      } catch {
        // 无遗留数据
      }
    }

    // 加载所有用户的数据并清理过期消息与孤儿文件
    for (const [password, userId] of userPasswordMap) {
      await loadPersistedState(userId);
      await cleanupExpiredData(userId);
      await cleanupOrphanDiskFiles(userId);
    }
  } else {
    // 单用户模式
    await ensureDir(UPLOAD_ROOT);
    await loadPersistedState(null);
    await cleanupExpiredData(null);
    await cleanupOrphanDiskFiles(null);
  }

  // 启动清理定时任务
  stopCleanupSchedulers = startCleanupSchedulers();

  // 创建应用
  application = createApp({ authService: security?.authService, securityRouter: security?.securityRouter, adminRouter: security?.adminRouter, sensitiveService: security?.sensitiveService, quotaRuntime });
  const { server } = application;
  const drain = createShutdown({
    closeApp: () => application.close(),
    stopCleanup: () => stopCleanupSchedulers(),
    flushPersist: flushPendingPersist,
    closeSecurity: () => security?.close(),
    timeoutMs: 25000
  });
  const shutdown = () => {
    drain().then(() => clearTimeout(startupStopTimer)).catch(error => {
      console.error('服务关闭失败:', error);
      // Exit unsuccessfully instead of closing resources beneath active work.
      process.exit(1);
    });
  };
  shutdownReady = shutdown;
  if (shutdownRequested) {
    await drain();
    clearTimeout(startupStopTimer);
    return;
  }

  // 启动服务器
  await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`运行模式: ${MULTI_USER_MODE ? '多用户' : '单用户'}`);
    if (MULTI_USER_MODE) {
      console.log(`用户数量: ${userPasswordMap.size}`);
      console.log(`用户列表: ${Array.from(userPasswordMap.values()).join(', ')}`);
    }
    console.log(`密码保护: ${MULTI_USER_MODE ? '已启用' : (process.env.ACCESS_PASSWORD ? '已启用' : '未启用（无密码模式）')}`);
    console.log(`数据过期时间: ${EXPIRE_HOURS} 小时`);
    console.log(`数据存储目录: ${STORAGE_ROOT}`);
    console.log(`孤儿文件清理间隔: ${FILE_CLEANUP_INTERVAL_MINUTES} 分钟`);
    resolve();
  });
  });
  } catch (error) {
    // Startup failures also release timers and SQLite, after started work drains.
    await createShutdown({
      closeApp: () => application?.close(),
      stopCleanup: () => stopCleanupSchedulers?.(),
      flushPersist: flushPendingPersist,
      closeSecurity: () => security?.close(),
      timeoutMs: 25000
    })();
    clearTimeout(startupStopTimer);
    throw error;
  }
}

start().catch((error) => {
  console.error('服务启动失败:', error);
  process.exit(1);
});