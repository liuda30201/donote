# DoNote 认证原语与后续集成契约（S00）

> 日期：2026-10-16。状态：独立原语已实现；本文的 HTTP 状态机、会话和策略是后续集成要求，尚未接入现有应用。
> 依据：[架构方案](donote-multiuser-data-protection.md)、[团队计划](donote-team-implementation-plan.md)、[数据库契约](donote-db-contract.md)。

## 1. 写入边界

S00 仅交付 [primitives.js](../app/src/security/primitives.js)、[独占测试](../app/test/security-primitives.test.js) 和本文件。不修改 HTTP、Socket、前端、配置、依赖和 schema。现有密码认证仍未替换，不得因为原语测试通过宣称账户安全已经上线。

## 2. 原语接口

CommonJS 导出，所有密钥和上下文由调用方显式传入，不读取环境变量或真实数据。

| 接口 | 契约 |
| --- | --- |
| `hashPassword(password)` | 异步真实 Argon2id v19，64 MiB、3 次、并行度 1、随机 16 字节 salt、32 字节输出；至少 12 个 JS UTF-16 code units，最多 1024 UTF-8 字节；不 trim、不规范化 |
| `verifyPassword(password, encoded)` | 异步返回布尔；只接受上述固定参数和长度，兼容库输出参数顺序；错误、非法输入、其他策略均返回 false；未来参数升级需显式增加版本兼容 |
| `generateToken()` / `hashToken(token)` | CSPRNG 32 字节 base64url 无填充 token；哈希为其 ASCII 表示的 SHA-256 十六进制；拒绝非规范编码 |
| `constantTimeEqual(a,b)` | 字符串内容经固定长度 SHA-256 后 timingSafeEqual，并检查原始字节长度；不承诺隐藏长度或整个程序执行时间 |
| `generateTotpSecret()` | 随机 20 字节，规范大写无填充 Base32 |
| `generateTotp(secret,{now,digits,window})` | RFC6238 HMAC-SHA1、30 秒、T0=0；now 为 Unix 毫秒安全整数；默认 6 位，8 位供标准向量及显式策略使用 |
| `verifyTotp(secret,code,options)` | 默认前后各 1 步，最多 ±1；严格等长数字字符串；返回匹配 counter（包括 0）或 null，调用方不得用 truthiness 判断；非法 secret/options 抛错 |
| `encryptSecret(plaintext,key,context)` | key 必须 Buffer32，context 含非空 userId/purpose/keyId；字符串最多 4096 字节；输出 v1 AES256GCM、随机 nonce12、tag16、规范 Base64 |
| `decryptSecret(envelope,key,context)` | AAD 编码为 JSON 数组 `['donote-secret',1,userId,purpose,keyId]`；用户/用途/keyId/密文/tag/nonce 不匹配即失败，不提供降级明文 |
| `generateRecoveryCodes(count=10)` | 1–20 个，各 128 位随机数、4 组小写十六进制，显示一次 |
| `hashRecoveryCode(code)` | 严格格式，SHA-256 加 `donote-recovery-v1\0` 域分隔；只提供独立原语，不自动与仓储哈希策略混用 |

HTTP 层固定 TOTP 为 6 位，不允许请求参数选择 digits/window/now。时间来自服务器。GCM 外部 keyId 用于选择受控 keyring 的密钥，不从客户端接受任意密钥路径。密钥轮换须保留历史解密能力。

## 3. D02 仓储交接与事务

与 db-foundation 已协调：`createRepositories(db)` 使用 camelCase 输入、snake_case 数据行。精确方法以 D02 更新后的数据库契约为准，S00 不创建 schema。

- D02 接受原始高熵 session/challenge/grant/recovery token，再由仓储 SHA-256 保存；调用方不能先调用 `hashToken` 或 `hashRecoveryCode` 后又传给原始 token 参数，避免双重或不同域哈希。
- D02 恢复码匹配若采用 `SHA256(raw)`，则使用 `generateRecoveryCodes` 生成的 raw 值直接交仓储。本模块带域分隔的 `hashRecoveryCode` 不用于该仓储路径；未来变更需一并版本化写入与查询。
- `getTotpCredential(userId)` 提供 `encrypted_secret,last_counter,enabled_at`；持久化 GCM envelope 用明确 JSON 编码，不记录解密内容。
- `setPendingTotp({userId,encryptedSecret})` 仅设置未启用因素；验证成功才能启用。
- `withTotpCounter({userId,counter,enroll,at},syncMutation)` 原子要求 counter 大于历史 counter；重放返回 null，成功返回 `{result}`。必须同步回调，不在 SQLite 事务中 await Argon2。
- 登录使用 `withLoginChallenge` 与 `withTotpCounter` 嵌套，保证 challenge 消费、counter 更新、session 创建及审计同事务提交。密码/TOTP 运算先在事务外完成，事务内重新检查账户状态、安全版本和绑定。
- `withOperationGrant(binding,syncMutation)` 同时校验 user/session/securityVersion/action/明确 target，消费一次性 grant，执行撤销与审计。回调失败必须全部回滚。
- 恢复码同样必须一次性事务消费；校验哈希相等不等于已消费。

原语无防重放状态；重复 `verifyTotp` 得到同一 counter 是预期行为，仓储 CAS 才提供跨请求保护。集成测试必须验证两个并发请求只有一个成功。

## 4. 登录状态机

```text
未认证 → 密码验证
  ├─ 失败 → 统一错误 + 限流/审计
  ├─ 需要强制改密或管理员首次绑定 → 受限初始化 challenge
  ├─ 需要第二因素 → 短期登录 challenge → TOTP/恢复验证
  └─ 策略完整满足 → 新建完整 session
```

建议登录 challenge 最长 5 分钟、最多 5 次尝试（由服务端固定）；额外账户、来源和全局并发限制必须同时存在。challenge 只可用于指定账户和用途，不能作为 HTTP/Socket 会话。原始 challenge 不进 URL、日志或 localStorage。第二因素成功签发完整 session 时旧 challenge 原子失效，不能升级原始 session token。

管理员完整登录要求第二因素。首次管理员只能使用受限初始化流程绑定验证，不能通过“未绑定”分支获得普通会话。恢复码只进入受限恢复流程，恢复完成递增 securityVersion，撤销旧 session、challenge、grant 和旧恢复码。

## 5. Cookie、CSRF 与 Socket

生产由服务端设置 `__Host-dn_session`：`Path=/; HttpOnly; Secure; SameSite=Lax`，不含 Domain；临时设备不设持久 Max-Age，仍有服务端绝对/空闲期限。服务端每次检查账户启停、securityVersion、会话撤销和期限。

`GET /api/auth/me` 返回身份、当前 session ID、期限和绑定 session 的 CSRF token，不返回会话 token。所有私有响应 no-store；所有写请求包含 CSRF header 并校验精确 Origin，登录也做来源验证。Cookie 与临时 challenge 分开解析，拒绝重复或含糊 Cookie。401 清私有状态，不回退旧密码 header/query/Cookie。

Socket 从握手 Cookie 验证完整 session，不接受客户端 token/userId 决定身份。握手存在 Origin 时必须精确命中允许来源且不得回退；浏览器同源 polling GET 省略 Origin 时，仅允许 transport=polling、HTTP GET、Sec-Fetch-Site=same-origin 同时满足，且可解析无用户信息的 Referer 的 origin 精确命中允许来源。不使用 Host/转发头代替配置来源，缺失来源信息时拒绝。撤销和到期断开对应 session；推送前确认有效，重连重新认证。受限 challenge 禁止连接。客户端只增加功能并复用现有样式，不能重设计页面。

## 6. 敏感操作授权

`POST /api/auth/reauth` 验证当前 session 及指定操作所需因素。开启 TOTP 的账户必须验证 TOTP；关闭/替换第二因素同时重新确认密码。未启用因素的普通账户以密码再次验证，不能声称能抵御密码同时泄露。

成功产生最长 2 分钟、一次性授权，绑定 userId/sessionId/securityVersion/action/targetSessionId 或冻结目标集合。登录、设备撤销、敏感正文解锁的授权用途互不复用。退出当前设备不要求再次验证，仍要求 CSRF；踢出其他、其他全部、全部均要求对应授权。

日志详情查看、密码修改、因素变更、管理员操作分别绑定具体 action。管理员使用独立权限路径和自身第二因素，不借用目标用户的 Cookie。事务内重新校验 actor/target 所有权；跨用户资源返回 404，普通角色访问管理接口返回 403。

## 7. 实际验证与剩余工作

本任务使用 `node --test app/test/security-primitives.test.js`，包含真实 Argon2id、六组 RFC6238 SHA1 向量、TOTP 输入边界、随机 token/恢复码、GCM 用户/用途/keyId/密文篡改与错误密钥拒绝。最终执行结果由任务交接报告提供。

尚未交付 HTTP 限流、Argon2 工作队列、CSRF、session 生命周期、仓储防重放、因素恢复与前端界面。64 MiB 是每次 Argon2 操作内存，必须由上层限制并发；不可将同步数据库事务跨 await 保持。JavaScript 字符串、原生 Argon2/GCM 内存不保证可靠擦除；只清理本模块持有的临时密码/TOTP Buffer。固定策略会拒绝旧短密码和其他 Argon2 参数，迁移必须显式要求用户更改密码或另定兼容策略。未完成目标容器与 CPU 构建验证，不能以本机通过代替生产验收。
