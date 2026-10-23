const fs = require('fs/promises');
const path = require('path');
const { MULTI_USER_MODE, STORAGE_ROOT, UPLOAD_ROOT, MIGRATE_DEFAULT_USER, userPasswordMap } = require('./config');
const { ensureDir, clampPageSize } = require('./utils');

// 用户数据存储结构: userId -> { messages, groups, lastActivity }
const userStates = new Map();

// 全局状态（单用户模式使用）
const singleUserState = {
  messages: [],
  groups: [],
  lastActivity: Date.now()
};
let persistTask = null;
let persistImmediate = null;

// 获取用户数据路径
function getUserDataDir(userId) {
  return path.join(STORAGE_ROOT, 'users', userId);
}

function getUserDataFile(userId) {
  return path.join(getUserDataDir(userId), 'messages.json');
}

function getUserUploadRoot(userId) {
  return path.join(getUserDataDir(userId), 'uploads');
}

// 单用户模式的数据文件路径
const SINGLE_USER_DATA_FILE = path.join(STORAGE_ROOT, 'messages.json');

// 根据模式获取数据文件路径
function getDataFile(userId) {
  if (MULTI_USER_MODE && userId) {
    return getUserDataFile(userId);
  }
  return SINGLE_USER_DATA_FILE;
}

// 根据模式获取上传目录
function getUploadRoot(userId) {
  if (MULTI_USER_MODE && userId) {
    return getUserUploadRoot(userId);
  }
  return UPLOAD_ROOT;
}

// 获取用户状态
function getUserState(userId) {
  if (!MULTI_USER_MODE) {
    return singleUserState;
  }

  if (!userStates.has(userId)) {
    userStates.set(userId, { messages: [], groups: [], lastActivity: Date.now() });
  }
  return userStates.get(userId);
}

// 通过密码获取用户ID
function getUserIdByPassword(password) {
  if (!MULTI_USER_MODE) {
    return null;
  }
  return userPasswordMap.get(password) || null;
}

// One writer per user. The quota layer can replace the runner, never nest it.
const mutationTails = new Map();
let mutationRunner = null;
let persistencePolicy = null;
function configurePersistencePolicy(policy) {
  if (!policy || typeof policy.beforePersist !== 'function' || typeof policy.afterPersist !== 'function') throw new TypeError('Explicit persistence policy required');
  persistencePolicy = policy;
}
function configureMutationRunner(runner) {
  if (typeof runner !== 'function' || mutationTails.size) throw new Error('Mutation runner must be configured before writes');
  mutationRunner = runner;
}
function withUserMutation(userId, task, options) {
  if (mutationRunner) return mutationRunner(userId, task, options);
  const previous = mutationTails.get(userId) || Promise.resolve();
  const work = previous.catch(() => {}).then(task);
  const tail = work.finally(() => { if (mutationTails.get(userId) === tail) mutationTails.delete(userId); });
  tail.catch(() => {}); mutationTails.set(userId, tail);
  return work;
}
async function persistCandidateLocked(userId, candidate) {
  const dataFile = getDataFile(userId);
  const tmpFile = `${dataFile}.${require('node:crypto').randomUUID()}.tmp`;
  await ensureDir(path.dirname(dataFile));
  if (persistencePolicy) await persistencePolicy.beforePersist(userId, candidate);
  // tmpFile is a generated sibling of the intended user message file.
  try {
    const handle = await fs.open(tmpFile, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(candidate, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmpFile, dataFile);
  } catch (error) {
    await fs.unlink(tmpFile).catch(() => {});
    throw error;
  }
  if (persistencePolicy) await persistencePolicy.afterPersist(userId, candidate);
}
function commitUserMutation(userId, mutate, options = {}) {
  return withUserMutation(userId, async () => {
    const state = getUserState(userId);
    const previous = structuredClone(state);
    const candidate = structuredClone(state);
    const result = await mutate(candidate);
    candidate.lastActivity = Date.now();
    await persistCandidateLocked(userId, candidate);
    state.messages = candidate.messages;
    state.groups = Array.isArray(candidate.groups) ? candidate.groups : [];
    state.lastActivity = candidate.lastActivity;
    if (typeof options.afterCommit === 'function') await options.afterCommit({ userId, previous, candidate, result });
    return result;
  }, options);
}

// 规范化持久化状态
function normalizePersistedState(state) {
  if (!state || typeof state !== 'object') {
    return { messages: [], lastActivity: Date.now() };
  }

  const persistedMessages = Array.isArray(state.messages) ? state.messages : [];
  const normalizedMessages = persistedMessages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      if (typeof message.id !== 'string') return null;
      if (typeof message.type !== 'string') return null;
      if (!Number.isFinite(message.timestamp)) return null;
      if (!['text', 'image', 'file'].includes(message.type)) return null;
      message.favorite = Boolean(message.favorite);
      if (message.sensitive === true) {
        if (message.type !== 'text' || message.content !== null || message.remark !== '' || !message.encryptedPayload || typeof message.encryptedPayload !== 'object') throw new Error('Invalid sensitive record');
      } else message.remark = typeof message.remark === 'string' ? message.remark : '';
      return message;
    })
    .filter(Boolean);

  const persistedLastActivity = Number.isFinite(state.lastActivity)
    ? state.lastActivity
    : Date.now();

  const persistedGroups = Array.isArray(state.groups)
    ? state.groups.filter(g => typeof g === 'string' && g.trim().length > 0 && g.length <= 30).map(g => g.trim())
    : [];

  return {
    messages: normalizedMessages,
    groups: persistedGroups,
    lastActivity: persistedLastActivity
  };
}

// 加载持久化状态
//
// 区分三种情况，绝不把「读坏了」和「本来就没有」混为一谈：
//   ENOENT   -> 首次启动，用空数据，正常
//   解析失败 -> 数据文件损坏。此时**不能**把内存置为空数组：
//               内存一空，紧接着任意一次写操作（新增/删除/清理）都会把
//               损坏文件覆盖成 []，用户全部历史彻底消失且不可恢复。
//               这里的做法是先把损坏文件改名备份（不删除），再以空数据继续，
//               保证现场可查、可手工修复。
//   其他 IO 错误 -> 保守处理：不改动内存状态，避免把已有数据写没。
async function loadPersistedState(userId = null, { validateSensitive, strict = false } = {}) {
  const dataFile = getDataFile(userId);

  let raw;
  try {
    raw = await fs.readFile(dataFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log(`未找到持久化文件，使用空数据启动: ${dataFile}`);
      return { status: 'missing', messages: 0 };
    }
    console.error(`读取持久化数据失败（保留内存现状，不做清空）: ${dataFile}`, error);
    if (strict) throw error;
    return { status: 'error', messages: 0 };
  }

  let normalized;
  try {
    const decoded = JSON.parse(raw);
    if (Array.isArray(decoded?.messages)) {
      for (const record of decoded.messages) if (record?.sensitive === true) {
        if (typeof validateSensitive !== 'function') throw Object.assign(new Error('Sensitive records require a configured content keyring'), { sensitiveFailure: true });
        try { validateSensitive(record, MULTI_USER_MODE ? userId : 'legacy'); } catch { throw Object.assign(new Error('Sensitive data authentication failed; storage was not modified'), { sensitiveFailure: true }); }
      }
    }
    normalized = normalizePersistedState(decoded);
    for (const record of normalized.messages) if (record.sensitive === true) {
      if (typeof validateSensitive !== 'function') throw new Error('Sensitive records require a configured content keyring');
      validateSensitive(record, MULTI_USER_MODE ? userId : 'legacy');
    }
  } catch (error) {
    if (error.sensitiveFailure || strict) throw error;
    const corruptPath = `${dataFile}.corrupt-${Date.now()}`;
    let backedUp = false;
    try {
      await fs.rename(dataFile, corruptPath);
      backedUp = true;
    } catch (renameError) {
      console.error(`损坏数据文件备份失败: ${dataFile}`, renameError);
    }
    console.error(
      `持久化数据文件损坏，已${backedUp ? `备份为 ${corruptPath}` : '备份失败'}，` +
      `本次以空数据启动（原文件${backedUp ? '未被覆盖' : '仍保留在原处'}）: ${dataFile}`,
      error
    );

    if (strict) throw error;
    if (!MULTI_USER_MODE) {
      singleUserState.messages = [];
      singleUserState.groups = [];
      singleUserState.lastActivity = Date.now();
    } else {
      const state = getUserState(userId);
      state.messages = [];
      state.groups = [];
      state.lastActivity = Date.now();
    }
    return { status: 'corrupt', messages: 0, backup: backedUp ? corruptPath : null };
  }

  if (!MULTI_USER_MODE) {
    singleUserState.messages = normalized.messages;
    singleUserState.groups = normalized.groups || [];
    singleUserState.lastActivity = normalized.lastActivity;
  } else {
    const state = getUserState(userId);
    state.messages = normalized.messages;
    state.groups = normalized.groups || [];
    state.lastActivity = normalized.lastActivity;
  }

  console.log(`已加载持久化数据: ${normalized.messages.length} 条, 用户: ${userId || '单用户'}, 文件: ${dataFile}`);
  return { status: 'ok', messages: normalized.messages.length };
}

// 持久化状态
async function persistState(userId = null) {
  return withUserMutation(userId, () => persistCandidateLocked(userId, getUserState(userId)));
}

// 迁移单用户数据到指定用户
async function migrateLegacyData(targetUserId) {
  const legacyFile = SINGLE_USER_DATA_FILE;
  const legacyUploadsDir = UPLOAD_ROOT;
  const targetDir = getUserDataDir(targetUserId);
  const targetFile = getUserDataFile(targetUserId);
  const targetUploadsDir = getUserUploadRoot(targetUserId);

  try {
    await fs.access(legacyFile);
  } catch {
    console.log('无单用户数据需要迁移');
    return false;
  }

  // 检查目标文件是否已存在，避免覆盖已有数据
  try {
    const targetStat = await fs.stat(targetFile);
    if (targetStat.size > 0) {
      console.log(`目标用户数据已存在，跳过迁移: ${targetFile}`);
      await fs.unlink(legacyFile);
      console.log(`已删除遗留的单用户数据文件: ${legacyFile}`);
      return false;
    }
  } catch {
    // 目标文件不存在，可以继续迁移
  }

  await ensureDir(targetDir);

  await fs.rename(legacyFile, targetFile);
  console.log(`已迁移数据文件: ${legacyFile} -> ${targetFile}`);

  try {
    await fs.access(legacyUploadsDir);
    await fs.rename(legacyUploadsDir, targetUploadsDir);
    console.log(`已迁移上传目录: ${legacyUploadsDir} -> ${targetUploadsDir}`);
  } catch {
    console.log('上传目录不存在，跳过迁移');
  }

  console.log(`迁移完成，数据已迁移到用户: ${targetUserId}`);
  return true;
}

// 调度持久化
//
// 两个关键点：
//  1) 待写集合按 userId 记录，不再用一个全局布尔值。原先的写法在定时器起来后用
//     `for (const [uid] of userStates)` 写「当前已知的全部用户」，既会把与本次变更
//     无关的用户也重写一遍，又依赖遍历顺序，语义不清晰。
//  2) 单用户模式用 null 作为 key，且显式以“是否有待写任务”为准，不再假设 null 就是单用户。
const pendingPersist = new Set();

function schedulePersist(userId = null) {
  pendingPersist.add(userId);
  if (persistTask || persistImmediate !== null) return;
  persistImmediate = setImmediate(() => {
    persistImmediate = null;
    // Failure stays dirty. Retry only on a new schedule or an explicit flush,
    // never in an unbounded immediate loop when storage remains unavailable.
    flushPendingPersist().catch((error) => console.error('持久化失败，待写状态保留:', error));
  });
}

function flushPendingPersist() {
  if (persistImmediate !== null) {
    clearImmediate(persistImmediate);
    persistImmediate = null;
  }
  if (persistTask) return persistTask;
  if (pendingPersist.size === 0) return Promise.resolve();

  // Defer the drain until persistTask is assigned so concurrent callers share it.
  persistTask = Promise.resolve().then(async () => {
    while (pendingPersist.size > 0) {
      const targets = [...pendingPersist];
      pendingPersist.clear();
      const errors = [];
      for (const uid of targets) {
        try {
          await persistState(uid);
        } catch (error) {
          pendingPersist.add(uid);
          errors.push(error);
        }
      }
      // Finish this batch for other users, but do not retry a failed write here.
      if (errors.length) throw new AggregateError(errors, '持久化失败，待写状态保留');
      // Changes scheduled during IO are already in pendingPersist for the next pass.
    }
  }).finally(() => {
    persistTask = null;
  });
  return persistTask;
}

// True for pending, scheduled, or currently running persistence.
function hasPendingPersist() {
  return pendingPersist.size > 0 || persistTask !== null || persistImmediate !== null;
}


// 获取消息分页
function getMessagesPage({ before, limit, userId = null }) {
  const state = getUserState(userId);
  const pageLimit = clampPageSize(limit);
  const source = Number.isFinite(before)
    ? state.messages.filter((item) => item.timestamp < before)
    : state.messages;
  const start = Math.max(source.length - pageLimit, 0);
  const page = source.slice(start);

  return {
    messages: page,
    hasMore: start > 0,
    total: state.messages.length
  };
}

// 全量搜索消息（服务端）
// q 关键词 / type 类型筛选 / from-to 时间范围 / before 翻页游标（取更早的）
// 结果按时间倒序（新 -> 旧），便于查看最近匹配
function searchMessages({ q, type, from, to, before, limit, userId = null, scope = 'all' }) {
  const state = getUserState(userId);
  const pageLimit = clampPageSize(limit);
  const keyword = String(q || '').trim().toLowerCase();
  const typeFilter = ['text', 'image', 'file'].includes(type) ? type : null;
  const hasTimeFilter = Number.isFinite(from) || Number.isFinite(to);

  if (!keyword && !typeFilter && !hasTimeFilter) {
    return { messages: [], hasMore: false, total: 0 };
  }

  const matched = state.messages.filter((item) => {
    if (typeFilter && item.type !== typeFilter) return false;
    if (Number.isFinite(from) && item.timestamp < from) return false;
    if (Number.isFinite(to) && item.timestamp >= to) return false;

    if (!keyword) return true;
    if (item.sensitive === true) return false;
    if (item.private === true) return false;

    const haystacks = [];
    if (scope === 'note') {
      // 备注模式：只搜 remark 字段，且只返回有备注的卡片
      if (!item.remark) return false;
      haystacks.push(typeof item.remark === 'string' ? item.remark : '');
    } else {
      if (item.type === 'text') {
        haystacks.push(typeof item.content === 'string' ? item.content : '');
      } else if (item.type === 'file') {
        haystacks.push(item.content && typeof item.content.name === 'string' ? item.content.name : '');
      }
      haystacks.push(typeof item.remark === 'string' ? item.remark : '');
      haystacks.push(typeof item.title === 'string' ? item.title : '');
    }

    return haystacks.some((text) => text.toLowerCase().includes(keyword));
  });

  // 倒序：新 -> 旧
  matched.sort((a, b) => b.timestamp - a.timestamp);

  const source = Number.isFinite(before)
    ? matched.filter((item) => item.timestamp < before)
    : matched;
  const page = source.slice(0, pageLimit);

  return {
    messages: page,
    hasMore: source.length > page.length,
    total: matched.length
  };
}

module.exports = {
  // Query loaded state without exposing the mutable registry.
  hasUserState: userId => userStates.has(userId),
  listLoadedUserIds: () => [...userStates.keys()],

  // 目录路径函数
  getUserDataDir,
  getUserDataFile,
  getUserUploadRoot,
  getDataFile,
  getUploadRoot,
  SINGLE_USER_DATA_FILE,

  // 状态管理函数
  getUserState,
  getUserIdByPassword,

  // 持久化函数
  normalizePersistedState,
  loadPersistedState,
  persistState,
  migrateLegacyData,
  schedulePersist,
  flushPendingPersist,
  hasPendingPersist,
  configureMutationRunner,
  configurePersistencePolicy,
  withUserMutation,
  commitUserMutation,
  persistCandidateLocked,

  // 分页函数
  getMessagesPage,

  // 搜索
  searchMessages
};