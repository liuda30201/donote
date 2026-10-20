# 部署与运维

所有命令在项目根目录执行。默认部署为 `wcb-nginx` → `wcb-app:3000`，只有 Nginx 对外发布端口；配置是单用户私有服务。

## 域名与入口

当前配置通过 `DOMAIN` 和 `NGINX_SERVER_NAME` 两个环境变量指定域名，80 提供 ACME HTTP-01 验证并将其他请求跳转到 HTTPS；443 提供应用入口。Compose 同时发布 IPv4 和 IPv6 地址；外部可达性还取决于 DNS、路由和防火墙。

换域名时同步修改：

- `nginx/conf.d/20-clipboard.conf` 的 `server_name`。
- `docker-compose.yml` 的 Nginx 健康检查 `Host`。
- `scripts/self-signed-cert.sh` 和 `scripts/deploy-certs.sh` 的 `DOMAIN`。

为新域名签发证书后检查 Nginx 配置，再启动或重载。

## 首次部署

```bash
cp .env.production.example .env && chmod 600 .env
# 编辑 .env，至少填写 ACCESS_PASSWORD
docker compose build app
docker compose up -d
curl -fkSs https://127.0.0.1/healthz   # 自签证书阶段用 -k
sudo ./scripts/deploy-certs.sh         # 签发正式证书并热加载
curl -fsS https://<your-domain>/healthz # 校验公网证书与入口
```

DNS 的 A/AAAA 必须指向本机，80 端口需对公网放行；首次构建使用 `web-clipboard-local:1.6.9-p8`，并在 `.env` 中设置 `DOMAIN` 与 `NGINX_SERVER_NAME`。

## 日常操作

| 目的 | 命令 |
| --- | --- |
| 启动 | `docker compose up -d` |
| 构建应用 | `docker compose build app` |
| 停止，保留数据 | `docker compose stop` |
| 删除容器，保留数据 | `docker compose down` |
| 查看状态 | `docker compose ps` |
| 应用日志 | `docker compose logs -f app` |
| Nginx 日志 | `docker compose logs -f nginx` |
| 最近日志 | `docker compose logs --tail=100 app nginx` |
| 重启应用 | `docker compose restart app` |
| 检查代理配置 | `docker exec wcb-nginx nginx -t` |
| 健康检查 | `curl -fsS https://<your-domain>/healthz` |
| 查看证书 | `./scripts/deploy-certs.sh --status` |

自签证书下，健康检查需使用 `curl -fkSs`。`/healthz` 仅检查 Nginx 响应，应用健康状态见 `docker compose ps`。两个容器配置 `restart: unless-stopped`。

## 密码与配置

复制 `.env.example` 为 `.env` 后设置 `ACCESS_PASSWORD`，文件权限为 600。它是 Compose 认证配置的唯一来源；已有 `credentials.txt` 只是初始记录，修改密码后不会自动同步。

```bash
# 生成候选密码，将输出填入 .env 的 ACCESS_PASSWORD
openssl rand -hex 24
# 修改 .env 后重新创建应用，使环境变量生效
docker compose up -d --force-recreate app
```

浏览器需要重新登录。根目录 `.env`、`credentials.txt`、证书私钥、ACME 邮箱和 DNS 凭据均忽略提交。

| 配置 | Compose 默认值 |
| --- | --- |
| `ACCESS_PASSWORD` | 必填，无默认密码 |
| `EXPIRE_HOURS` | 720 小时，即 30 天 |
| `FILE_CLEANUP_INTERVAL_MINUTES` | 30 分钟 |
| `MESSAGE_PAGE_SIZE` | 30 |
| `SOCKET_SYNC_LIMIT` | 20 |

Compose 固定容器 `STORAGE_ROOT=/app/data`、`TZ=Asia/Shanghai`；直接运行 Node 时的默认保留期为 168 小时，详见 `app/src/config.js`。

## 数据与权限

| 内容 | 宿主机 | 容器内 |
| --- | --- | --- |
| 消息 | `data/messages.json` | `/app/data/messages.json` |
| 附件 | `data/uploads/` | `/app/data/uploads/` |
| 旧分享数据 | `data/shares/` | `/app/data/shares/` |
| Nginx 配置 | `nginx/conf.d/` | `/etc/nginx/conf.d/`，只读 |
| TLS 证书 | `nginx/certs/` | `/etc/nginx/certs/`，只读 |
| ACME 挑战文件 | `nginx/www/acme/` | `/var/www/acme/`，只读 |
| 备份 | `backup/` | 临时备份容器内 `/backup` |

数据目录的宿主机属主取决于容器与历史迁移，不要依赖固定用户名或 UID。备份/恢复脚本使用临时容器 root 处理文件，产出的归档归当前调用用户所有。

过期的非收藏消息会自动删除并清理附件；孤儿附件定期清扫。不要手工删除生产 `data/`。

## 备份与恢复

```bash
./scripts/backup.sh                         # backup/web-clipboard-<时间戳>.tar.gz
KEEP=30 ./scripts/backup.sh                 # 默认保留 14 份
./scripts/restore.sh                        # 列出备份与回滚点
./scripts/restore.sh backup/web-clipboard-YYYYmmdd-HHMMSS.tar.gz
```

镜像默认从 Compose 解析；必要时通过 `IMAGE=镜像名` 覆盖。备份包含消息、附件及存在的旧分享数据；备份目录权限 700，备份文件权限 600。

应用原子写入 JSON，但**在线打包不是严格时间点快照**：备份期间新增或删除附件仍可能让记录和文件不一致。需要严格一致性时暂停应用：

```bash
docker compose stop app
./scripts/backup.sh
docker compose start app
```

备份失败时也应启动应用并检查日志。可在定时任务中使用项目绝对路径执行 `scripts/backup.sh`；先创建 `backup/` 再将日志重定向到其中。

恢复会验证归档路径、要求输入 `yes`、建立当前数据回滚点、停止应用、覆盖数据并重新启动。Nginx 保持运行，期间可能短暂返回 502。回滚点仍位于项目根目录，名称为 `data.rollback-<时间戳>.tar.gz`，已忽略提交；恢复完成后确认应用 `healthy` 并抽查附件。

```bash
./scripts/restore.sh data.rollback-YYYYmmdd-HHMMSS.tar.gz
```

## 升级与回滚

```bash
./scripts/backup.sh
docker compose build app
docker compose up -d app
docker compose ps
docker compose logs --tail=100 app
```

仅修改应用时无需先 `docker compose down`。镜像回滚可将 Compose 的 `app.image` 改回已保留的旧镜像，再 `docker compose up -d --no-build app`。涉及数据格式变化时同时评估从备份恢复，单独回滚镜像不能还原数据格式。

## HTTPS 证书

以 `./scripts/deploy-certs.sh --status` 查看实际证书，不在文档中固定证书类型和到期日期。

### 当前 donote.cc 账户部署

使用 `docker compose -f docker-compose.accounts.yml` 管理当前服务；SQLite 数据库位于 `data/donote.db`，与附件目录一同持久化。SMTP 配置保存在未提交的 `.env`，启用后登录页提供邮箱验证码注册。

空数据库首次启动时，应用读取 `.env` 中唯一一组 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，创建可用邮箱登录的管理员。`ADMIN_PASSWORD` 是网站登录密码；只有明确希望复用时才填写为现有邮箱密码，它不会自动读取 `SMTP_PASSWORD`。`.env` 权限应为 `600`。管理员先通过邮箱和密码验证，再按提示扫描身份验证器二维码、输入动态验证码，并保存恢复码；绑定后每次登录都需要动态验证码。

初始化仅作用于空数据库。重启或修改 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 不会覆盖已有账户，也不会把自行注册的同名邮箱账户提升为管理员。已有管理员的密码应在登录后的安全设置中修改。登录页默认仅显示邮箱账号和密码，通过密码验证后才按账户设置显示二次验证。

本机 Certbot 使用项目内 `.letsencrypt/`、`.letsencrypt-work/` 和 `.letsencrypt-logs/`，由可访问 Docker 的部署用户运行，无需 sudo。证书使用 `donote.cc`，通过 Nginx 的 HTTP-01 webroot 验证。当前用户 cron 每日 03:17、15:17（服务器时区）执行 `scripts/renew-local-certs.sh`，日志位于 `.letsencrypt-logs/cron-renew.log`。脚本执行续期检查后同步正式证书并校验、热加载 Nginx。

```bash
crontab -l
./scripts/renew-local-certs.sh --dry-run    # 模拟续期，不安装测试证书
./scripts/renew-local-certs.sh --sync-only  # 同步现有证书并热加载
openssl x509 -in nginx/certs/fullchain.pem -noout -issuer -dates
```

项目移动后需更新 cron 中的绝对路径及 `.letsencrypt/renewal/donote.cc.conf` 中的 webroot 路径。备份时除 `data/` 外还应保存 `.secrets/`、`.env`、`.letsencrypt/`；这些文件包含私钥及凭据，不能提交到仓库。

### 首次启动或内网测试

```bash
./scripts/self-signed-cert.sh
# 可选：DAYS=7300 ./scripts/self-signed-cert.sh
```

生成 `fullchain.pem`、`privkey.pem` 和默认站点使用的 `selfsigned.crt`、`selfsigned.key`。SAN 包含域名、localhost、回环和扫描到的本机 IP。自签证书需要客户端信任；该脚本会覆盖主站证书，正式证书部署后不要随意重跑。

默认 443 站点使用 `selfsigned.*` 作为兜底，域名匹配的主站使用 `fullchain.pem` / `privkey.pem`。两组文件都必须存在。

### 正式域名证书：HTTP-01

需要域名正确解析、公网可达的 80 端口、运行中的 Nginx 和已安装的 Certbot。脚本使用 **webroot HTTP-01**，不需要 DNSPod API 凭据。

```bash
sudo apt-get update
sudo apt-get install -y certbot
sudo systemctl enable --now certbot.timer
# 可选：将联系邮箱放入根目录 acme-email.txt
sudo ./scripts/deploy-certs.sh --staging   # 测试签发，证书不受浏览器信任
sudo ./scripts/deploy-certs.sh             # 正式签发/续期
./scripts/deploy-certs.sh --status
```

脚本同步证书到 `nginx/certs/`，先 `nginx -t` 再热加载，并在 `/etc/letsencrypt/renewal-hooks/deploy/` 写入续期钩子。`certbot.timer` 负责定期检查续期；项目移动后需重新生成钩子，使其中的路径与项目一致。

自动续期链路：`certbot.timer` → `certbot.service` 检查到期（到期前 30 天）→ renewal-hooks/deploy 同步证书到 `nginx/certs/` → `wcb-nginx` 热加载。日常只需确认：

```bash
systemctl list-timers certbot.timer          # 下一次检查时间
sudo certbot renew --dry-run                 # 演练续期，不影响线上证书
./scripts/deploy-certs.sh --status           # 挂载目录里的证书是否已更新
```

注意：续期钩子依赖本机 docker 可用（`docker exec wcb-nginx`）。若 nginx 容器未运行，钩子中 `install` 先执行、`docker exec` 随后失败，certbot 会把该钩子记为错误，但证书本身已续期，下次 `docker compose up -d` 即可加载新证书。

## 访问与文件限制

- 私有数据接口、文件流和 Socket.IO 由 Nginx 认证并由应用再次鉴权。
- 登录页面、静态脚本、登录状态和健康检查无需登录。认证状态不返回用户 ID 列表。
- Cookie `wc_auth` 由前端写入，值为 Base64 编码密码；编码不等于加密，传输依赖 HTTPS。
- 公开分享和直接访问 `/uploads/` 已禁用。分享资料仅保留为上游参考和旧数据清理用途。
- 上传文件限制 100 MiB；Nginx 请求体限制 101 MiB，为 multipart 留出余量。
- 文本预览默认限制 2 MiB，前端最多显示 30 万字符；HTML/SVG/JS/XML 等主动内容强制下载。
- 应用保持 `trust proxy=false`，经 Nginx 的请求可能共用限流桶；认证尝试限制见 `app/src/middleware/rateLimit.js`。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 容器启动失败 | `docker compose ps` 和 `docker compose logs --tail=200 app nginx` |
| 证书错误 | `docker exec wcb-nginx nginx -t`；`./scripts/deploy-certs.sh --status` |
| 登录返回 401 | 检查 `.env` 是否已生效，清除站点 Cookie 后重新登录；初始凭据文件可能过时 |
| 登录限流 | 等待限流窗口恢复；确认没有重复自动请求 |
| 上传被拒绝 | 同时检查应用文件限制和 Nginx 请求体限制 |
| 数据权限错误 | 使用备份/恢复脚本或容器内操作，核对挂载目录实际属主 |
| HTTPS 可达但页面失败 | `/healthz` 只检查 Nginx；继续检查应用健康与日志 |
