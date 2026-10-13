# web-clipboard —— 跨设备私有剪贴板

在 Debian 12 上以 Docker 部署的私有网页剪贴板，用于在 Windows / macOS 之间传递
文本、截图、图片与文件。

* **访问地址**：<https://xm.7705.work:8443>
* **入口**：nginx（容器 `wcb-nginx`）监听 8443，HTTPS + 登录保护
* **应用**：aiChenK/web-clipboard v1.6.8（容器 `wcb-app`，仅监听 Docker 内网 3000）
  + 本地补丁 p2（卡片式布局 / 历史搜索 / 窗口内文件预览 / 复制降级）
* **数据**：`./data/`（宿主机持久化，容器重建不丢）

```
浏览器 ──HTTPS:8443──▶ wcb-nginx ──HTTP──▶ wcb-app:3000 ──▶ ./data/
                        (auth_request)     (Docker 内网, 不对外暴露)
```

---

## 1. 目录结构

```
web-clipboard/
├── docker-compose.yml          # 编排：app + nginx 两个容器
├── .env                        # 真实访问密码（权限 600，已被 .gitignore 排除）
├── .env.example                # 环境变量模板，不含真实密码
├── .gitignore                  # 排除凭据、证书、数据、备份
├── credentials.txt             # 初始访问密码（权限 600）
├── .image-digest               # 实际使用的镜像与本地构建 ID 记录
├── build/                      # 应用源码 + 本地安全补丁（构建 app 镜像的上下文）
│   ├── Dockerfile
│   ├── src/                    # routes/messages.js, middleware/auth.js, utils.js, storage.js 等
│   └── public/                 # 前端静态资源（无构建步骤，直接 COPY 进镜像）
│       ├── app.js              # 卡片布局 / 搜索 / 文件查看器 / 复制
│       ├── highlight.js        # 零依赖语法高亮 + 安全 Markdown 渲染（本地自带，无 CDN）
│       ├── style.css
│       └── service-worker.js   # 离线缓存（改前端需同步 bump CACHE_NAME 与 ?v= 版本号）
├── nginx/
│   ├── conf.d/00-shared.conf   # map / log_format 等共享指令
│   ├── conf.d/20-clipboard.conf# 8443 server 块：登录校验、上传大小、WebSocket 超时
│   ├── certs/                  # 自签证书 fullchain.pem / privkey.pem（10 年，见第 7 节）
│   └── www/                    # 静态站点根（保留给 ACME 用）
├── scripts/
│   ├── deploy-certs.sh         # （可选）DNS-01 申请公共 CA 证书
│   ├── self-signed-cert.sh     # 生成 10 年自签证书（当前在用）
│   ├── backup.sh               # 备份消息记录 + 附件
│   └── restore.sh              # 恢复（自动先建回滚点）
├── data/                       # 运行时数据（容器内 /app/data）
│   ├── messages.json           # 消息记录（文本/图片/文件元数据）
│   └── uploads/                # 附件实体（原图、缩略图、上传文件）
└── backup/                     # 备份归档（权限 700）
```

---

## 2. 日常操作

所有命令都在项目目录下执行：

```bash
cd ~/workspace/web_fuzhi/web-clipboard
```

| 目的 | 命令 |
| --- | --- |
| 启动 | `docker compose up -d` |
| 停止（保留数据） | `docker compose stop` |
| 停止并删除容器（数据仍在 `./data`） | `docker compose down` |
| 查看状态 | `docker compose ps` |
| 查看应用日志 | `docker compose logs -f app` |
| 查看 nginx 日志（含访问日志） | `docker compose logs -f nginx` |
| 最近 100 行日志 | `docker compose logs --tail=100 app nginx` |
| 重启应用 | `docker compose restart app` |
| 健康检查 | `curl -sk https://xm.7705.work:8443/healthz` |
| 查看当前版本 | `curl -sk https://xm.7705.work:8443/api/version`（需登录） |

两个容器均为 `restart: unless-stopped`，宿主机重启后自动拉起。

### 界面功能（本地补丁 p2）

登录后消息以**响应式网格卡片**呈现（窄屏自动变单列）：

| 功能 | 位置 | 说明 |
| --- | --- | --- |
| 历史搜索 | 消息区顶部工具条 | 关键词匹配**文字内容 / 文件名 / 备注**；可叠加类型（文字/图片/文件）与时间（今天/7 天/30 天）筛选。输入 500 ms 后自动搜索，回车立即搜索，右侧「清除」恢复原消息流。 |
| 加载更早消息 | 工具条右侧按钮 | 网格布局下分页改为按钮触发；搜索态下该按钮改为加载更多搜索结果。 |
| 窗口内预览 | 文件卡片上的「打开」按钮 / 双击卡片正文 | 支持 JSON（自动格式化+高亮）、Markdown（渲染）、常见代码与纯文本。上限 2 MiB，超出提示改用下载。 |
| 复制 | 文本卡片「复制」、预览窗口「复制全文」 | 保留换行。`navigator.clipboard` 不可用时自动降级到 `execCommand`（自签证书环境下常见）。 |

> 「打开」按钮只出现在**预览白名单**内的文件上（`.json/.txt/.md/.csv/.yaml/.log` 等）。
> `.html/.svg/.xml/.js` 等主动内容**不会**出现该按钮，只能下载 —— 见第 9 节。

---

## 3. 访问密码

* 初始密码保存在 **`~/workspace/web_fuzhi/web-clipboard/credentials.txt`**（权限 600）。
  安全查看方式：

  ```bash
  cat ~/workspace/web_fuzhi/web-clipboard/credentials.txt
  ```

  请不要把它粘贴进聊天记录、工单、群聊或任何日志。
* 密码同时写入 `.env` 的 `ACCESS_PASSWORD=`（权限 600），两处内容一致。
* 修改密码：

  ```bash
  cd ~/workspace/web_fuzhi/web-clipboard
  NEW=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
  printf 'ACCESS_PASSWORD=%s\n' "$NEW" > .env && chmod 600 .env
  docker compose up -d --force-recreate app
  ```

  改完需要在浏览器里重新登录（旧 Cookie 立即失效）。
* **登录保护覆盖范围**：`/api/messages*`（列表、增删改）、附件下载与预览、
  `/socket.io/` 实时通道，全部由 nginx `auth_request` 子请求统一校验；
  未携带正确凭据一律 `401`。`/uploads/` 与分享相关路径直接 `404`
  （不提供公开分享入口）。

---

## 4. 数据与配置路径

| 内容 | 宿主机路径 | 容器内路径 |
| --- | --- | --- |
| 消息记录 | `./data/messages.json` | `/app/data/messages.json` |
| 附件实体 | `./data/uploads/` | `/app/data/uploads/` |
| 访问密码 | `./.env`（600） | 环境变量 `ACCESS_PASSWORD` |
| nginx 配置 | `./nginx/conf.d/` | `/etc/nginx/conf.d/`（只读挂载） |
| 证书 | `./nginx/certs/` | `/etc/nginx/certs/`（只读挂载） |
| 备份归档 | `./backup/`（700） | — |

> **运维提示**：`wcb-app` 容器以 root 运行，因此 `./data/` 下的文件在宿主机上
> 属主是 `root`，普通用户 `wt` 直接 `cat`/`rm` 会被拒绝。这是预期行为，
> 请统一通过 `scripts/backup.sh` / `scripts/restore.sh`（以容器 root 操作）
> 或 `docker exec wcb-app ...` 来读写数据，不要手工 `rm -rf data/`。

### 保留与自动清理

* `EXPIRE_HOURS=720`（**30 天**）：超过 30 天的消息到期由应用自动删除。
* `FILE_CLEANUP_INTERVAL_MINUTES=30`：孤儿附件（无消息引用的文件）每 30 分钟清扫一次。
* 启动日志中可见：`孤儿文件清理间隔: 30 分钟`；接口返回 `expireHours: 720`。
* 删除单条记录时，其关联附件会被一并清理。

### 上传大小限制（实测）

| 层 | 限制 |
| --- | --- |
| nginx `client_max_body_size` | `101m`（为 multipart 边界留出余量） |
| 应用 multer `limits.fileSize` | `100 * 1024 * 1024` = **100 MiB** |
| `express.json` / `urlencoded` | `100mb`（文本消息） |

**单文件上限 100 MiB**，经 HTTPS 入口实测：104 857 599 字节（100 MiB−1）✅ 200；
104 857 600 字节（恰好 100 MiB）❌ `400 {"error":"File too large"}`。
即实际可用上限为 **104 857 599 字节**。

这是**有意设定的上限**：本服务定位是跨设备传递文本、截图和文档，
不是网盘，无需要求更大的单文件。若将来确实需要放宽，要同时改三处并重新构建镜像：
`build/src/upload.js` 的 `limits.fileSize`、`build/src/routes/index.js` 的
`express.json/urlencoded limit`、`nginx/conf.d/20-clipboard.conf` 的
`client_max_body_size`（改为 `201m`）。注意放宽后内存占用与传输超时也需同步评估。

---

## 5. 备份与恢复

### 备份

```bash
cd ~/workspace/web_fuzhi/web-clipboard
./scripts/backup.sh              # → ./backup/web-clipboard-<时间戳>.tar.gz
KEEP=30 ./scripts/backup.sh      # 保留最近 30 份（默认 14）
```

覆盖内容：`messages.json`（全部消息记录）+ `uploads/`（全部附件，含原图与缩略图）。

**一致性如何保证**（脚本头部也有同样说明）：

1. 应用写 `messages.json` 采用「先写临时文件再 `rename`」的原子落盘，并带约 500 ms
   防抖 —— 因此任何时刻读到的 `messages.json` 都是完整 JSON。脚本打包前会先校验其
   可解析性，不可解析则重试 5 次，仍失败就中止备份，绝不产出损坏归档。
2. 打包顺序固定为 **`uploads/` → `messages.json`**。即使两次读取之间新增了一条消息，
   最坏结果只是归档里多了一个孤立附件，**绝不会出现「消息记录引用了不存在的附件」**。
3. 备份期间应用保持运行，无需停机；`data/` 以只读方式挂载进临时容器。

**为什么用容器打包**：app 容器以 root 运行，附件在宿主机上属主是 root，普通用户
`wt` 无法读取。脚本用同一个应用镜像以 root 身份挂载 `data/`，从而无需 sudo
（本机 sudo 不可用）。归档产出后会 `chown 1000:1000` 并 `chmod 600`。

建议定时任务（每天 03:17）：

```cron
17 3 * * * /home/wt/workspace/web_fuzhi/web-clipboard/scripts/backup.sh >> /home/wt/workspace/web_fuzhi/web-clipboard/backup/backup.log 2>&1
```

### 恢复

```bash
./scripts/restore.sh                                  # 列出可用备份
./scripts/restore.sh backup/web-clipboard-20261013-031700.tar.gz
```

脚本会：① 先用容器 root 把当前 `data/` 整体打包成回滚点
`data.rollback-<时间戳>.tar.gz`；② 停止 `app`；③ 清空并解包归档到 `data/`；
④ 启动 `app` 并轮询健康检查至 `healthy`；⑤ 打印消息条数。

需要手工输入 `yes` 才会执行覆盖，避免误操作。

### 回滚

```bash
./scripts/restore.sh data.rollback-20261013-070000.tar.gz
```

回滚点文件名会在每次恢复结束时打印。

---

## 6. 升级流程

```bash
cd ~/workspace/web_fuzhi/web-clipboard
./scripts/backup.sh                 # 1. 升级前必须先备份
docker compose down                 # 2. 停容器（数据保留在 ./data）
# 3. 修改 build/ 下的源码或 docker-compose.yml 中的镜像 tag
docker compose build app            # 4. 重新构建
docker compose up -d                # 5. 启动
docker compose ps                   # 6. 确认 healthy
```

**回滚**：`docker compose down && ./scripts/restore.sh data.rollback-<时间戳>.tar.gz`，
或把 `docker-compose.yml` 里的镜像 tag 改回旧版本再 `docker compose up -d`。

> 升级前不要跳过备份：`data/messages.json` 的 schema 若在新版本发生变化，
> 仅回滚镜像无法还原数据。

---

## 7. HTTPS 证书

**当前使用的是自签证书，有效期至 2036-10-10（约 10 年）**，由本项目的
`scripts/self-signed-cert.sh` 生成，覆盖以下名称：

```
CN=xm.7705.work
SAN: DNS:xm.7705.work, DNS:localhost, IP:127.0.0.1, IP:240e:36f:15d8:b181::aea
```

首次访问时浏览器会提示"证书不受信任"，点**高级 → 继续前往**即可，
之后该浏览器不再提示。**这是预期行为**：本服务不对外开放、无公开域名备案，
内外网访问都经过登录保护，因此不申请公共 CA 证书。

> 浏览器告警只影响首次访问的观感，**不影响传输加密** —— 8443 端口上的
> 流量依然是完整 TLS 加密的，密码与内容不会被明文抓包。

### 重新生成（例如需要更换 IP 或续期）

```bash
cd ~/workspace/web_fuzhi/web-clipboard
./scripts/self-signed-cert.sh                 # 默认 10 年
DAYS=7300 ./scripts/self-signed-cert.sh       # 自定义有效期
```

脚本会重新生成 `nginx/certs/` 下的全部证书文件并热加载 nginx，
**不需要重启容器**。

> `nginx/conf.d/20-clipboard.conf` 里的 `ssl_stapling on` 对自签证书无效，
> nginx 启动时会打印一条 `"ssl_stapling" ignored, no OCSP responder URL` 的
> **警告**（不是错误）。自签证书没有 OCSP 服务器，这条警告可以忽略；
> 若要消除，把该行与 `ssl_stapling_verify`、`ssl_trusted_certificate` 三行注释掉即可。

### 若将来要换成公共 CA 证书（可选）

前提：能拿到 `xm.7705.work` 所在 DNS 服务商（NS 为 `elm.dnspod.net` /
`mushroom.dnspod.net`，即 DNSPod）的 API 凭据。公网 80/443 不可用，
因此**只能**走 DNS-01；不要改用 HTTP-01 或 TLS-ALPN-01 绕过端口限制。

### 前置：安装工具 + 提供凭据

```bash
sudo apt-get update && sudo apt-get install -y certbot python3-certbot-dns-dnspod
```

创建凭据文件（**权限必须 600，不要写入日志、报告或 Git**；已在 `.gitignore` 中排除）：

```bash
cd ~/workspace/web_fuzhi/web-clipboard
cat > dns-credentials.ini <<'CRED'
dns_dnspod_api_id = <DNSPod API ID>
dns_dnspod_api_key = <DNSPod API Token>
CRED
chmod 600 dns-credentials.ini
```

凭据获取：DNSPod 控制台 → 用户中心 → 密钥管理 → 创建密钥。

### 申请 / 续期

```bash
./scripts/deploy-certs.sh --status    # 仅查看当前证书（会提示是否为自签）
./scripts/deploy-certs.sh --staging   # 先用测试环境演练，避免触发速率限制
./scripts/deploy-certs.sh             # 正式申请/续期（--keep-until-expiring 幂等）
```

脚本流程：certbot `certonly --dns-dnspod`（传播等待 120 s）→ 把
`fullchain.pem`(644) / `privkey.pem`(600) 安装到 `nginx/certs/` →
`docker exec wcb-nginx nginx -s reload` → `nginx -t`。
脚本只读取凭据文件的**路径**，从不打印其内容。

### 自动续期

证书签发后 certbot 会写入 `/etc/letsencrypt/renewal/` 的续期配置。让续期后自动重载：

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-wcb-nginx.sh >/dev/null <<'HOOK'
#!/bin/sh
install -m 644 /etc/letsencrypt/live/xm.7705.work/fullchain.pem /home/wt/workspace/web_fuzhi/web-clipboard/nginx/certs/fullchain.pem
install -m 600 /etc/letsencrypt/live/xm.7705.work/privkey.pem   /home/wt/workspace/web_fuzhi/web-clipboard/nginx/certs/privkey.pem
docker exec wcb-nginx nginx -s reload
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-wcb-nginx.sh
```

`certbot.timer`（apt 安装时自带）会每日两次检查，剩余有效期不足 30 天时自动续期，
续期成功后触发上面的 hook 重载证书，**无需人工干预**。

> 手工在 DNS 面板加 TXT 记录的方式也能签一次证书，但**无法无人值守续期**
> （每次都要人工改记录），因此不作为正式方案。

---

## 8. 安全设计要点

* **登录保护**：nginx `auth_request` 子请求统一鉴权，覆盖全部数据接口、附件下载
  与 Socket.IO 实时通道；`/api/messages/auth-verify` 只接受来自本机/容器网络的请求，
  外部无法直接调用。
* **仅有的两个免登录路径**（都是登录流程本身必需，且不含任何私有数据）：
  * `= /socket.io/socket.io.js` —— Socket.IO 客户端静态 JS。
    `index.html` 用同步 `<script src>` 加载它，若返回 401 浏览器会当作脚本加载失败，
    登录页因此无法正常初始化。
  * `= /api/auth/status` —— 只返回 `{"mode":"single","requirePassword":true}`。
    *注意*：若将来启用多用户模式（`ACCESS_PASSWORDS`），该接口会额外返回用户 ID 列表，
    届时需改回受保护或让应用侧裁剪 `users` 字段。
  其余一切（`/api/messages*`、`/api/favorites`、附件原图/文件流、Socket.IO 握手、
  `/uploads/`）未登录一律 `401` 或 `404`。
* **应用端口不对外**：`wcb-app` 只在 Docker 内网 `internal` 上 `expose: 3000`，
  宿主机不发布该端口；对外只有 nginx 的 8443。
* **上传文件不被执行**：附件默认一律以 `application/octet-stream` + `attachment` 下发，
  并附加 `X-Content-Type-Options: nosniff` 与
  `Content-Security-Policy: default-src 'none'; sandbox`。
  HTML / SVG 等主动内容不会在浏览器中被渲染执行 —— 点击即下载，本地打开。
  图片若确认为安全类型才 `inline` 预览。
* **窗口内预览是「白名单 + 主动内容否决」双重门**：只有同时满足
  (1) 不在主动内容黑名单（`isActiveContent`：`.html/.svg/.xml/.js/...`），且
  (2) 命中纯文本白名单（`isPreviewableText`：`.json/.jsonl/.ndjson/.txt/.md/.csv/.yaml/.log/...`）
  的文件，才允许 `?inline=1` 在浏览器窗口内预览。任何主动内容即便带 `inline=1`
  也强制 `octet-stream` + `attachment` 下载，不会被当作页面渲染。
* **中文文件名**：使用 RFC 5987 `filename*=UTF-8''...`，中文名下载后保持一致。
* **无公开分享**：`/share`、`/api/share/*`、`/share.html`、`/share.js` 一律 `404`。
* **凭据不进日志**：应用与脚本均不打印密码；`auth-verify` 中此前的调试日志已删除。

---

## 9. 已知限制

* **上传单文件上限 100 MiB**（有意设定），详见第 4 节。
* **窗口内预览的文本文件上限 2 MiB**（`MAX_PREVIEW_BYTES`）。超过此大小即使类型
  在预览白名单内，`?inline=1` 也会返回 `413`，界面提示"文件过大，请下载后查看"。
  预览内容超过 30 万字符时仅显示前 30 万字符，并给出截断提示。
* **`.js / .html / .svg / .xml` 等主动内容只能下载，不能在窗口内预览**。这是刻意的
  安全取舍（避免在会话域内渲染可执行内容）。如需放开某类扩展名，同时修改
  `build/src/utils.js` 的 `PREVIEWABLE_EXT`/`PREVIEWABLE_MIME`（服务端门）与
  `build/public/app.js` 的 `PREVIEWABLE_EXT_RE`/`PREVIEWABLE_MIME_SET`（按钮显示），
  并**务必确认该类型不在 `isActiveContent` 的否决名单内**，改完重新构建 app 镜像。
* **网格卡片模式下"加载更早消息"改为按钮触发**，不再滚动到底部自动加载
  （网格布局无法可靠保持滚动位置）。工具条上的「加载更早消息」按钮与搜索结果
  分页共用同一入口。
* **历史搜索为服务端全量检索**（关键词匹配文字内容、文件名、备注），支持类型
  （文字/图片/文件）与时间范围（今天/7 天/30 天）筛选。前端做了 500 ms 防抖与
  结果缓存；输入框回车立即搜索。
* **使用自签证书**，首次访问每个浏览器需要点一次"继续前往"，之后不再提示。
  证书有效期至 2036-10-10，**不需要任何续期维护**。
* **必须先登录**才能访问任何内容；这是设计目标，不是缺陷。
* 从**仅 IPv4 的外部网络**无法直连本服务（入口只发布在 IPv6 与内网 IPv4 上）。
* **日志中的 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 告警是良性的**：应用刻意保持
  Express `trust proxy = false`，以便 `req.socket.remoteAddress` 保留真实 socket
  地址，供 `auth-verify` 的"仅内部来源"校验使用。代价是 `express-rate-limit` 会
  记录一条告警，且所有经 nginx 的请求共用同一个限流桶（因此搜索做了防抖+缓存）。
  不影响功能，可忽略。

---

## 10. 故障排查

```bash
# 容器没起来
docker compose ps
docker compose logs --tail=200 app
docker compose logs --tail=200 nginx

# 证书报错
docker exec wcb-nginx nginx -t
./scripts/deploy-certs.sh --status

# 登录一直 401
#   → 检查 .env 的 ACCESS_PASSWORD 与 credentials.txt 是否一致
#   → 浏览器清掉 xm.7705.work 的 Cookie 后重新登录
#   → 如果提示“登录尝试过于频繁”，应用对 /api/auth 限流为
#     每 IP 每分钟 5 次；等待 1 分钟，或执行：
#     docker compose restart app      # 重置内存中的限流计数

# 上传报 "File too large"
#   → 单文件超过 100 MiB，见第 4 节

# 数据目录权限问题
#   → 属主为 root 是预期行为，用 scripts/ 下的脚本或 docker exec 操作
```
