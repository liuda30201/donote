# Q01 配额、物理计量与写入串行化契约

> 状态：Q01 独立计量/限制模块；业务入口接线依赖 E02 handoff。本文不表示所有消息与上传写路径已接入配额。

## 范围与依赖

实现：[quota.js](../app/src/quota.js)；独立测试：[quota.test.js](../app/test/quota.test.js)。模块只接受调用方注入的目录、配额、磁盘统计与持久化回调，不读取环境变量、不打开数据库、不自行推断账户身份。运行时负责解析 `DONOTE_DEFAULT_QUOTA_BYTES` 并传入 `createQuotaService({ defaultQuotaBytes })`；配置必须是非负 safe integer，未配置默认 `1073741824` bytes（1 GiB）。

`users.storage_quota_bytes` 已存在，无需 schema migration：正值是该账户覆盖值，0 使用进程全局 default。账户数据库使用量 `users.storage_bytes` 延续已上线迁移口径，即每个用户 `messages.json` 实际字节 + 其 `uploads/` 下全部普通文件的实际字节。计入 JSON 序列化开销、敏感文本密文与封装、备注、原图、缩略图及所有上传文件；同一路径仅作为一个磁盘文件计一次。只读测量采用 `lstat` / `stat.size`，不相信客户端声明的文件大小。

基线与迁移说明见 [DB 契约](donote-db-contract.md) 的 `setStorageUsage` / 离线迁移条目、[账户迁移](account-migration.md)。不要将此物理usage静默改为逻辑正文长度或仅计算被消息引用的附件；孤儿文件在删除成功前仍占物理空间，也须计入。

## 纯计算与拒绝语义

- `resolveQuotaBytes(accountQuota, defaultQuota)` 校验非负 safe integer；账号值为 0/未提供时返回全局默认，大于 0 时返回账号覆盖。
- `calculateProposedUsage({ currentBytes, addedBytes, releasedBytes })` 拒绝负数、不安全整数、释放大于当前值及加法溢出。
- `evaluateUsage` 返回当前值、拟提交值、有效配额、剩余和超限量。超额账户可以做不增加usage的操作（尤其删除/缩减）；产生更高usage的操作拒绝。`admitUsage` 在拒绝时抛 `QuotaError`，`code='QUOTA_EXCEEDED'`，携带安全计数字段。
- 对账应先真实测量再同步更新仓储用量。启动时必须在开始监听 HTTP/Socket 前完成所有活动账户的 reconcile；账户目录、消息JSON、上传目录扫描或DB写回任何失败均 fail closed，不得以旧的 storage_bytes 当作可用额度继续启动。对账发现超额账户不删除其数据，但阻止新增占用，并允许降量/删除。

错误均为稳定 `QuotaError` 代码，不携带文件内容、绝对路径或用户明文：`INVALID_BYTES`、`USAGE_OVERFLOW`、`QUOTA_EXCEEDED`、`INVALID_PATH`、`SYMLINK_REJECTED`、`LINKED_FILE_REJECTED`、`SPECIAL_FILE_REJECTED`、`PATH_CHANGED`、`PATH_STAT_FAILED`、`PATH_READ_FAILED`、`RECONCILE_FAILED`、`RECONCILE_PERSIST_FAILED`、`DISK_HEADROOM` 等。HTTP层需单独映射状态和公开错误，不回传内部 `message`、原始系统异常或路径。

## 目录检查与物理用量 API

```js
const { createQuotaService } = require('./quota');
const quota = createQuotaService({ defaultQuotaBytes: configuredDefault });

const usage = await quota.measurePhysicalUsage({
  messagesFile: '/data/users/<server-user-id>/messages.json',
  uploadRoot: '/data/users/<server-user-id>/uploads'
});
// { bytes, messagesBytes, uploadsBytes, fileCount }
```

也可传 `userRoot`（自动使用其中 `messages.json` 与 `uploads/`）。缺失的 JSON 文件或 uploads 根视为空，目录路径必须由可信服务端身份生成。模块逐级 `lstat` 并拒绝路径任一组件为 symlink，拒绝硬链接文件（`nlink !== 1`）、设备/管道等特殊文件和读取期间发生的竞态消失；所有子目录递归扫描，使用安全整数累加。此测量不是锁：运行时须在同用户串行区间内测量；对账在启用写服务之前运行。

磁盘余量检查：

```js
await quota.checkDiskHeadroom(rootPath, anticipatedNewBytes);
// 要求可用空间 >= anticipatedNewBytes + minFreeBytes
```

`minFreeBytes` 是显式依赖配置；不可获得真实 `statfs` 或值异常时 fail closed。空间检查只是提前拒绝，不保证后续文件系统写入必成功；实际 `ENOSPC` 仍必须中止整个变更、清理操作专属未发布文件并保持原消息状态不变。

## 单进程写队列和 E02 接口

当前系统明确只支持**一个 Node 写进程/单写者**；内存队列不能协调多 worker、cluster、多个容器或外部修改同一目录。若扩展成多写者，必须先设计跨进程锁/数据库预留和崩溃恢复，不可把当前内存队列视为安全。

配额服务暴露 `runMutation(userId, task, options)` / `withUserMutation(userId, task, options)` 的按用户 FIFO 队列：同用户一次仅执行一个 task，不同用户可并行；全局 pending waiter 数有界，支持排队阶段 signal cancellation 与等待超时，队满、取消、超时均带稳定错误码。另有全局 `withUploadLimit(task, options)` 控制活跃上传并发和排队上限。必须从请求到handler整个异步mutation期间持锁；不要只在检查 quota 时加锁、随后释放再写文件。

E02 的 storage 设计使用同一个 runner：`configureMutationRunner(quota.runMutation)` 配置之后，所有业务写路径调用 `commitUserMutation(userId, mutate, options)`；该方法只获取一次锁，内部clone候选state、运行变更并durable-persist后才发布内存。quota `measure/evaluate/admit` 是纯检查，不再嵌套获取锁。文件路由/清理须迁入 storage 提供的同一 `commitUserMutation` 或明确标记“已在该用户锁内”的低阶实现；不可在 `commitUserMutation` 内再调用 `quota.runMutation`，否则同用户会自死锁。

如果 E02 的 runner 尚未交接，Q01 队列只作为独立模块/API原型使用；业务整合不得同时启用两套独立用户锁。接线验收须证明 storage 的 JSON 持久化、所有消息修改、备注/收藏、清空/删除、过期/孤儿清理、multipart 与 Data URL 同属同一队列。

## 临时写入、提交与对账恢复

1. 从已认证服务端上下文获取 userId、用户数据根目录和用户配额，不能接受客户端路径/userId当权限依据。
2. 在用户锁与全局上传限制内预检预计使用、上传请求/并发/最小剩余磁盘；`Content-Length` 只用于提前拒绝，不能当最终字节数。
3. multipart 临时写入需操作唯一标记和登记精确创建文件；Data URL 先完整校验/解码，图片原图和缩略图分别计实际buffer长度；同一路径去重。配额须在临时目录也被限制，避免未提交上传绕过全局磁盘防护。
4. 在正式发布前重新对账候选消息 JSON 的 UTF-8 序列化实际字节与 uploads 全部真实文件。同步仓储事务内原子检查当前配额并更新 storage_bytes（沿用现有 `setStorageUsage` 时由可信服务在同一事务内锁定/核验账户行）；不可开着 SQLite 同步事务跨 `await` filesystem I/O。
5. JSON/SQLite/文件系统不是一个原子事务。候选JSON durable成功前不得广播/发布内存；出错时只删除本操作创建并仍未引用的文件。若JSON已durable而usage DB提交失败，不可盲删已被消息引用的附件；拒绝后续写入/服务就绪并通过启动reconcile恢复usage。若quota/usage先提交而JSON失败，则补偿恢复旧usage，失败也必须fail closed并启动对账。
6. 失败清理只可用操作显式拥有的临时/目标路径，不允许根据宽泛目录路径删文件。删除原资源后再测量并释放真实usage；unlink失败不可报告释放空间。客户端断开需由生命周期继续跟踪服务端写任务，abort只取消尚在排队的工作；进入不可中断commit阶段后按一致提交/回滚结果收尾。
7. 启动先清理可证明归属于已终止旧操作的临时资源，再逐用户扫描正式message JSON及全部uploads，调用同步repo写回实测storage_bytes；任意不安全文件/扫描/持久化失败则不listen。活跃上传临时资源不可被定时孤儿扫描删除。

## 取消、等待与限制

- `maxMutationWaiters`、`mutationWaitTimeoutMs`、`maxConcurrentUploads`、`maxUploadWaiters`、`uploadWaitTimeoutMs` 是构造参数，不隐式读环境；部署层显式给合理上限。
- 等待中的任务允许通过 `AbortSignal` 取消；开始执行后，调用方负责传信号给任务并实现事务边界安全，队列不会强行终止不可取消文件操作。
- 队列全满/等待超时/取消应在handler尚未写入前返回；每个请求仍需最大总字节、字段数、parts数、单文件大小和超时限制。
- 最小磁盘余量是系统保护，不能被用户quota取代。配额可允许写入时，disk headroom仍可独立拒绝。

## 测试与上线前接线清单

当前纯模块测试：

```bash
cd app && node --test test/quota.test.js
```

集成前还须补充/运行真实HTTP测试：multipart/dataURL并发不超额、虚报size/Content-Length、原图缩略图差异与去重、remark/favorite/敏感加密写入物理JSON变化、删除/expiry释放、partially written/rename/copy/ENOSPC/abort rollback、重启reconcile与目录链接拒绝、accounts迁移后的旧storage_bytes不变、backup/restore仍保存全部计量文件。当前核心模块测试不覆盖这些业务入口，也不宣称上传/消息配额保护已启用。
