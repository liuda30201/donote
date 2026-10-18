# 敏感内容密钥轮换与历史恢复

## 已交付工具

[rotate-sensitive.js](../app/scripts/rotate-sensitive.js) 是 accounts 布局的离线工具；[sensitive-rotation.test.js](../app/test/security/sensitive-rotation.test.js) 使用真实临时文件、真实 GCM 和 SIGKILL 子进程验证。未读取或修改真实用户数据；工具不导入应用运行时或环境密钥。

必须先停止应用、清理器、所有 worker 和外部写入者，并保持停机直到成功提交或恢复完毕。`--offline-confirmed` 是操作者承诺，不是停机检测；本工具不提供运行中并发迁移。

默认 dry-run，只全量校验，不创建 journal 或修改文件：

```sh
node app/scripts/rotate-sensitive.js \
  --offline-confirmed --data-dir /absolute/data \
  --keyring-file /absolute/private/content-keyring.json \
  --active-key-id content-2026-10 \
  --auth-key-file /absolute/private/auth.key
```

确认 dry-run 返回 `validated` 后，使用相同参数增加 `--apply`。恢复已发布的 prepared/committed journal，增加 `--apply --recover`。`--dry-run` 可显式提供，不能与 `--apply` 同时使用；未知、重复、遗漏参数均拒绝。正常 stdout 仅输出 JSON 结果/用户数/敏感消息数/待轮换数；错误 stderr 固定，不回显正文、密钥、路径或输入。

## 与 E02 共用的配置和数据格式

keyring 文件精确结构如下；值必须为恰好 32 bytes 的规范 base64：

```json
{"version":1,"activeKeyId":"content-2026-10","keys":{"content-2026-09":"<canonical base64>","content-2026-10":"<canonical base64>"}}
```

- 与 E02 `SENSITIVE_KEYRING_FILE` 格式一致；CLI 参数必须显式提供，activeKeyId 必须与文件一致，无默认 keyId/自动补钥。旧 keys 与 active key 都须保留。
- keyring 与 AUTH key 文件须是数据目录之外的真实路径、0600 普通单链接文件，不接受路径中的 symlink。AUTH key 须恰好 32 bytes，用于验证各内容 key 均不同于账户密钥；内容 key 彼此也必须不同。keyring 最多 32 keys，文件最大 16384 bytes，与服务启动和备份校验保持一致。
- 只处理 `users/<UUID>/messages.json` 的 `{messages,lastActivity,...}` 状态；可信目录 UUID 为 AAD userId，record.id 为 messageId，不信任 record.userId。用户目录有 uploads 但没有 messages.json 可跳过；拒绝非 UUID 用户目录、符号/硬链接消息文件、重复消息 ID，以及根级 legacy messages.json，避免静默漏检。
- 敏感消息必须为 `{id,type:'text',sensitive:true,content:null,remark:'',encryptedPayload:<E01 payload>,...}`；明文残留、未知 keyId、GCM 认证失败、不支持载荷、非敏感记录却持有 encryptedPayload 均 fail closed。其他元数据和普通消息原样保留，不进行字段规范化或丢弃。
- 单文件最大 256 MiB，首次预检源文件总量最大 512 MiB；超限拒绝，须另行实现流式/分批方案，不能取消离线与全量认证要求。工具会在内存中保留多个表示，操作者需预留相应 RAM 和磁盘。

## 校验、提交与中断恢复

所有用户全部敏感载荷先认证成功，才生成新候选。已为 active key 的消息保持原密文，其他消息通过 E01 rotate 完整认证、随机新 nonce 重加密及回读验证。任何用户认证失败，所有消息文件均不写入。

写入前复核用户清单和全部源文件摘要，接着在数据根内唯一 `.sensitive-rotation.tmp-<UUID>` 目录写入每用户 `.old`/`.new`、journal，逐文件 fsync、目录 fsync，再原子发布为 `.sensitive-rotation`。只有完整 durable prepared journal 发布后才改消息文件。

- staging 阶段中断：消息文件未改，未发布 `.sensitive-rotation`；保留唯一 stage 作为证据，重新执行正常 dry-run/apply 可生成新候选。不要将未发布 stage 当作可恢复 journal。最终完成后由操作者在停机下核验并归档这些遗留目录，不自动删除。
- prepared 阶段中断：可能部分用户已是新密文、部分仍为旧密文；不要启动应用或重新正常 apply，使用完全相同 keyring 文件（含旧 keys，字节摘要相同）与 `--apply --recover` 前进完成。工具拒绝把变更后的 keyring 配置用于已有 journal。
- 恢复先核验全部 journal schema、安全文件路径、文件摘要、旧/新载荷认证，以及两者解密内容和全部元数据一致，再验证所有当前源文件摘要为旧或新。即使 journal 中 candidate 摘要被改，解密内容/元数据不一致仍拒绝。未知修改、缺旧 key 或候选损坏均拒绝，保留现场。
- 每个目标使用其目录内唯一、排他创建的 `.messages.json.sensitive-rotation.tmp`，写入/fsync 后原子 rename，再 fsync 目录；已存在 tmp 仅当为私有普通单链接且精确匹配 candidate 摘要才允许恢复。不会覆盖未知 tmp；跨用户无法单 rename 原子提交，所以必须持续停机。
- 所有目标成功后 journal 原子改为 committed。重复 `--recover` 可核验并幂等完成；普通 apply 在 journal 存在时拒绝，避免覆盖旧恢复证据。

工具不自动清理旧密钥、journal 或备份。`.old/.new` 是完整用户状态，可能含普通消息明文，应与私有备份同等保护：目录 0700，文件 0600。journal 不是防恶意 root 攻击的签名；同时控制源数据、keyring 和 journal 的主体不在工具的完整性威胁边界内。

完成并核验后，操作者需将完整 journal/遗留 stage 移出数据目录到受保护的归档位置，才开始下一次轮换或常规备份；不要只删除 journal.json。工具不执行该归档动作。磁盘应预留旧状态、新候选和原子替换 tmp 的总空间。若保留 prepared journal，恢复前不得重启服务；若 stage 写入不完整则源未改，但仍须确认没有已发布 journal。

## 历史密钥恢复与备份边界

只读审查时，[sqlite-backup.py](../scripts/lib/sqlite-backup.py) 的账户 manifest 仅有 AUTH keyId/fingerprint，[restore.sh](../scripts/restore.sh) 仅验证账户 key；因此账户恢复成功不能证明敏感内容可解密。备份 manifest 记录 requiredContentKeyIds，恢复切换前使用外置 keyring 全量认证全部用户敏感载荷；对应实现与测试作为恢复验收依据。

备份应拒绝数据目录中任何 `.sensitive-rotation` 或 `.sensitive-rotation.tmp-*`，以防复制半提交或遗漏 old/new 所需 key。恢复切换前须用外置 keyring 全量认证全部用户敏感载荷，manifest 只记录 requiredContentKeyIds，禁止放入密钥。

**旧 key 必须保留直到所有依赖旧 keyId 的活跃记录、历史备份、轮换 journal 和遗留 stage 全部退役。** 轮换当前消息完成不构成旧密钥退役依据。恢复旧备份必须使用包含对应旧 keys 的外置 keyring，再按相同流程轮换到 active key；不能从新 key 推导旧 key，也不能自动替换丢失 key。

工具不负责应用部署、数据库会话、前端缓存、历史介质擦除或附件加密。密钥丢失无法恢复，长度/元数据仍可见。

## 验证

```sh
node --test app/test/security/sensitive-rotation.test.js app/test/security/sensitive.test.js app/test/security-primitives.test.js
cd app && npm run check
```

测试包括默认 dry-run 无写入与日志脱敏、全用户认证失败零写入、旧密文与 key 保留、真实 SIGKILL 部分提交恢复、重复恢复、候选篡改/缺旧 key/源变化拒绝、staging 中断安全重试、重写摘要仍需内容等价，以及不安全配置/硬链接拒绝。均为隔离合成 fixture，不代表真实目标镜像、生产数据或完整发布验收。
