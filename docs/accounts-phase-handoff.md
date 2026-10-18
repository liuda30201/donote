# 账户阶段实施与验收交接

更新：2026-10-17，Asia/Shanghai。完整实施计划仍在执行，本文不表示可发布或已完成数据保护后续阶段。

## 已实现

- SQLite 安全仓储、Argon2id、Cookie Session、Origin/CSRF、TOTP 挑战及受限初始化/恢复。
- 操作再次验证、一次性冻结目标授权、设备撤销、安全记录、改密与因素管理。
- 管理员后端及界面：列表、创建、启停、角色与重置密码；最后管理员保护。
- 前端账户 epoch、弹窗 generation、退出清理及 Socket 失效；TOTP 自撤销响应的恢复码一次交付。
- 离线真实迁移及 durable journal 恢复；来源保留、备份来源摘要绑定、提交凭据审计。
- SQLite backup API 一致快照、外置密钥及 keyId 校验、停写库存比较、恢复暂存校验与失败回滚。恢复撤销旧会话/挑战/授权/恢复码并递增安全版本，保留已启用 TOTP。
- 独立 accounts Compose 与 Nginx 认证路由放行、安全头片段。
- 关闭生命周期：停止新HTTP/Socket、追踪断开客户端后的安全/文件操作，等待active cleanup和pending persist后关闭SQLite/清零密钥。失败/25秒超时非零退出，两个Compose提供35秒停止宽限。启动期信号与失败路径也执行有界关闭。

## 验证证据

- `cd app && npm run check`：61 个 JavaScript 文件语法通过。
- `cd app && npm test`：83/83 通过，含真实 SQLite、Argon2、HTTP、Socket、迁移 SIGKILL 子进程恢复、敏感文本预研原语及真实 server SIGTERM/启动失败 fixture。
- `node --test app/test/security/socket-session.test.js`：4/4；其中覆盖 Chrome polling 无 Origin 的受限同源回退和负向边界。
- 关闭排空专项：存储/cleanup 5 项，HTTP lifecycle 4 项，安全路由 abort 追踪 1 项；包含真实隔离文件写入、IO中再次变更、失败dirty保留、停止等待活动清理和HTTP abort后的service promise。
- `python3 app/test/verifier-review/sqlite_backup_accounts.py`：3/3。
- `python3 app/test/verifier-review/sqlite_backup_fix.py`：8/8。
- `git diff --check`、`./scripts/check.sh` 通过。
- 隔离真实 Chrome CDP：初始化、TOTP 登录、管理员列表（无Origin GET）、设备会话、安全历史和退出全部通过，浏览器异常数0。修复了真实同源 polling GET 不带 Origin 导致登录后立刻被 Socket 登出的P1；只接受同源 Fetch Metadata + 精确允许 Referer 的受限 polling GET，11项负向组合拒绝。双标签页进一步验证 Cookie 恢复、reload、pageshow 重新验证、BroadcastChannel 退出同步、私有状态清理和 Socket 断开，浏览器异常数0；pageshow 为 CDP 事件派发，未声称真实 BFCache 往返。详见[验收报告](container-acceptance.md)。
- 隔离真实 Nginx TLS 代理：缓存 `nginx:1.27-alpine` 通过 `nginx -t`、临时 CA 证书校验、匿名 401/no-store、安全头、`__Host-dn_session` Cookie、认证 API、Engine.IO polling 和退出后撤销 Cookie 拒绝；上游为主机合成 Node 应用，不等于最终 app 镜像。详见[代理报告](proxy-acceptance.md)。
- 独立 VM 复验：旧响应隔离、冻结管理员字段、因素验证错误保留会话、实际会话失效退出、Socket 先于 HTTP 时恢复码交付及取消/新登录拒绝交付。
- 隔离 Docker 桩恢复演练：healthy 成功替换并撤销旧会话；unhealthy 恢复原目录、健康重启并保留失败现场。该结果不等于真实 Docker/Nginx 验收。
- accounts Compose 不提供 legacy 密码即可独立解析，密钥只读挂载且禁止自动创建宿主路径。

## 部署边界

accounts 使用独立 `docker-compose.accounts.yml`，不要与 legacy base 合并。配置 `AUTH_ORIGIN`、`AUTH_KEY_HOST_FILE`、`AUTH_KEY_ID`；密钥须为数据目录外的私有 0600 单链接普通文件，原始 32 字节。不得启动时自动替换密钥。

恢复操作需要同一 keyId 和密钥。迁移与备份的显式离线确认不能替代停止全部应用及外部写入者。恢复后必须重新登录，旧恢复码失效，已启用 TOTP 保留。

默认 legacy 部署保留；未进行提交、部署或真实数据迁移。现有用户样式及品牌改动保留，本阶段前端新增功能没有修改 CSS。

## 尚未验收/实施

- 目标 Docker 原生依赖构建及真实容器恢复演练；`node:24-bookworm-slim` registry HEAD两次EOF，未构建目标 app 镜像，不能将主机应用加缓存 Nginx 的结果视为目标镜像验收。
- 生产部署/外部 HTTPS、真实 Chrome 经 TLS 代理的 TOTP 与完整 Socket.IO upgrade、真实 BFCache 往返及 OS 前后台恢复尚未验收。
- G01 发布候选门槛尚未满足。
- E01/E02 敏感文本加密与短期解锁、Q01 配额/上传清理、V04/G02 尚未实施。

下一阶段先补账户发布候选验收，再按依赖推进加密与配额，不将当前状态称为完整计划完成。
