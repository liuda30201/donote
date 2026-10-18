# S01 Auth 安全只读复核

复核范围：`auth-service`、认证路由、中间件及其 HTTP 安全测试。未修改产品代码。

## 结论

现有 HTTP session/Cookie/CSRF/TOTP 基础测试通过。初审发现的异步认证竞态和 MFA 共享限流桶已由 auth-security 修复，并通过本次只读复测；仍有集成接线项需由 Lead 在整合阶段确认，真实生产 app 尚不能仅凭本单元测试宣称已完全切断旧认证旁路。

## 初审阻塞项：TOTP challenge 的异步安全版本竞态（已修复）

初审时，`login()` 在 `await passwordWork()` 后直接创建 TOTP challenge，缺少 freshness 检查。该问题已由 auth-security 修复：密码验证完成后重新读取用户，并比较 `security_version`、`password_hash`、禁用和删除状态；challenge 分支与直接 session 分支现在都经过该检查。

独立受控实验（不修改产品代码）曾复现旧实现，修复后同一竞态应拒绝创建 challenge；当前回归测试由 auth-security 维护。

```bash
node <<'JS'
const p = require('./app/src/security/primitives');
const {createAuthService} = require('./app/src/security/auth-service');
let release; const gate = new Promise(resolve => release = resolve);
p.verifyPassword = async () => { await gate; return true; };
let current = {id:'user', username:'alice', password_hash:'old', security_version:1, role:'user'};
let created;
const repo = {
  findUserByUsername: () => ({...current}), findUserById: () => ({...current}),
  getTotpCredential: () => ({enabled_at:1}),
  createLoginChallenge: args => { created = {...args, security_version:current.security_version}; return created; },
  addAudit: () => {}
};
const service = createAuthService({repo, allowedOrigins:['https://example.test'], encryptionKey:Buffer.alloc(32), keyId:'test'});
const pending = service.login({headers:{origin:'https://example.test'}, body:{username:'alice',password:'old-password-long'}, ip:'127.0.0.1'});
current = {...current, password_hash:'new', security_version:2}; release();
pending.then(result => console.log(JSON.stringify({requiresSecondFactor:result.requiresSecondFactor, challengeSecurityVersion:created.security_version, passwordChangedDuringVerification:true})));
JS
```

旧实现输出表明 challenge 仍被创建，且绑定 `security_version: 2`。当前实现已在 challenge 创建前重新读取并比较 freshness；该问题状态为已修复。

## 初审风险项：二次验证限流键过于共享（已修复）

初审时，`completeLogin()` 使用固定 `second-factor` 键，所有用户共享每分钟 10 次的桶。当前实现先解析 challenge，再使用 `factor:<user_id>`；无效 challenge 使用 `invalid:<source(req)>`，避免攻击者用一个固定无效值直接耗尽所有账户的用户桶。

旧实现的独立复现命令如下；修复前第 11 次会返回 `AUTH_RATE_LIMIT`，证明所有账户共享固定桶。当前实现已改为解析 challenge 后使用 `factor:<user_id>`，无效输入使用来源绑定的 `invalid:<source(req)>`；本命令仅用于记录初审现象，不能代表当前实现仍有该缺陷。

```bash
node <<'JS'
const {createAuthService}=require('./app/src/security/auth-service');
const s=createAuthService({repo:{},allowedOrigins:['https://example.test'],encryptionKey:Buffer.alloc(32),keyId:'test'});
for (let n=0;n<11;n++) { try { s.completeLogin({headers:{origin:'https://example.test'},body:{},ip:'192.0.2.'+n}); } catch(e) { console.log(n,e.code); } }
JS
```

## 已通过检查

- Cookie 默认名为 `__Host-dn_session`，并设置 `HttpOnly; Secure; SameSite=Lax; Path=/`；非生产开发配置禁止 `__Host-` 名称。
- Cookie token 必须符合 opaque token 格式，重复 Cookie 名称会拒绝。
- 非 GET/HEAD/OPTIONS 请求同时要求 exact Origin 和 `X-CSRF-Token`；CSRF token 由 session token HMAC 派生，并与数据库 hash 对照。
- 登录 challenge 具备短时效、单次消费、失败次数上限、security version 绑定；TOTP counter 在事务中单调更新。
- `createAuthRouter` 的旧 `POST /api/auth` 返回 `410 LEGACY_AUTH_DISABLED`。
- 错误响应对未知错误统一为 `INTERNAL_ERROR`/`Request failed`，不会直接泄露堆栈；认证失败使用通用代码。
- 现有测试通过：

```bash
node --test app/test/security/http-auth.test.js
# 1 test passed
```

## 集成接线待确认

只读代码显示 legacy 路由和旁路仍存在于仓库中：`routes/auth.js` 仍导出旧 `router`，`middleware/auth.js` 在 app 未设置 `authService` 时接受密码、query、`wc_auth` 和 `X-Access-Password`，文件服务仍有 `requireAuthOrCookie`，Socket handshake 也读取旧 password。当前 HTTP 测试直接挂载 `createAuthRouter`，不能证明生产 `createApp()` 已设置 `authService` 并让所有受保护路由只走 session middleware。

这不是在本次只读审查中修改的内容。Lead 应在整合测试中确认：生产 app 的 authService 注入、所有 API/文件/Socket 入口均拒绝旧凭据；否则属于旧认证旁路阻塞项。
