# 离线账户初始化与迁移预检

> 状态：`init-admin` 与经停写确认的真实 `migrate` / `migrate-recover` 已实现；必须先在合成目录完成演练并由操作者确认停写。

工具：[accounts.js](../app/scripts/accounts.js)。设计依据：[多用户与数据保护设计](donote-multiuser-data-protection.md)。

## 离线初始化

先停止应用及所有外部写入者，确保没有其他进程操作同一数据目录，再执行：

```bash
node app/scripts/accounts.js init-admin --data-dir /absolute/private/data --offline-confirmed < /private/initial-account.json
```

输入文件是 JSON 对象，只支持 `username`、`password`、可选 `displayName`。密码应由交互密码管理器或受限输入渠道生成，不写入命令行参数、Shell 历史或仓库。受限文件权限应为 0600，使用后按本机安全策略处置。工具不会加载应用配置或读取生产环境密码。

数据目录必须显式指定、事先存在且不是符号链接；父目录必须由可信操作者控制。初始化会按数据库模块策略收紧目录和数据库权限。密码使用现有 Argon2id 策略（至少 12 个字符、最多 1024 UTF-8 字节）；不输出密码或哈希。

首次初始化在 SQLite immediate 事务中检查 users 表为空，创建 admin、设置 `must_change_password=1` 并写审计。只要已有任意账户，就拒绝再次初始化；不会重置现有管理员，不会创建 session。管理员首次使用仍需走系统强制改密和第二因素绑定流程。离线初始化无需认证密钥；启动账户运行时并首次绑定因素前，必须按运行时契约配置 `AUTH_KEY_FILE`，内容为原始 32 字节密钥，不能误用 64 字符十六进制文本。该密钥独立保存，不由初始化命令生成或输出。

`--offline-confirmed` 是操作者确认，不是进程锁或停服探测。工具不会启动、停止或部署服务。运行前必须自行确保全部写入者停止。

## 真实迁移与恢复

预检命令使用 `--dry-run`；确认输出 `executable: true` 后，去掉该标志执行真实迁移。真实执行要求来源、备份和目标位于受控目录，目标是数据库中已存在且为空的活动 UUID 账户：

```bash
node app/scripts/accounts.js migrate --data-dir /absolute/private/data --source-user legacy --target-user 12345678-1234-4234-8234-123456789abc --backup /absolute/private/backup.tar.gz --offline-confirmed
```

工具在同一文件系统建立 `.account-migrations/<migrationId>/stage` 和 `journal.json`，逐文件复制并校验，再在 SQLite immediate 事务中复核来源与备份摘要、更新 `storage_bytes`、撤销目标旧会话并写入 `data.migrated` 审计，最后将暂存目录原子发布到 `users/<target UUID>/`。来源目录从不删除或修改。数据库审计和 journal 同时绑定 migration ID、来源摘要和备份摘要。

若进程在发布后中断，使用 journal 中的 migration ID 恢复：

```bash
node app/scripts/accounts.js migrate-recover --data-dir /absolute/private/data --migration-id <migration-id> --offline-confirmed
```

恢复只接受路径、UUID、摘要和审计记录完全一致的状态；不一致时拒绝自动修复并保留现场。

```bash
node app/scripts/accounts.js migrate \
  --data-dir /absolute/private/data \
  --source-user legacy \
  --target-user 12345678-1234-4234-8234-123456789abc \
  --backup /absolute/private/backup.tar.gz \
  --offline-confirmed --dry-run
```

`legacy` 表示数据目录根部的旧单用户 `messages.json` 和 `uploads/`；其他来源 ID 表示 `users/<旧用户ID>/`，仅允许简单安全 ID。目标必须是 UUID，不存在于 users 目录；任何已有目标均拒绝覆盖。不能用此命令迁移用户名或认证凭据。

预检检查：

- 显式的有效备份归档，复用严格恢复校验器，需要宿主机 Python 3。
- 消息 JSON 的基本结构、普通文件/目录、拒绝链接与特殊文件。
- 所有图片及文件引用均位于该来源用户的 uploads 中且实际存在。
- 目标目录冲突和源文件 SHA-256 清单。

成功预检输出 `result: validated`、`executable: true`、消息/文件数量和来源及备份摘要；失败返回非零状态，错误信息刻意不回显输入和敏感路径。dry-run 不创建迁移目录、目标目录或写入数据库。

## 一致性与操作边界

目录 rename 与 SQLite 提交不构成跨存储原子事务，因此 journal 和数据库审计作为恢复协议：有已提交的匹配审计且目标摘要一致时标记 COMMITTED；无审计时将本次发布的目录撤回暂存并标记 ROLLED_BACK。来源始终保留。遇到未决 journal 时拒绝新迁移；成功迁移的同一来源拒绝重复映射。

`.account-migration.lock` 只排斥其他迁移工具，不能阻止运行中的应用或其他写入者。必须先停服；恢复只能接管 PID 已不存在的陈旧锁。文件与目录均 fsync，平台必须支持目录 fsync。目标计量按消息 JSON 与全部附件文件大小合计，非零计量或已有目标目录一律拒绝。

备份必须位于数据目录外，严格校验器验证归档后，工具读取归档实际来源子树并逐项匹配当前 SHA-256 清单；来源或备份在发布前变化也会拒绝。可使用有效 legacy 归档，或由账户备份工具生成并通过校验器的 accounts 归档。迁移只校验并迁移指定来源数据，不恢复备份数据库或认证凭据。

本次工具不改动既有备份/恢复及数据库实现，不复制旧明文密码、不删除来源、不执行部署。

## 合成验证

```bash
node --test app/test/migration.test.js
```

测试在临时目录执行真实 SQLite 和 Argon2id，覆盖初始化、重复初始化、弱密码、命令行密码拒绝、备份损坏、目标冲突、附件缺失，以及 dry-run 不写入数据。测试结果不代替真实迁移演练。
