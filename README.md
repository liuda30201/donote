# DoNote

DoNote 是一个可自托管的跨设备网页剪贴板，用于在设备之间同步文本、截图、图片和文件。项目基于 [aiChenK/web-clipboard](https://github.com/aiChenK/web-clipboard) v1.6.8 演进，提供本地开发、传统密码访问和 accounts 多账户部署路径。

**示例站点：** [https://donote.cc](https://donote.cc)

默认开发入口为 `http://127.0.0.1:3000`，面向 MacBook M1 与 OrbStack。开发环境只运行应用容器，不需要域名、SSL 证书或 Nginx，并将数据写入独立的 `.dev-data/`。生产环境通过 Nginx HTTPS 反向代理，持久化数据保存在 `data/`。

## 功能

- 在设备之间实时同步文本、代码片段、截图、图片和文件。
- 支持搜索、收藏、历史分页、文件下载和受限内容预览。
- 原生前端，无需前端构建步骤；Socket.IO 用于实时同步。
- 离线缓存、深浅色模式、响应式瀑布流卡片和卡片密度控制。
- 两种访问模式：传统单密码模式，以及 SQLite 驱动的 accounts 多账户模式。
- Accounts 模式支持邮箱验证码自主注册：公开注册仅需邮箱、密码和验证码，完成后使用邮箱登录；登录和恢复仍兼容邮箱或旧用户名。新账号默认仅密码登录，可在安全设置中启用邮箱验证码或 TOTP。密码至少 8 位，需包含大写、小写、数字和 ASCII 标点，且不能包含邮箱前缀；邮箱前缀支持 1–64 个字符（包括 `+`）的有效语法。
- 支持管理员、设备会话、敏感文本保护、配额和审计；管理员及 strict 策略仍强制 TOTP。
- “文件”分类入口暂时隐藏，已有文件和文件接口保留，不删除数据。
- 包含数据备份/恢复、账户初始化/迁移和证书管理脚本。

## 文档入口

| 目标 | 文档 |
| --- | --- |
| 修改代码、理解模块、检查和测试 | [开发说明](docs/development.md) |
| 传统单密码部署、启停、备份恢复、证书和排障 | [部署与运维](docs/operations.md) |
| 初始化 accounts 管理员或迁移既有数据 | [账户初始化与迁移](docs/account-migration.md) |
| 配置 accounts 模式的邮件验证码 | [邮件验证码](docs/email-verification.md) |
| accounts 数据与安全边界 | [多用户数据保护设计](docs/donote-multiuser-data-protection.md) |
| 项目演进计划 | [功能规划](docs/feature-planning.md) |
| 隐私区域（v2 预留设计） | [隐私区域设计方案](docs/private-zone-design.md) |
| 备注与分类系统重设计（v2 预留） | [备注与分类设计方案](docs/remark-title-redesign.md) |
| 本地改动与上游资料的关系 | [上游来源](docs/upstream/README.local.md) |
| 隔离环境中的发布验收记录 | [发布验证](docs/final-release-validation.md) |

## 项目结构

```text
web-clipboard/
├── app/                        # 应用源码与 Docker 构建上下文
│   ├── public/                 # 原生 HTML/CSS/JS 前端资源
│   ├── scripts/                # accounts 初始化、迁移和密钥轮换工具
│   ├── src/                    # Express、存储、认证、路由与实时通信
│   ├── test/                   # Node 接口、安全和存储回归测试
│   ├── Dockerfile
│   └── package.json
├── docs/                       # 开发、运维、安全与验收文档
├── nginx/                      # HTTPS 反向代理、安全响应头和 ACME 目录
├── scripts/                    # 检查、备份、恢复和证书脚本
├── docker-compose.dev.yml      # 本机 HTTP 开发
├── docker-compose.yml          # 传统单密码 HTTPS 部署
├── docker-compose.accounts.yml # accounts HTTPS 部署
├── .env.example                # 开发及可选 SMTP 配置模板
├── .dev-data/                  # 本地开发数据，忽略提交
├── data/                       # 部署数据，忽略提交
└── backup/                     # 备份归档，忽略提交
```

## 本机开发

前提是 OrbStack 的 Docker 引擎正在运行。在仓库根目录执行：

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，设置仅用于开发的 ACCESS_PASSWORD
# 可选：设置 DEV_PORT=3001 避开已有服务

docker compose -f docker-compose.dev.yml up -d --build
open http://127.0.0.1:3000
docker compose -f docker-compose.dev.yml logs -f app
```

开发容器仅绑定到 `127.0.0.1`，不会暴露至局域网。停止服务但保留数据：

```bash
docker compose -f docker-compose.dev.yml down
```

默认开发数据目录为 `.dev-data/`，与生产 `data/` 隔离。确认容器已停止后，才可手动删除 `.dev-data/` 重置开发环境。也可直接使用本机 Node：

```bash
npm ci --prefix app
STORAGE_ROOT="$PWD/.dev-data" ACCESS_PASSWORD=development-only PORT=3000 npm --prefix app start
```

直接运行 Node 不会自动加载根目录 `.env`，请显式传入所需环境变量。

## 部署模式

### 传统单密码模式

`docker-compose.yml` 运行应用与 Nginx。部署需要域名、证书和根目录 `.env` 中的 `ACCESS_PASSWORD`：

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，设置强随机 ACCESS_PASSWORD
./scripts/self-signed-cert.sh  # 首次内网或自签部署

docker compose up -d --build
docker compose ps
```

正式 HTTPS 证书、域名替换、备份恢复和日常运维请参阅[部署与运维](docs/operations.md)。不要将 `.env`、证书私钥、真实数据或备份提交到 Git。

### Accounts 多账户模式

`docker-compose.accounts.yml` 是独立部署配置，不能与传统 Compose 合并。它要求：

1. 使用精确的 HTTPS `AUTH_ORIGIN`。
2. 在仓库外部准备权限为 `0600` 的原始 32 字节认证密钥和内容密钥环 JSON。
3. 通过 `AUTH_KEY_HOST_FILE` 和 `SENSITIVE_KEYRING_HOST_FILE` 指向上述绝对路径。
4. 先在离线状态初始化管理员，并在合成数据目录完成迁移演练。

典型启动命令：

```bash
node app/scripts/accounts.js init-admin \
  --data-dir /absolute/private/data --offline-confirmed \
  < /private/initial-account.json

docker compose -f docker-compose.accounts.yml up -d --build
```

账户初始化会拒绝弱密码和重复初始化；迁移前必须停写，并先执行 dry-run。完整流程、恢复协议和限制见[账户初始化与迁移](docs/account-migration.md)。SMTP 参数仅在需要邮箱验证码时配置，详见[邮件验证码](docs/email-verification.md)。

## 检查与测试

```bash
./scripts/check.sh
npm --prefix app run check
npm --prefix app test
```

`npm --prefix app test` 需要先完成 `npm ci --prefix app`。测试使用临时目录，不读取 `.env` 或 `data/`。浏览器图片预览回归和容器验收命令见[开发说明](docs/development.md)与[发布验证](docs/final-release-validation.md)。

## 安全边界

- 根目录 `.env`、密钥、SMTP 密码、证书私钥、用户数据与备份均由 `.gitignore` 排除，不能提交。
- 传统模式的认证 Cookie 依赖 HTTPS 传输安全；部署时必须配置可信证书。
- Accounts 模式的认证密钥和内容密钥环不保存在仓库或 `data/` 下，丢失前应按密钥备份流程保护。
- 生产操作前先备份；数据格式变更、账户迁移和恢复均应先在隔离副本演练。

本项目保留上游 MIT 许可证，详见 [LICENSE](LICENSE)。上游关于公开分享或免密码部署的说明不代表本项目的默认部署行为。
