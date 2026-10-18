# Web Clipboard 项目分析

> 分析时间：2026-10-15
>
> 本文记录当前项目的结构、运行方式、主要业务链路、部署边界和基线验证结果。

## 1. 项目定位

这是一个私有的跨设备网页剪贴板应用，用于在不同设备之间传递文本、代码片段、截图、图片和文件。项目基于上游 `aiChenK/web-clipboard` v1.6.8，并在本地增加了认证、文件访问控制、历史搜索、缓存、卡片布局和工作台界面等修改。

当前默认部署入口为 `https://node.7705.work`，浏览器通过 Nginx 的 HTTPS 入口访问应用；Node/Express 应用监听容器内部的 3000 端口，消息和附件持久化到宿主机 `data/` 目录。

## 2. 技术栈与运行模式

- 后端：Node.js、CommonJS、Express 5
- 实时通信：Socket.IO 4
- 文件上传：Multer
- 前端：原生 HTML、CSS、JavaScript
- 前端构建：无构建步骤，静态文件由 Express 直接提供
- 部署：Docker Compose
- 反向代理：Nginx，负责 TLS、外部入口和部分认证防护
- 数据存储：JSON 文件和上传目录，没有独立数据库
- 测试：Node.js 内置 `node:test`，另有浏览器回归脚本

应用支持两种认证/数据模式：

1. **单用户模式**：使用 `ACCESS_PASSWORD`，数据默认写入 `data/messages.json`。
2. **多用户模式**：使用 `ACCESS_PASSWORDS=userId:password,...`，每个用户的数据写入 `data/users/<userId>/`，Socket.IO 广播按用户房间隔离。

## 3. 项目结构

```text
web-clipboard/
├── app/
│   ├── server.js                 # 服务启动、数据加载、清理任务
│   ├── package.json              # Node 依赖和脚本
│   ├── Dockerfile                # Node 18 Alpine 镜像构建
│   ├── src/
│   │   ├── app.js                # Express、HTTP、Socket.IO 实例
│   │   ├── config.js             # 环境变量、认证模式和常量
│   │   ├── storage.js            # 内存状态、持久化、分页和搜索
│   │   ├── message.js            # 消息格式转换和内容落盘
│   │   ├── upload.js             # Multer、上传路径和附件清理
│   │   ├── cleanup.js            # 过期消息和孤儿附件清理
│   │   ├── socket.js             # Socket.IO 鉴权、同步和广播
│   │   ├── share.js              # 上游分享兼容模块和旧数据清理
│   │   ├── utils.js              # 路径、文件名、内容类型等工具
│   │   ├── middleware/
│   │   │   ├── auth.js           # 请求凭据解析和访问鉴权
│   │   │   └── rateLimit.js      # 登录和 API 限流
│   │   └── routes/
│   │       ├── index.js          # 静态资源、JSON 解析和路由注册
│   │       ├── auth.js           # 登录、认证状态和版本接口
│   │       ├── messages.js       # 消息增删改、搜索、清空
│   │       ├── files.js          # 上传、图片、预览和文件下载
│   │       ├── favorites.js      # 收藏和取消收藏
│   │       └── share.js          # 上游分享路由，当前不注册
│   ├── public/
│   │   ├── index.html            # 单页应用 HTML
│   │   ├── app.js                # 前端主要逻辑
│   │   ├── style.css             # 页面样式和主题
│   │   ├── service-worker.js     # 静态资源缓存和离线回退
│   │   ├── highlight.js          # 代码高亮
│   │   ├── heic2any.min.js       # HEIC 图片转换
│   │   └── logo.png/favicon.svg  # 品牌图标
│   └── test/
│       ├── routes.test.js        # 消息、文件、认证和安全回归测试
│       └── multi-user.test.js    # 多用户文件隔离测试
├── docs/                         # 开发、运维和项目资料
├── nginx/conf.d/                 # Nginx 反向代理配置
├── scripts/                      # 检查、备份、恢复和证书脚本
├── docker-compose.yml            # app + nginx 编排
└── .env.example                  # 环境变量模板
```

## 4. 服务启动链路

启动入口是 `app/server.js`，主要步骤如下：

1. 从 `config.js` 读取端口、认证配置、数据目录、过期时间和用户映射。
2. 创建并检查 `STORAGE_ROOT`。
3. 检查单用户/多用户运行模式是否发生变化；如果变化，则清理旧分享数据。
4. 多用户模式下按用户加载持久化消息；必要时将旧的单用户数据迁移到指定用户。
5. 启动时清理过期消息、关联附件和孤儿文件。
6. 启动定时清理任务。
7. 通过 `createApp()` 创建 Express、HTTP 和 Socket.IO 实例。
8. 监听 `PORT`，Compose 中默认是容器内部的 3000 端口。

应用本身不自动读取根目录 `.env`。生产环境由 Docker Compose 负责注入环境变量；本地运行时应显式设置环境变量。

## 5. HTTP 请求与认证链路

生产请求路径如下：

```text
浏览器
  │ HTTPS
  ▼
Nginx :443
  │
  ├── 静态页面和公开资源 → app:3000
  ├── /api/auth/status → 公开转发
  ├── /api/auth → 登录接口
  ├── /api/* → auth_request /__auth 后转发
  ├── /socket.io/* → auth_request 后转发
  └── 文件流接口 → auth_request 后转发
       │
       ▼
Express 应用
  └── requireAuth / requireAuthOrCookie 二次校验
```

认证凭据可能来自：

- `X-Access-Password` 请求头
- 请求体 `password`
- 查询参数 `password`
- `wc_auth` Cookie

Cookie 中保存的是访问密码的 Base64 表示，不是加密凭据，传输安全依赖 HTTPS。应用层仍会再次验证密码，并在多用户模式下将密码绑定到对应的 `userId`。

Nginx 还通过 `/__auth` 内部子请求调用应用的 `/api/messages/auth-verify`。该校验端点只接受来自本机或私有容器网络的请求，避免被外部直接调用。

## 6. 主要 API

### 认证

- `POST /api/auth`：验证访问密码并返回认证结果。
- `GET /api/auth/status`：返回当前模式以及是否需要密码。
- `GET /api/version`：返回应用版本和运行模式。
- `GET /api/messages/auth-verify`：供 Nginx `auth_request` 使用的内部认证端点。

### 消息

- `GET /api/messages`：分页获取消息，支持 `before` 和 `limit`。
- `GET /api/messages/search`：按关键词、类型和时间范围搜索。
- `POST /api/messages`：创建文本、图片或文件消息。
- `DELETE /api/messages/:id`：删除消息及其附件。
- `POST /api/messages/clear`：清空非收藏消息。
- `PATCH/POST /api/messages/:id/remark`：修改备注。

### 收藏

- `GET /api/favorites`：获取收藏列表（`GET /api/messages` 由消息列表路由优先处理）。
- `POST /api/messages/:id/favorite`：收藏消息。
- `DELETE /api/messages/:id/favorite`：取消收藏。
- 兼容路径 `/api/favorites` 仍然注册。

### 文件

- `POST /api/messages/upload`：使用 `multipart/form-data` 上传图片或文件。
- `GET /api/messages/:id/image-file`：认证后流式读取缩略图或原图。
- `GET /api/messages/:id/file-stream`：认证后流式下载文件，支持 Range；白名单文本可通过 `inline=1` 预览。
- `GET /api/messages/:id/image-original`：兼容旧逻辑，以 Data URL 返回原图。
- `GET /api/messages/:id/file-download`：兼容旧逻辑的文件下载接口。

公开分享接口当前由应用和 Nginx 同时禁用，相关路径固定返回 404。分享模块文件仍保留，主要用于历史数据清理和兼容已有数据。

## 7. 数据和附件处理

### 消息状态

`storage.js` 在内存中维护消息状态：

- 单用户模式使用全局状态。
- 多用户模式使用 `userId -> state` 映射。
- 消息写入采用临时文件后重命名的方式，避免直接覆盖造成半写入。
- 持久化任务按用户放入待写集合，失败后会重新加入队列。
- 损坏的 JSON 文件会先改名为 `.corrupt-<timestamp>` 备份，然后以空状态启动，避免启动时直接覆盖原始损坏文件。

### 附件

附件实际写入用户上传目录：

```text
单用户：data/uploads/<category>/<yyyy-mm-dd>/...
多用户：data/users/<userId>/uploads/<category>/<yyyy-mm-dd>/...
```

上传文件不通过静态目录直接暴露。应用会：

- 校验并规范化文件名。
- 检查上传路径不能逃逸出用户上传根目录。
- 使用认证流式接口读取图片和文件。
- 对 HTML、SVG、JavaScript、XML、PHP 等主动内容强制以附件下载。
- 对 JSON、纯文本、Markdown 等白名单类型提供受限内联预览。
- 默认限制文本预览文件大小为 2 MiB。
- 删除消息时同步删除关联附件。
- 定期清理没有消息引用的孤儿附件。

上传大小限制需要同时保持以下三处一致：

- Multer 的 100 MiB 限制。
- Express JSON 请求的 100 MB 限制。
- Nginx 的 101 MiB `client_max_body_size`。

## 8. Socket.IO 实时同步

`socket.js` 在建立连接时校验 Socket 握手中的密码和用户 ID：

- 单用户模式下所有已认证连接共享同一广播范围。
- 多用户模式下 Socket 被绑定到认证得到的用户 ID。
- 客户端只能加入与自身认证用户一致的房间。
- 初次连接会收到最近一页消息的 `sync` 事件。
- 新消息、删除、清空、收藏和备注变化分别通过事件广播：
  - `message-new`
  - `message-delete`
  - `messages-clear`
  - `message-favorite`
  - `message-remark`

前端在 Socket 事件之外仍使用 HTTP API 做初始加载、分页和搜索。

## 9. 前端能力

当前未提交的工作区改动主要集中在前端，内容包括：

- `donote` 品牌和新的 Logo。
- 登录页重新设计及 Anti-FOUC 首屏处理。
- 深色/浅色主题切换。
- 网格/列表布局切换。
- 时间线分组和卡片式工作台。
- 顶栏嵌入式搜索，支持 `/` 或 `Ctrl+K` 聚焦。
- 服务端搜索与本地搜索结果缓存。
- 卡片宽度/密度滑块，并保存到浏览器本地存储。
- SWR 风格的消息和收藏快照缓存，先显示本地快照，再后台同步。
- 全局粘贴处理，支持文本、截图和图片。
- 图片压缩、缩略图、原图预览和键盘关闭。
- 文件上传队列、上传进度和文本文件预览。
- Service Worker 网络优先加载静态资源，离线时回退到缓存。

前端当前仍集中在单个较大的 `app/public/app.js` 文件中，后续如果拆分，应同步补充浏览器交互回归测试。

## 10. 部署方式

### 本机开发（MacBook M1 + OrbStack）

日常开发测试不使用域名、SSL 或 Nginx。推荐运行 `docker-compose.dev.yml`，只启动 app 并将容器 `3000` 绑定到宿主机 `127.0.0.1`。开发数据使用 `.dev-data/`，与部署用的 `data/` 隔离。

```bash
docker compose -f docker-compose.dev.yml up -d --build
open http://127.0.0.1:3000
docker compose -f docker-compose.dev.yml down
```

### 生产/代理部署

```text
app
├── 内部监听 3000
├── 挂载 ./data:/app/data
└── 提供 Express + Socket.IO

nginx
├── 对外发布 80/443
├── 负责 TLS 和反向代理
├── 挂载 nginx/conf.d
└── 挂载证书和 ACME challenge 目录
```

应用端口只通过 Docker 内部网络暴露，外部入口为 Nginx。80 端口主要用于 ACME HTTP-01 验证和跳转 HTTPS；应用数据不通过明文 HTTP 承载。

常用命令：

```bash
# 本机开发：使用独立 .dev-data，不读取生产 data/
docker compose -f docker-compose.dev.yml up -d --build
open http://127.0.0.1:3000

# 生产/代理路径：需要域名、证书和 Nginx
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app nginx

# 检查 Nginx 配置
docker exec wcb-nginx nginx -t
```

## 11. 检查、测试和 CI

本地检查命令：

```bash
npm --prefix app run check
npm --prefix app test
./scripts/check.sh
```

GitHub Actions 在 Node.js 18 环境中执行：

1. `npm ci --prefix app`
2. `npm --prefix app run check`
3. `npm --prefix app test`
4. `bash scripts/check.sh`

接口测试使用系统临时目录，不读取生产 `.env` 或真实 `data/`。当前覆盖：

- 登录、认证状态和静态资源。
- 消息创建、搜索、备注、收藏和清空。
- 文件上传、Cookie 认证下载、Range 请求和文本预览。
- HTML 等主动内容的强制下载限制。
- 图片缩略图、原图和历史消息兼容。
- 禁用的 `/uploads/` 和分享入口。
- 消息删除。
- 多用户文件隔离。

浏览器级图片预览回归位于 `app/test-browser/image-preview.js`，需要 Playwright 和 Chromium。

## 12. 当前工作区状态

项目当前存在未提交改动，主要文件如下：

- `app/public/app.js`
- `app/public/favicon.svg`
- `app/public/index.html`
- `app/public/manifest.json`
- `app/public/service-worker.js`
- `app/public/style.css`
- `app/test/routes.test.js`
- 新增 `app/public/logo.png`

这些改动主要是前端视觉和交互重构，以及少量测试调整。本次分析过程中没有覆盖、回滚或修改这些已有变更。

最近提交：

- `c704cea refactor: 重构目录结构，build/ 拆分为 app/ 并补充文档与 CI`
- `4e37715 feat: 私有跨设备剪贴板（应用 + nginx TLS 反代 + 运维脚本）`

## 13. 基线验证结果

截至本次分析，以下命令全部通过：

```text
npm --prefix app run check
JavaScript 语法检查通过（27 个文件）

npm --prefix app test
6 个测试全部通过

./scripts/check.sh
Shell、JSON、依赖锁文件、Compose 和 JavaScript 检查全部通过
```

## 14. 后续维护重点

1. `app/public/app.js` 文件较大，后续可按认证、搜索、上传、预览和消息渲染职责拆分。
2. 前端 UI 改动需要同步更新 Service Worker 的 `CACHE_NAME` 和 HTML/CSS/JS 资源版本号。
3. 修改数据格式前应设计兼容读取、迁移和回滚方案，并先完成备份。
4. 文件预览白名单需要同时检查服务端 `utils.js` 和前端 `app.js`。
5. 上传大小变更需要同步修改 Multer、JSON 解析和 Nginx 请求体限制。
6. 分享模块虽然当前禁用，但仍有历史数据清理依赖，删除前应确认迁移策略。
7. 规划中的管理员、群组、定向共享和 TOTP 2FA 目前仍未实现，不能将规划文档当作现有功能说明。
8. 依赖存在历史安全审计问题，升级前应单独评估可达性、兼容性并重新测试。
