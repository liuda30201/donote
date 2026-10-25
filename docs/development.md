# 开发说明

## 应用结构

应用使用 CommonJS、Express 5、Socket.IO 和原生前端，没有前端编译步骤。

| 路径 | 职责 |
| --- | --- |
| `app/server.js` | 初始化数据、检查运行模式、启动清理任务与 HTTP 服务 |
| `app/src/app.js` | 创建 Express / HTTP / Socket.IO 实例 |
| `app/src/config.js` | 环境变量和应用常量 |
| `app/src/storage.js` | 状态、持久化、分页与搜索 |
| `app/src/message.js` | 消息格式转换、图片与文件内容落盘 |
| `app/src/upload.js` | Multer 配置、上传路径解析与附件删除 |
| `app/src/cleanup.js` | 过期消息和孤儿附件清理 |
| `app/src/socket.js` | 实时鉴权、同步和广播 |
| `app/src/middleware/` | 认证与限流 |
| `app/src/routes/index.js` | 注册路由、JSON 解析、静态资源和 JSON 404 |
| `app/src/routes/auth.js` | 登录、认证状态与版本 |
| `app/src/routes/messages.js` | 消息增删改、搜索、清空与代理认证校验 |
| `app/src/routes/files.js` | 上传、流式下载、原图、文本预览；仍挂在 `/api/messages` |
| `app/src/routes/favorites.js` | 收藏操作 |
| `app/public/app.js` | 当前单页前端：登录、消息、搜索、上传、预览和交互 |

`share.js`、分享路由与分享页面来自上游；本地不注册分享 API，Nginx 阻止分享页面。后端仍使用分享模块清理旧数据，暂保留这些文件以兼容已有数据。

Dockerfile 使用 Node.js 24。无需在宿主机安装容器内的原生依赖；Docker Engine 需处于运行状态。

### Docker 容器开发

在仓库根目录执行：

```bash
cp .env.example .env
chmod 600 .env
# 编辑 .env，设置开发专用 ACCESS_PASSWORD

docker compose -f docker-compose.dev.yml up -d --build
# 在浏览器中访问 http://127.0.0.1:3000
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml logs -f app
```

开发 Compose 只启动 app，不启动 Nginx，不要求域名或证书。端口仅绑定到宿主机 loopback。数据使用 `.dev-data/`，与生产 `data/` 隔离；如需换数据目录，可设置 `DEV_DATA_DIR`，端口可用 `DEV_PORT` 修改。结束后运行：

```bash
docker compose -f docker-compose.dev.yml down
```

容器会按 SIGTERM 优雅关闭，开发数据默认保留。切勿把生产数据目录指定给 `DEV_DATA_DIR`。

### 宿主机 Node 开发

也可不使用容器，直接在宿主机安装 Node.js 24：

```bash
npm ci --prefix app
STORAGE_ROOT="$PWD/.dev-data" ACCESS_PASSWORD=development-only PORT=3000 npm --prefix app start
```

访问 `http://127.0.0.1:3000`。应用直接读取进程环境变量，不会自动加载根目录 `.env`；`.env` 只由 Compose 加载。直接运行时请显式设置数据目录和开发密码。

### Accounts 模式

日常前端和 legacy 单用户接口开发优先使用以上开发 Compose。若专门验证 accounts 模式，需要独立临时数据目录、外置 0600 AUTH key 和 content keyring，并显式设置 `AUTH_DEV_HTTP=1` 与精确 loopback `AUTH_ORIGIN`（例如 `http://127.0.0.1:3000`）。不要复用生产密钥或数据库；accounts 部署 Compose 与开发 Compose 分开，不要合并配置。

## 检查与测试

```bash
./scripts/check.sh          # Shell、JSON、依赖元数据和两个 Compose 配置；有 Node 时也检查 JS
npm --prefix app run check  # JavaScript 语法检查，无第三方依赖
npm --prefix app test       # 需要先 npm ci --prefix app
```

接口测试启动随机端口，并创建和删除系统临时数据目录。覆盖登录、消息创建与搜索、备注、收藏、清空、上传、Cookie 下载、Range、预览限制、禁用接口、删除和多用户文件隔离，不读取 `.env` 或 `data/`。

宿主机没有 Node.js 时，可复用已构建的开发镜像中的 Node 和依赖：

```bash
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/workspace,readonly" \
  -e NODE_PATH=/app/node_modules --entrypoint sh \
  web-clipboard-local:dev \
  -c 'node /workspace/scripts/check-js.js && node --test /workspace/app/test/*.test.js'
```

该方式使用镜像内依赖，不能替代依赖发生变化后的 `npm ci` 验证。根目录 GitHub Actions 会安装锁文件依赖并执行检查和测试；上游发布工作流已作为参考资料移到 `docs/upstream/`。

图片预览的真实浏览器回归位于 `app/test-browser/image-preview.js`，需要 Playwright 和 Chromium；设置 `CHROMIUM_PATH` 可指定浏览器路径。执行 `node app/test-browser/image-preview.js` 会创建临时图片和测试服务，验证整页初始化、点击图片与预览按钮、原图、键盘、关闭、收藏和刷新后的预览，不访问生产数据。

## 常见修改

- **前端资源**：修改 `app/public/`，同时更新 `service-worker.js` 的 `CACHE_NAME` 和 `index.html` 的资源 `?v=`，使浏览器加载新资源。
- **文件预览**：服务端白名单在 `app/src/utils.js`，前端白名单在 `app/public/app.js`；主动内容否决优先于白名单。预览上限由 `MAX_PREVIEW_BYTES` 控制。
- **上传大小**：同步修改 `app/src/upload.js` 的 Multer 限制、`app/src/routes/index.js` 的 JSON 限制和 `nginx/conf.d/20-clipboard.conf` 的请求体限制。
- **数据格式**：修改存储前先设计兼容读取和回滚方案；升级前备份，测试使用临时目录。
- **镜像**：Compose 的 `app.image` 是运维脚本的镜像来源；`IMAGE=...` 可临时覆盖，不在脚本里重复硬编码版本。

`package.json` 的版本表示上游应用版本，Compose 镜像 tag 表示本地补丁版本，前端缓存号独立控制浏览器资源更新。历史镜像 ID 只作为记录，不能用于判断当前运行版本。

## 本次整理

源码从 `build/` 移至 `app/`，Docker 构建上下文同步更新。上游 README、更新日志和发布工作流归档到 `docs/upstream/`，MIT 许可保留在根目录。文件路由从消息路由拆出，API 路径和处理逻辑保留；四个运维脚本共用路径和日志，备份/恢复共用镜像解析。

持久化数据、凭据、Nginx 配置挂载位置、脚本入口和容器名称保留。前端目前仍集中在 `app.js`，进一步拆分需要单独的浏览器交互回归，未在此次目录整理中实施。

## 待维护事项

- 前端 `app/public/app.js` 仍为较大的单文件，后续可按认证、上传、搜索和预览职责拆分，并补浏览器交互测试。
- 保留的上游分享模块有旧数据清理依赖，删除前需确认数据迁移策略。
- 本次镜像构建的 npm 在线审计报告原有依赖包含 10 个已知漏洞（1 low、2 moderate、6 high、1 critical）。整理没有改变依赖范围或锁定版本；需另行分析可达性、升级兼容性并复测。离线安装不具备完整漏洞审计能力。
