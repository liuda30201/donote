# 代码审查报告

**项目**：web-clipboard v1.6.8

**审查日期**：2026-10-17

**审查范围**：27 个核心模块（server、config、middleware、routes ×7、storage、upload、socket、security ×8、share、lifecycle、cleanup、shutdown、utils、message、db ×4、quota ×2、public 脚本 ×2）

**整体评价**：中高质量。核心加密设计（AES-256-GCM + AAD、keyring 管理、unlock grant 防重放）和并发控制（mutation 队列、原子文件写入）扎实。发现 **14 个严重问题**需立即修复，主要集中在分享密码明文存储、凭据经 URL 传递、内存限制缺失、空指针解引用和并发竞态。

---

## 目录

- [严重问题（🔴 立即修复）](#严重问题)
- [建议修改（🟡）](#建议修改)
- [可选优化（🟢）](#可选优化)
- [亮点](#亮点)
- [修复优先级速查表](#修复优先级速查表)

---

## 严重问题

### 问题 1：分享密码明文存储到磁盘

**位置**：`app/src/share.js:81`、`app/src/share.js:136`

密码以 `{ password: "xxx" }` JSON 明文写入 `shares/*.json`；验证时用 `!==` 字符串运算符直接比较。

任何能读取 shares 目录的攻击者（备份泄露、路径遍历、服务器入侵后横向移动）可直接获取所有分享密码；用户可能在多个服务复用相同密码；字符串比较存在时序差异。

```js
// 原代码 share.js:81
const share = { ..., password: password || null, ... };
// 原代码 share.js:136
if (password !== share.password) { ... }

// 修复：使用 argon2（项目已有依赖）
const argon2 = require('argon2');
// 创建时
const passwordHash = password ? await argon2.hash(password) : null;
const share = { ..., passwordHash, ... };
// 验证时
const match = share.passwordHash ? await argon2.verify(share.passwordHash, password) : true;
if (!match) return { success: false, error: '密码错误' };
```

---

### 问题 2：密码/凭据通过 URL 查询参数传递

**位置**：`app/src/middleware/auth.js:52`（`query.password`）、`app/src/routes/share.js:98`（`req.query.password`）、`app/public/share.js:272`（前端拼接 URL）

密码完整出现在服务器 access log、Nginx 日志、浏览器历史记录、HTTP Referer 头，极易泄露。

```js
// middleware/auth.js:50-55 — 删除 query.password
const password = resolveCredential(
  headers['x-access-password'],
  body.password,
  // query.password,  ← 删除这行
  readCookie(cookieHeader, 'wc_auth')
);

// routes/share.js:96 — 从 GET 改为 POST，密码放 body
router.post('/:shareId/content', async (req, res) => {
  const { password } = req.body;
  // ...
});

// public/share.js:272 — 前端改为 POST
const response = await fetch(`/api/share/${shareId}/content`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: verifiedPassword || undefined })
});
```

---

### 问题 3：JSON body 大小限制 100MB，存在 OOM DoS 风险

**位置**：`app/src/routes/index.js:59-60`

`express.json({ limit: '100mb' })` 会在内存中完整缓冲请求体；文件上传有独立的 Multer 流式处理，普通 JSON API 无需此上限。攻击者发送接近 100MB 的 JSON 请求可耗尽服务器内存。

```js
// 原代码
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// 修复：JSON 接口 1MB 已足够
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));
```

---

### 问题 4：data URL 解码无内存上限保护

**位置**：`app/src/utils.js:88`、`app/src/message.js:74`

`decodeDataUrl` 在 `Buffer.from(payload, 'base64')` 前无大小检查；通过文本消息路径发送的 base64 不受 Multer `uploadLimits` 约束，恶意客户端可绕过文件上传路由直接发超大 base64，导致 OOM。

```js
// utils.js 入口增加硬上限
const MAX_DATA_URL_BYTES = 110 * 1024 * 1024;
function decodeDataUrl(dataUrl) {
  if (!isDataUrl(dataUrl)) throw new Error('invalid data url');
  if (Buffer.byteLength(dataUrl, 'utf8') > MAX_DATA_URL_BYTES)
    throw Object.assign(new Error('data url too large'), { code: 'UPLOAD_TOO_LARGE' });
  // ... 原逻辑
}
```

---

### 问题 5：`auth.js` 中 `completeLogin` 在邮箱验证路径缺少 `await`

**位置**：`app/src/routes/auth.js:91`

`completeLogin` 虽声明为同步函数，但在邮箱验证路径下内部调用 `emailVerification.consume()` 返回 Promise，导致 `issue()` 收到 Promise 而非结果，`result.requiresSecondFactor`、`result.token` 均为 `undefined`，Cookie 不会被设置，登录静默失败（TOTP 路径不受影响，邮箱验证路径会触发）。

```js
// 原代码
sessionRouter.post('/auth/login/verify', endpoint((req, res) => {
  jsonRequest(req); issue(authService.completeLogin(req), res);
}));

// 修复：与 login 端点保持一致
sessionRouter.post('/auth/login/verify', endpoint(async (req, res) => {
  jsonRequest(req); issue(await authService.completeLogin(req), res);
}));
```

---

### 问题 6：`favorites.js` 中 `io` 广播无空值守卫

**位置**：`app/src/routes/favorites.js:20`

`req.app.get('io').broadcastFavorite(...)` 当 `io` 未注册时抛出 `TypeError`；此时 `commitUserMutation` 已完成，数据已写入，但响应变为 500，状态与响应不一致。

```js
// 原代码
req.app.get('io').broadcastFavorite(req.userId, { ... });

// 修复：与 messages.js 保持一致
req.app.get('io')?.broadcastFavorite(req.userId, { id: message.id, favorite, message: publicMessage });
```

---

### 问题 7：`security.js` 会话撤销存在 TOCTOU 竞态

**位置**：`app/src/routes/security.js:44`

两次 `findSessionById` 调用之间无原子保证，且对同一 ID 查询三次；权限校验（`user_id` 匹配）和实际撤销不在同一事务内。

```js
// 修复：只查询一次，合并校验
service.consume(current, grant, 'session.revoke', target => {
  const session = repo.findSessionById(req.params.id);
  if (!session || session.user_id !== current.user.id || target.targetId !== req.params.id) {
    const err = new Error('not found');
    err.status = 404; err.code = 'SESSION_NOT_FOUND'; throw err;
  }
  return repo.revokeSession({ sessionId: req.params.id, userId: current.user.id, at: now() });
});
```

---

### 问题 8：`repositories.js` 中 `withOperationGrant` 空指针解引用

**位置**：`app/src/db/repositories.js:113`

`activeSession` 检查通过后，用户若被并发删除，`findUserById` 返回 `null`，下一行 `user.security_version` 抛出 `TypeError`，事务回滚，调用方收到未预期的异常而非 `null`。

```js
// 原代码
const user = findUserById(userId);
if (!row || row.security_version !== user.security_version) return null;

// 修复：补加空值守卫
const user = findUserById(userId);
if (!row || !user || row.security_version !== user.security_version) return null;
```

---

### 问题 9：`quota-runtime.js` 中 `reconcileUsers` 绕过 mutation 队列，存在并发竞态

**位置**：`app/src/quota-runtime.js:59-61`

`reconcile(id)` 直接调用 `measurePhysicalUsage` + `setStorageUsage`，未经 mutation 队列排队。若某用户正在写文件（文件已落盘、JSON 未提交之间），此处可能测量到中间态（偏高的字节数），立即写入 `storage_bytes`，覆盖正常 mutation 事后的 reconcile。

```js
// 原代码
async reconcileUsers(users) {
  for (const { id } of users) { account(id); await reconcile(id); }
}

// 修复：通过 mutation 队列排队执行
async reconcileUsers(users) {
  for (const { id } of users) {
    account(id);
    await quotaService.runMutation(id, async () => { await reconcile(id); });
  }
}
```

---

### 问题 10：`server.js` 直接拼写 SQL，绕过 Repository 层

**位置**：`app/server.js:74`

`security.db.prepare('SELECT id FROM users WHERE deleted_at IS NULL').all()` 直接操作 SQLite，未来 schema 变更无法被 repo 层统一管理。

```js
// 在 repositories.js 中添加
listActiveUserIds() {
  return db.prepare('SELECT id FROM users WHERE deleted_at IS NULL').all();
},

// server.js 改为
const users = security.repo.listActiveUserIds();
```

---

### 问题 11：`storage.js` 暴露内部可变状态

**位置**：`app/src/storage.js:407`

`module.exports.userStates` 直接导出内部 `Map`，外部代码可绕过 mutation 队列直接修改，破坏一致性保证。

```js
// 修复：不导出 userStates，改为只读查询接口
function hasUserState(userId) { return userStates.has(userId); }
function listLoadedUserIds() { return [...userStates.keys()]; }
// 从 module.exports 中删除 userStates
```

---

### 问题 12：分享密码验证端点无速率限制，可被暴力破解

**位置**：`app/src/routes/share.js:78`

`POST /:shareId/verify` 无任何限流，攻击者可高速枚举密码。

```js
const { authLimiter } = require('../middleware/rateLimit');
router.post('/:shareId/verify', authLimiter, async (req, res) => { ... });
```

---

### 问题 13：`auth-service.js` 中多处 `JSON.parse` 无异常处理

**位置**：`app/src/security/auth-service.js:171`、`app/src/security/auth-service.js:150`

`JSON.parse(row.target_id)` 和 `JSON.parse(row.target)` 在 DB 字段损坏时会抛出未捕获的 `SyntaxError`，穿透到 Express 全局错误处理器，向客户端返回 500 并可能暴露栈帧信息。

```js
// 原代码
return { row, payload: JSON.parse(row.target_id), body };

// 修复
let payload;
try { payload = JSON.parse(row.target_id); }
catch { throw fail(); }
return { row, payload, body };
```

---

### 问题 14：`email-verification.js` 中 `confirmBind` 的 `JSON.parse` 无异常处理

**位置**：`app/src/security/email-verification.js:46`

`const { email } = JSON.parse(row.target)` 在 DB 字段损坏时抛出 SyntaxError，同上。

```js
// 修复
let parsedTarget;
try { parsedTarget = JSON.parse(row.target); }
catch { throw fail(); }
const { email } = parsedTarget;
```

---

## 建议修改

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 1 | `app/src/share.js:165` | 视图计数器 `viewCount += 1` 与 `saveShare` 之间无锁，并发丢失计数 | 接受最终一致性并注释说明，或改为 CAS 写回 |
| 2 | `app/src/share.js:233` | `deleteSharesByMessageId`/`getShareList`/`cleanupExpiredShares` 每次 O(n) 全目录扫描 | 维护内存索引或迁移到 SQLite |
| 3 | `app/src/routes/admin.js:28`、`app/src/routes/security.js` | 路由层无显式 `requireAuth`，鉴权完全在服务层隐式完成，若新增端点遗漏服务层调用则无任何防线 | 路由层加 `requireAuth` 作为兜底防线 |
| 4 | `app/src/lifecycle.js:41` | `trackRouter` 未覆盖 `router.use`/`router.all`，关机期间这些 handler 的异步工作不被 `drain()` 等待 | 扩展方法列表：`['get','post','patch','put','delete','use','all','options','head']` |
| 5 | `app/src/shutdown.js:26` | 超时时 `flushPersist`/`closeSecurity` 被跳过但未记录 | 补充 `console.error` 日志，说明哪些步骤被跳过 |
| 6 | `app/src/cleanup.js:277` | `stopCleanup` 未等待 `orphanCleanupInflight` 中的任务 | stop 函数中一并等待 `...orphanCleanupInflight.values()` |
| 7 | `app/src/routes/auth.js:90` | 新版登录端点无路由层限流 | 添加 `authLimiter` 到 `/auth/login` 和 `/auth/login/verify` |
| 8 | `app/src/app.js:27` | 非 accounts 模式 CORS 为 `'*'` | 提供可配置的 `CORS_ORIGIN` 环境变量 |
| 9 | `app/src/routes/index.js:19` | `apiNotFound` 回显 `req.originalUrl`，可能含 query string 中的敏感参数 | 移除 `path` 字段，仅返回 `{ error: 'Not Found' }` |
| 10 | `app/src/db/schema.js:118` | `verification_preferences` 允许 `method='email'` 但 `email=NULL`，DB 层无约束 | 增加 `CHECK (method != 'email' OR (email IS NOT NULL AND length(trim(email)) > 0))` |
| 11 | `app/src/utils.js:73` | `sanitizeFilename` 仅保留基本汉字 `\u4e00-\u9fa5`，日韩/阿拉伯/西里尔文等文件名全部变为 `_` | 改用 Unicode 属性转义：`.replace(/[^\p{L}\p{N}._\- ]/gu, '_')` |
| 12 | `app/src/message.js:54` | `content.size` 来自持久化 JSON，可能为 `undefined`/非数字，直接暴露给 API | 加校验：`Number.isSafeInteger(content.size) && content.size >= 0 ? content.size : 0` |
| 13 | `app/public/service-worker.js:44` | `CLEAR_PRIVATE_CACHE` 只清理从不被缓存的路径，实为空操作 | 修改过滤条件或注释说明兼容意图 |
| 14 | `app/src/quota.js:55` | `0` 作哨兵导致无法设置"禁止存储（0 字节配额）" | 用 `null`/`-1` 作哨兵，或注释说明此设计限制 |
| 15 | `app/src/routes/share.js:56` | 创建分享失败时透传 `error.message`，可能泄露内部错误信息 | 对已知业务错误透传，其余返回通用消息 |
| 16 | `app/src/security/operations.js:114` | TOTP-only 重新认证路径缺少完整 session liveness 检查（缺 `activeSession`、`disabled_at`、`deleted_at` 校验） | 将手动检查替换为 `freshUser(current, snapshotUser)`，与双因子路径保持一致 |
| 17 | `app/src/security/admin.js:85` | TOTP 验证失败未写审计日志，无法追踪对 admin 面板的暴力破解尝试 | 在 `if (counter === null) throw fail()` 之前补充 `repo.addAudit({ action: 'login.factor_failed', ... })` |
| 18 | `app/src/security/primitives.js:44` | `constantTimeEqual` 末尾长度比较使用短路运算，理论上泄露长度信息 | 改用 `crypto.timingSafeEqual` 同时比较内容和长度 |
| 19 | `app/src/security/auth-service.js:58` | email OTP 登录后 `auth_strength` 仍为 `'password'`，未反映二因子验证完成 | 引入 `'email-otp'` 强度级别，或注释明确文档化此设计意图 |
| 20 | `app/src/security/sensitive-service.js:58` | `issue()` 通过修改 `req.body` 传递参数，对传入对象产生不必要副作用 | 构造新对象传递，不修改 `req.body` |
| 21 | `app/src/security/email-verification.js:44` | `allowed` 列表与 `operations.js` 中 `ACTIONS` 常量重复维护，新增操作类型若只更新一处会静默失效 | 将 `ACTIONS` 提取为共享常量，两处引用同一来源 |

---

## 可选优化

| # | 位置 | 优化 |
|---|---|---|
| 1 | `app/src/share.js:75` | 分享 ID 直接用 `randomUUID()`，不需要时间戳前缀（时间戳前缀泄露创建时间） |
| 2 | `app/src/utils.js:192` | `dangerousMime` Set 提升为模块级常量，避免每次调用重新分配 |
| 3 | `app/src/utils.js:147` | `module.exports` 移到所有函数定义之后，避免读者在导出列表中找不到对应实现 |
| 4 | `app/src/cleanup.js:243` | 多用户孤儿清理改为并发：`await Promise.allSettled(userDirs.map(userId => cleanupOrphanDiskFiles(userId)))` |
| 5 | `app/src/lifecycle.js:11` | 双回调改为 `promise.finally(() => active.delete(promise))`，语义更清晰 |
| 6 | `app/public/service-worker.js:1` | 缓存版本号 `'web-clipboard-v2.0.15'` 由构建工具注入，避免手工维护 |
| 7 | `app/public/share.js:350` | `keypress` 事件已废弃，改为 `keydown` |
| 8 | `app/src/message.js:134` | 文件大小统一用 `lstat` 实际磁盘大小而非 `decoded.buffer.length`，与上传路由保持一致 |
| 9 | `app/src/db/index.js:32` | symlink 检查冗余：`lstatSync` 后 `isDirectory()` 已排除 symlink，`|| stat.isSymbolicLink()` 永远不执行 |
| 10 | `app/src/db/index.js:55` | `busy_timeout` 重复设置（构造函数 `timeout` 选项与 `pragma` 各一次），保留其一 |
| 11 | `app/src/db/schema.js:47` | `sessions_token` 索引可做偏置索引：`CREATE INDEX sessions_token ON sessions(token_hash) WHERE revoked_at IS NULL` |
| 12 | `app/src/security/sensitive-service.js:49` | `validateRecord` 执行全量 AES-GCM 解密只做结构校验后丢弃，批量渲染路径产生不必要 CPU 开销；改为只做 envelope 字段存在性检查 |
| 13 | `app/src/security/admin.js:48` | username 格式正则在 `plan()` 和 `repo.normalizeUsername` 中重复定义，提取为共享常量 |

---

## 亮点

以下设计值得保留和借鉴：

1. **敏感数据加密完善**：`app/src/security/sensitive.js` 使用 AES-256-GCM + AAD（绑定 userId/messageId/keyId/field），密钥用后清零，unlock grant 一次性消费，防重放设计完备
2. **原子文件写入**：`app/src/storage.js` 通过 UUID tmp 文件 + `rename` 原子替换，防止写入中断导致数据损坏
3. **mutation 队列串行化**：`app/src/storage.js` 按 userId 串行化写操作，有效防止并发写冲突
4. **文件上传多层防御**：`app/src/upload.js` 用 `COPYFILE_EXCL` 防覆盖、路径遍历检测、lstat 二次校验、active temp file 追踪
5. **内容类型双层保护**：`isActiveContent` + `isPreviewableText` + CSP `default-src 'none'; sandbox`（`app/src/routes/files.js:174`）有效防止上传内容被浏览器执行
6. **孤儿文件清理 single-flight**：`app/src/cleanup.js` per-user 并发保护实现正确，不同用户各自独立，相同用户并发调用复用同一 Promise
7. **accounts 模式安全严格**：AUTH_KEY_FILE 必须在 storage root 外、0600 权限、32 字节；HTTPS origin 强制；admin 操作需三重验证（admin 角色 + TOTP + grant）
8. **Operation Grant 三阶段模式**（reauth → checkGrant 内存预检 → withOperationGrant DB 原子消费）：防重放、防 TOCTOU，安全设计亮点
9. **Security Version 机制**：密码/角色变更后 session/challenge/grant 自动失效，轻量但有效
10. **全量参数化查询**：`app/src/db/repositories.js` 所有 SQL 均使用参数化查询，无一处字符串拼接用户输入
11. **密码唯一性校验**：`app/src/config.js:75` 防止多用户共享密码导致身份混淆
12. **CSRF 保护**：`app/src/middleware/auth.js:94` accounts 模式下所有非安全 HTTP 方法强制 CSRF 校验
13. **上传目录双重保护**：应用层 404 + 反向代理层拦截，防止直接访问上传文件
14. **迁移校验完善**：`app/src/db/migrations.js` 使用 IMMEDIATE 事务 + name+SQL checksum 校验，DDL 失败整体回滚

---

## 修复优先级速查表

### 🔴 立即修复（14 项）

| 优先级 | 文件 | 行号 | 问题 | 改动量 |
|---|---|---|---|---|
| 1 | `app/src/routes/share.js` + `app/public/share.js` | 98 / 272 | 密码通过 URL 传递，改为 POST body | 3 处改动 |
| 2 | `app/src/share.js` | 81 | 分享密码明文存储，改用 argon2 | 2 处改动 |
| 3 | `app/src/routes/index.js` | 59 | JSON body 100MB，改为 1MB | 2 行 |
| 4 | `app/src/utils.js` | 88 | data URL 无内存上限，添加硬上限检查 | 1 处 |
| 5 | `app/src/db/repositories.js` | 113 | 空指针解引用，补 `!user \|\|` | 1 行 |
| 6 | `app/src/quota-runtime.js` | 59 | reconcileUsers 绕过 mutation 队列 | 包裹 `runMutation` |
| 7 | `app/src/routes/auth.js` | 91 | completeLogin 缺 await（邮箱验证路径） | 补 `async`/`await`，1 行 |
| 8 | `app/src/routes/favorites.js` | 20 | io 无空值守卫 | 补 `?.`，1 行 |
| 9 | `app/src/middleware/auth.js` | 52 | 删除 query.password 支持 | 删 1 行 |
| 10 | `app/src/routes/share.js` | 78 | 分享密码验证无限流 | 加 `authLimiter`，1 行 |
| 11 | `app/src/routes/security.js` | 44 | 会话撤销 TOCTOU，合并为单次查询 | 1 处重写 |
| 12 | `app/server.js` | 74 | 直接 SQL 查询，改用 repo 接口 | 2 处改动 |
| 13 | `app/src/security/auth-service.js` | 171 | JSON.parse 无 try-catch，DB 损坏时 500 泄露栈帧 | 2 处 try-catch |
| 14 | `app/src/security/email-verification.js` | 46 | JSON.parse 无 try-catch，同上 | 1 处 try-catch |

### 🟡 应该修复（21 项）

见上方「建议修改」表格。

### 🟢 可选优化（13 项）

见上方「可选优化」表格。

---

*本报告由主审查员 + 4 个专项子代理（安全模块 / 基础设施 / 路由层 / 数据库配额）并行审查生成，所有严重问题经源码二次核实。*
