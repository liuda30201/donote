# DoNote 数据库与安全仓储契约（D01 / D02）

> 状态：D01 数据库基础 + D02 安全仓储；不接入 HTTP、登录业务或前端。

## D02 精确调用契约

导入 `SECURITY_MIGRATION`（`app/src/db/schema.js`）及 `createRepositories`（`app/src/db/repositories.js`）。D01 只建立迁移记录表，没有已占用的业务版本；D02 是 version 1：

```js
const db = openDatabase({storageRoot, migrations: [SECURITY_MIGRATION]});
const repo = createRepositories(db);
```

输入为 camelCase，数据库行输出为 snake_case。所有 `at` / `createdAt` 默认 `Date.now()`，测试可显式传 Unix 毫秒。空查询返回 null，操作成功返回行、数量或 `{result}`。token / challenge / grant / recovery code 均传原始高熵串（至少 16 字符），仓储内 SHA256；不要预先传 hashToken/hashRecoveryCode 结果，避免双哈希。

| API | 参数 / 结果 |
| --- | --- |
| createUser | `{id?=UUID,username,displayName,passwordHash,role?='user',mustChangePassword?,storageQuotaBytes?,at?}` → users 行（内部含 hash，禁止直接响应） |
| listUsers | `{limit?=50,before?=UUID}` → 按 UUID DESC 的安全摘要（id/username/display_name/role/disabled_at/deleted_at/must_change_password/storage_quota_bytes/storage_bytes/created_at），不含 password_hash/security_version |
| setDisabled | `{userId,disabled:boolean,at?}` → 用户；非 boolean 拒绝，禁用在事务内撤销 sessions/challenges/grants/recovery/pending TOTP，保留已启用 TOTP；最后启用管理员返回 `LAST_ADMIN` |
| setStorageUsage | `{userId,storageBytes,at?}` → 用户或 null；storageBytes 是迁移账户附件（`messages.json` + `uploads` 全文件）字节总和，必须为非负 safe integer；仅更新计量，不执行权限或磁盘操作 |
| findMigrationAudit | `{userId,migrationId}` → 首条最新匹配 `data.migrated` 提交凭据（仅 id/target_id/created_at/允许 detail），精确匹配 target 和 detail.reason，不返回 actor/IP |
| findUserById / findUserByUsername | 字符串 → users 行或 null；用户名 trim/lowercase，3–64 ASCII 字符 `[a-z0-9_.-]`，首字符字母或数字 |
| changePassword | `{userId,passwordHash,mustChangePassword?,at?}` → 用户；版本递增并撤销旧会话/挑战/授权/恢复码，保留已启用 TOTP |
| setDisabled / setRole | `{userId,disabled,at?}` / `{userId,role,at?}` → 用户；最后启用管理员操作在 IMMEDIATE 事务内拒绝，code=LAST_ADMIN |
| createSession | `{id?,userId,token,csrfToken,deviceLabel?,ipAddress?,ephemeral?,authStrength?='password',createdAt?,idleExpiresAt,expiresAt}` → session 行或 null |
| findSessionByToken | `(rawToken, at?)` → session + username/role/user_security_version；失效、账户停用或版本不匹配返回 null |
| findSessionById | `sessionId` → 原始 session 行（仅内部使用，不代表仍有效） |
| activeSession | `(sessionId,userId,at)` → 有效且归属匹配的 session 或 null |
| listSessions | `userId` → 无 token_hash/csrf_hash 的摘要数组（含已撤销，服务层过滤/分页） |
| touchSession | `{sessionId,userId,idleExpiresAt,at?}` → boolean，空闲延长不越过绝对期限 |
| revokeSession | `{sessionId,userId,at?}` → boolean；跨用户不修改 |
| revokeOtherSessions | `{userId,keepSessionId,at?}` → 数量；仅内部可信调用，目标快照由服务层固定 |
| revokeAllSessions | `{userId,at?}` → 数量；递增安全版本并撤销旧材料，不删除已启用 TOTP |
| createLoginChallenge | `{userId,challenge,kind?='login',sessionId?,action?,targetId?,createdAt?,expiresAt}` → 摘要；最长 5 分钟 |
| findLoginChallenge / recordChallengeFailure | `(rawChallenge,at?)` → 有效行 / boolean；达到 5 次失败后不可消费 |
| withLoginChallenge | `(binding,syncMutation(row))` → null 或 `{result}`；binding 含 challenge/kind/sessionId/action/targetId/at，原子消费 |
| createOperationGrant | `{userId,sessionId,grant,action,targetId?,securityVersion,createdAt?,expiresAt}` → 摘要；最长 2 分钟且 session 必须有效/归属正确 |
| withOperationGrant | `(binding,syncMutation())` → null 或 `{result}`；binding 含 grant/userId/sessionId/action/targetId/securityVersion/at |
| getTotpCredential | `userId` → encrypted_secret / last_counter / enabled_at 行 |
| setPendingTotp | `{userId,encryptedSecret}`；不允许覆盖已启用因素，密文由安全原语生成，仓储不解密 |
| withTotpCounter | `({userId,counter,enroll?=false,at?},syncMutation)` → null 或 `{result}`；严格递增 counter，enroll=true 原子启用 |
| clearTotp | `{userId,at?}` → boolean；撤销全部旧材料后移除因素，仅已授权服务可调用 |
| setLoginPolicy | `{userId,policy:'standard'|'strict',at?}` → 用户；撤销旧会话，角色/组织最低要求由服务层实施 |
| addRecoveryCodes | `(userId,rawCodes[],at?)` → 新 ID 数组；由事务插入 |
| consumeRecoveryCode | `{userId,code,at?}` → boolean；仅内部恢复组合使用 |
| completeRecovery | `({userId,code,at?},syncMutation)` → null 或 `{result}`；单次消费后撤销旧安全材料/会话并审计 |
| addAudit | `{actorId?,targetId?,actorSessionId?,action,detail?,ipAddress?,authStrength?,at?}`；action 白名单且 detail 仅允许 reason/deviceLabel/authMethod/result/count/source 标量 |
| listAudit | `{userId,limit?=50,before?=auditId,includeDetails?=false}` → 按 id DESC 的本人事件摘要；仅 actor_id=userId 或 target_id=userId，limit 1–100；默认不返回 actor_id、IP、detail、actor_session_id，`includeDetails=true` 仅供服务层完成独立 grant 后调用 |

事务组合：`withLoginChallenge(binding, () => { const verified=repo.withTotpCounter(..., () => repo.createSession(...)); if (!verified) throw Error('TOTP replay'); return verified.result; })`。所有 callback 必须同步、失败抛错才回滚。返回 null 不代表抛错；外层应在验证失败时显式抛错，避免消费登录挑战却未创建会话。`withOperationGrant` 的回调必须检查目标归属，并在同一事务内变更目标和写审计；不能先消费授权再调用另一个异步请求。

离线迁移的 `data.migrated` 审计使用 detail.reason=migrationId、detail.source=sourceDigest、detail.result=backupDigest，不新增未审计字段。`setStorageUsage` 可嵌套外层 IMMEDIATE 事务，失败随外层回滚；迁移服务负责在写入前拒绝非零目标计量并计算实际总字节。

所有仓储是内部受信任服务接口，不是 HTTP 授权层；禁止把任意客户端参数直接透传到创建因素、改密码、角色、恢复或撤销接口。`findUser*` 返回含密码哈希，`findSessionById/Token` 含 token/CSRF 哈希，绝不能原样序列化到浏览器。管理员强制第二因素、临时会话限制、密码与验证码核验由安全服务执行。

D02 新增 users/sessions/login_challenges/operation_grants/recovery_codes/totp_credentials/audit_log。TOTP 只存密文与最后使用计数器，不存明文；敏感消息和配额预留仍不在此阶段 schema 中。
> 更新：2026-10-16（Asia/Shanghai）

## 范围

D01 提供显式数据根目录、SQLite 打开配置、迁移版本校验和安全文件权限。认证模块只能通过后续账户仓储使用本层，不得自行创建 schema 或读取生产环境变量。

## 运行约束

- 依赖：`better-sqlite3`，由组长在 `app/package.json` 和 lockfile 固化。
- 当前本机验证：Node `v24.21.0`、darwin/arm64、SQLite `3.53.4`；Docker/目标镜像构建不属于 D01 验收。
- `openDatabase({ storageRoot })` 要求显式数据根目录，不读取环境变量；数据库路径固定为 `<storageRoot>/donote.db`。
- 数据根目录权限为 `0700`；数据库文件、WAL 和 SHM 文件权限为 `0600`（宿主文件系统仍需运维验证）。
- 打开时强制 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout`（默认 5000ms）和 `synchronous=FULL`。
- 所有测试使用随机临时目录；D01 不访问项目 `data/`，不启动服务，不改现有路由。

## 迁移契约

`applyMigrations(db, migrations)` 接受从版本 1 开始的连续数组，每项必须包含：

```js
{ version: 1, name: 'database-foundation', sql: '...' }
```

- 迁移由单个 `BEGIN IMMEDIATE` 事务应用；争用超过 busy timeout 时抛出 `SQLITE_BUSY`，不隐式无限重试。
- `schema_migrations` 由框架创建，字段为 `version`、`name`、`checksum`、`applied_at`。
- checksum 为 `sha256(name + '\n' + sql)`；已应用迁移被修改、重排、跳号或删除时拒绝启动。
- 新迁移只能追加；业务迁移必须在 data-ops 的统一 schema 目录维护。
- 迁移 SQL 是受信任的应用代码，禁止拼接用户输入。
- DDL 或记录写入失败时整个迁移事务回滚，不能标记为已应用。
- 应用启动遇到未知或修改后的迁移必须失败关闭，不自动修复或跳过。

## 目标 schema 边界

D01 不创建业务表，只固定后续表的最小边界：

- `users`：不可变 UUID、规范化用户名、Argon2id `password_hash`、角色、启停/软删除时间、`security_version`、配额统计。
- `sessions`：用户外键、随机 token 的 SHA-256、设备摘要、创建/最近活动/空闲/绝对过期、撤销时间、认证强度。
- `audit_log`：actor、target、动作、脱敏详情、IP 摘要、时间；不记录密码、token、Cookie、恢复码、正文或密钥。
- 阶段 B 增加 TOTP/登录 challenge/操作授权/恢复码/安全事件表；阶段 C 再增加配额预留和敏感内容密钥元数据。

所有时间使用 Unix 毫秒。跨用户业务查询必须由服务端身份上下文决定；schema 不接受客户端 userId 作为权限依据。

## 接口与生命周期

- 调用方必须在完成操作后调用 `db.close()`。
- 数据库打开失败、迁移不一致或安全路径校验失败必须向上抛错。
- D01 不实现连接池、业务重试、账户事务或 HTTP 错误映射。
- WAL/SHM 文件是 SQLite 状态的一部分，备份与恢复模块必须使用一致性快照，不能只复制主数据库。

## 验收

独立测试覆盖：WAL、外键、busy timeout、目录/文件权限、迁移首次执行、幂等重开、checksum 篡改拒绝、版本重排/缺失拒绝、DDL 失败回滚、临时目录隔离。原生模块不可用时必须报告真实构建/加载错误，不得使用 JSON 或伪 SQLite 替代。
