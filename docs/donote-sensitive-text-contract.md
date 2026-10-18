# 敏感文本安全契约（E01）

## 状态与范围

E01 交付独立加密、内容 keyring、可验证重加密、锁定序列化和内存一次性 grant。只修改 [sensitive.js](../app/src/security/sensitive.js)、[sensitive.test.js](../app/test/security/sensitive.test.js) 及本文，不修改消息路由、存储 schema、前端、package 或现有账户密钥运行时。E02 负责产品接线，**E01 完成不等于现有消息已受保护或整体可部署**。

据 Lead 通知，G01 已有 Nginx 与 Chrome 实测 PASS，但最终 app 镜像仍未通过。本次按其继续完成代码阶段的授权交付 E01；代码阶段测试不依赖镜像，不据此声称完整 G01 通过。最终镜像、E02 产品端到端与发布验收仍是独立门槛。

已阅读 [primitives.js](../app/src/security/primitives.js)、[runtime.js](../app/src/security/runtime.js)、[schema.js](../app/src/db/schema.js)。复用既有随机 token 与 token 摘要，沿用 AES-256-GCM/独立 nonce/tag 验证原则。既有 encryptSecret 的 4096 字节固定上限适合 TOTP，不适合正文；为不修改其安全行为，在限定模块实现独立、有硬边界的文本 GCM 适配，而不是分块拼接或无界扩展。该模块不自动复用 AUTH_KEY，不向持久化 operation_grants 写入解锁授权。

## 加密 API 与封装

```js
encryptSensitiveText({ content, remark }, key, { userId, messageId, keyId })
decryptSensitiveText(payload, key, { userId, messageId, keyId })
```

- key 为显式 32-byte Buffer；无默认密钥、自动生成替代密钥、密码派生或隐式读文件。
- userId/messageId/keyId 为 1–128 字符显式字符串，必须由可信服务端提供；载荷不是所有权证明。
- content/remark 为显式、well-formed 字符串，空字符串合法；每字段最多 **1048576 UTF-8 字节（1 MiB）**，超限或孤立 surrogate 拒绝而非截断。两字段都先验证再加密。该限制是模块硬上限，HTTP 可以进一步收紧；标记旧的超大普通消息时必须报错并保留原数据，不能截断。
- 每字段独立随机 12-byte nonce，AES-256-GCM，16-byte tag。AAD 精确为 `UTF8(JSON.stringify(['donote-sensitive-text', 1, userId, messageId, field, keyId]))`，field 仅为 content 或 remark，绑定用户、消息、字段、版本及 keyId；字段互换、跨用户及跨消息移植均失败。
- payload 精确为 `{ version: 1, content: envelope, remark: envelope }`，两个 envelope keyId 必须一致；envelope 精确包含 `{ version: 1, algorithm: 'aes-256-gcm', keyId, nonce, ciphertext, tag }`，后三项为规范 base64。封装为 E01 稳定结构，不兼容先前仅供预研的 purpose-hash AAD；预研载荷从未接产品或持久化。
- 先限制 base64 字符串长度再分配解码内存，解码后再次验证规范编码、长度和字段大小；拒绝未知版本/算法/额外字段、错误 nonce/tag、错 AAD/key、混合 keyId、畸形编码和无效 UTF-8。UTF-8 解码保留 BOM，不替换损坏字符。
- 所有解密失败统一 `Error('Sensitive text authentication failed')`，无输入回显、明文、密钥或底层 cause；不返回部分字段、不回退空文本、不覆盖原载荷。
- 显式创建的明文 Buffer 会在 finally 清零，包括认证失败时 crypto.update 产生的临时数据；JS 字符串和 crypto 内部复制无法可靠清零，不宣称安全擦除。解密函数不是授权入口。

## 独立内容 keyring 与轮换

```js
const ring = createSensitiveKeyring({
  activeKeyId: 'content-2026-10',
  keys: { 'content-2026-09': oldContentKey, 'content-2026-10': newContentKey }
});
ring.encrypt({ content, remark }, { userId, messageId });
ring.decrypt(payload, { userId, messageId });
ring.rotate(payload, { userId, messageId });
ring.close();
```

- keyring 含 1–32 个显式 32-byte 内容密钥，activeKeyId 必须存在；不同 keyId 不能配置相同 key bytes。独立内容 key 必须与账户 AUTH_KEY 不同，部署/运行时集成必须验证这一点；模块不持有账户密钥，不能代替配置检查。
- 构建时防御性复制 key，调用方后续修改 Buffer 不影响内部副本。无返回密钥、导出密钥、自动补钥、运行中删除 key 接口。JSON 仅暴露 activeKeyId。
- encrypt 总是使用 activeKeyId；若上下文显式 keyId 与 active 不符则拒绝。decrypt 从受限 keyring 按 envelope keyId 选择 key，未知 keyId fail closed；若调用方显式 keyId 则必须匹配。userId/messageId 始终来自可信上下文。
- rotate 先完整认证旧载荷，再以 active key 和新随机 nonce 重加密两字段，并回读核验正文和备注一致；不修改旧对象、不写盘。相同 active key 的重试也产生新 nonce。
- **原子持久化属于 E02/运维职责**：持锁读取旧记录，生成并核验候选，以写屏障/版本检查防止覆盖并发编辑，原子持久化成功后才更新内存并确认。迁移可重试；失败保留旧载荷。模块 rotate 是轮换安全原语，不是已部署的全库迁移任务。
- 旧 key 必须保留到所有活跃记录和备份均完成核验；恢复旧备份必须带对应旧 key。不可仅以“当前 JSON 已完成”退役旧 key。新 key 的启用通过重新配置实例完成，不自动推断。
- close 幂等清零内部副本并拒绝后续使用；不清除调用方原 Buffer，调用方须管理来源密钥和文件权限。
- E02 运行时必须外置独立内容 key 文件及 keyId，禁止放入代码、数据库、审计或普通数据备份；不绑定用户密码、不自动替换丢失 key。建议沿用账户 key 的 0600、普通单链接文件、真实路径在数据目录外检查，但不复用 key bytes。

## 锁定序列化

```js
serializeSensitiveText(record)
// { id, type: 'text', sensitive: true, content: null, remark: '' }
```

只接受已显式标记的 text 记录，allowlist 丢弃旧正文、备注、encryptedPayload 及所有未知嵌套字段。它是纯函数，不删除调用者旧引用。此 helper 的 JSON 无敏感明文/密文；E02 必须将列表、搜索、收藏、Socket、分享及导出统一接入对应安全边界。存储密文与对外锁定 JSON 是不同格式，禁止直接传播存储记录。

E02 仍须落实：搜索排除敏感正文和备注；分享禁止泄露；解密响应 no-store；浏览器仅内存短时展示、到期/隐藏/换账户/撤销时清除；禁止 localStorage/IndexedDB/Service Worker/普通数组快照持久化；敏感标记只有在密文持久化成功后确认。附件不在本模块范围。

## 内存一次性解锁 grant

```js
const grants = createSensitiveUnlockGrants({ now: Date.now, maxEntries: 1000 });
const scope = { userId, sessionId, securityVersion, messageId, action: 'reveal' };
const { token, expiresAt } = grants.issue(scope, absoluteExpiresAt);
grants.consume(token, currentServerScope); // boolean; success consumes once
grants.revoke(token);                    // boolean
grants.revokeSession(userId, sessionId);  // revoked count
grants.revokeUser(userId);                // revoked count
grants.revokeMessage(userId, messageId);  // revoked count
grants.clear();
```

- issue 只用于调用者已完成近期密码验证/所需因素及有效会话验证之后；helper 不验证密码、因素、CSRF、Origin、角色或 session。客户端自报 scope/securityVersion/期限不能作为授权事实。
- 固定用途 reveal，不得用于登录、设备撤销、修改备注、取消敏感或授权导出。scope 绑定全部五项身份/资源/用途；securityVersion 为正安全整数。普通 reveal 显示无法从技术上禁止用户复制已见明文，但其他服务端操作不能复用令牌。
- 期限为 Unix 毫秒绝对时间，严格大于 now 且最长 120000ms；now >= expiresAt 即失败，不滑动延期。调用者应将期限进一步限制在会话期限和近期验证窗口内。
- 实例只在内存 Map 保存 token SHA-256 摘要、scope 和期限。token 为 256-bit 随机 base64url，仅签发返回；无磁盘/DB/恢复接口。JSON 为 `{}`，新实例不能恢复旧 grant，token/返回对象不得记日志或持久化。
- consume 同步原子删除成功匹配项；到期、撤销、错 scope、未知/非法 token 返回 false，错 scope 不消耗正确 grant；解密失败不恢复已消费 token。
- 每次 reveal 先重新查询当前有效 session、securityVersion、账户状态、所有权及消息状态，再 consume，再 decrypt，响应前避免异步期间撤销竞争。撤销接口应在退出/账号停用删除/改密/因素变更/消息删除与敏感状态变更时调用。当前模块提供接口，事件接线属 E02。
- 可信时钟可注入测试；实例保留观察到的最大时间，回拨不复活已观察过期项；不是硬件可信时钟。默认容量 1000，配置最多 10000，满则 fail closed，每次访问懒清理。单实例同步语义；多 worker 必须独立评审，不能直接持久化 token 绕过契约。

## 验证与剩余发布边界

合成测试覆盖真实 crypto、nonce、1 MiB/多字节边界、BOM、孤立 surrogate、超大 base64、错 AAD/key、双字段篡改、统一错误、无明文/密文锁定序列化、旧 key 解密/active 重加密/回读/不修改旧载荷、key 副本/close、keyring 无 key 序列化、grant 全 scope/绝对期限/一次消费/各级撤销/容量/实例隔离。

运行：`node --test app/test/security/sensitive.test.js app/test/security-primitives.test.js`；`cd app && npm run check`。

E01 为代码模块与契约交付；未修改 E02 文件，不等于产品集成验收。最终 app 镜像、运行时独立 key 加载、消息持久化/并发原子替换、真实浏览器短时显示与撤销事件、全库轮换运维执行、备份恢复及多 worker 尚须由对应阶段验证。密钥丢失不可恢复、长度和元数据仍可见、历史备份/文件系统旧块/浏览器历史缓存不保证追溯擦除。
