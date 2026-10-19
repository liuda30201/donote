#!/usr/bin/env bash
# =============================================================================
# web-clipboard —— 使用 HTTP-01 申请/续期指定域名的正式证书
#
# 适用范围：
#   - 本机有独立公网 IP，外网可直连 80 与 443（已在手机移动网络实测通过）
#   - 走 HTTP-01：Let's Encrypt 从 80 端口的 /.well-known/acme-challenge/ 取验证文件
#
# 为什么用 HTTP-01 而不是 TLS-ALPN-01：
#   - 本机 certbot 为 1.12（Debian 11 源内版本），其 standalone 插件【只支持 HTTP-01】，
#     TLS-ALPN-01 需要 certbot 2.x 以上（apt 源里没有 alpn 插件包）
#   - HTTP-01 全程【不需要停 nginx】：nginx 常态通过 webroot 提供挑战文件，
#     续期同样零停机；TLS-ALPN-01 每次续期都要独占 443、停服 10~30 秒
#
# 因此本脚本【不停容器、不重载证书挂载】，只做：写挑战文件 → 签发 → 同步证书 → reload。
#
# 前置条件（缺一不可）：
#   1. 已安装 certbot（脚本会检测）
#   2. 外网能从 80 连接到本机（否则 ACME 服务器取不到挑战文件）
#   3. docker-compose.yml 已发布 80 端口，且 nginx 的 ACME 挑战根目录指向本机
#      nginx/www/acme（容器内 /var/www/acme）
#   4. certbot.timer 已启用（自动续期由它驱动，见脚本结尾）
#
# 用法：
#   ./scripts/deploy-certs.sh             # 申请（证书不存在时）或续期
#   ./scripts/deploy-certs.sh --staging   # 先用 Let's Encrypt 测试环境演练，避免触发速率限制
#   ./scripts/deploy-certs.sh --status    # 仅查看当前证书状态
# =============================================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
CERT_DIR="${PROJECT_DIR}/nginx/certs"
WEBROOT_DIR="${PROJECT_DIR}/nginx/www/acme"
DOMAIN="${DOMAIN:?请先设置 DOMAIN 环境变量，例如 DOMAIN=notes.example.com ./scripts/deploy-certs.sh}"
EMAIL_FILE="${PROJECT_DIR}/acme-email.txt"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"
NGINX_CONTAINER="wcb-nginx"

show_status() {
  if [ -f "${CERT_DIR}/fullchain.pem" ]; then
    log "当前 ${CERT_DIR}/fullchain.pem 信息："
    openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName || true
    # 判据：issuer 里是否含 "Let's Encrypt"。
    # 早期版本用 `grep -q "CN *= *${DOMAIN}$"` 判断自签，但自签证书的 issuer
    # 实际是 "CN = node.7705.work, O = web-clipboard, OU = self-signed"，
    # 末尾是 self-signed 而非域名，锚定 $ 根本匹配不上 → 会把自签误报成正式证书。
    local issuer
    issuer="$(openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -issuer)"
    if printf '%s' "${issuer}" | grep -qi "STAGING"; then
      log "⚠ 这是 Let's Encrypt【测试(staging)】证书，浏览器不信任，请去掉 --staging 重跑。"
    elif printf '%s' "${issuer}" | grep -qi "Let's Encrypt"; then
      log "✓ 这是 Let's Encrypt 签发的正式证书。"
    else
      log "⚠ 这【不是】Let's Encrypt 正式证书（当前应为自签），不构成正式部署完成。"
    fi
  else
    log "证书文件不存在：${CERT_DIR}/fullchain.pem"
  fi
}

if [ "${1:-}" = "--status" ]; then
  show_status
  exit 0
fi

STAGING=""
if [ "${1:-}" = "--staging" ]; then
  STAGING="--staging"
  log "使用 Let's Encrypt 测试(staging)环境演练"
fi

# ---------------------------------------------------------------------------
# 1. 工具检查
# ---------------------------------------------------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  cat >&2 <<'EOF'
错误: 未安装 certbot。

本机为 Debian 11 (bullseye)，请以 root 或有 sudo 权限的账号执行：

    sudo apt-get update
    sudo apt-get install -y certbot
    sudo systemctl enable --now certbot.timer

说明：本部署走 HTTP-01，只需要 certbot 本体（standalone/webroot 插件自带），
     不需要任何 DNS 插件，也不需要 TLS-ALPN 插件。
EOF
  exit 1
fi

# 必须是 root 才能写 /etc/letsencrypt 与挑战文件
if [ "$(id -u)" -ne 0 ]; then
  die "需要 root 权限（要写 /etc/letsencrypt）。请用: sudo $0 $*"
fi

# ---------------------------------------------------------------------------
# 2. 前置检查：80 端口可达 + 挑战目录可写
# ---------------------------------------------------------------------------
log "预检：${DOMAIN}:80 是否可从公网连接"
if timeout 15 bash -c "exec 3<>/dev/tcp/${DOMAIN}/80" 2>/dev/null; then
  log "✓ ${DOMAIN}:80 可连接"
else
  log "⚠ 无法连接 ${DOMAIN}:80 —— 若继续，ACME 验证很可能失败"
  log "  请先确认：DNS 解析正确、防火墙放行 80、wcb-nginx 正在运行且已发布 80"
  log "  仍要继续请设置 SKIP_PREFLIGHT=1 重跑"
  [ "${SKIP_PREFLIGHT:-0}" = "1" ] || die "预检未通过，已中止"
fi

if [ ! -d "${WEBROOT_DIR}" ]; then
  die "挑战目录不存在: ${WEBROOT_DIR}
请创建后重跑: mkdir -p ${WEBROOT_DIR}"
fi
log "✓ 挑战目录就绪: ${WEBROOT_DIR}"

# ---------------------------------------------------------------------------
# 3. 联系邮箱（可选，用于到期提醒）
# ---------------------------------------------------------------------------
EMAIL_ARG="--register-unsafely-without-email"
# 用数组承载 certbot 参数，避免无引号展开时把邮箱内容当作额外选项解析
EMAIL_OPTS=()
if [ -f "${EMAIL_FILE}" ]; then
  EMAIL="$(head -n1 "${EMAIL_FILE}" | tr -d '[:space:]')"
  if [ -n "${EMAIL}" ]; then
    # 邮箱必须匹配白名单字符集，否则 certbot 会把 -- 开头的值当成选项（argument injection）
    if ! printf '%s' "${EMAIL}" | grep -qE '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
      die "邮箱格式非法: ${EMAIL_FILE} 首行不是合法邮箱，已中止（避免参数注入）"
    fi
    EMAIL_ARG=""
    EMAIL_OPTS=(--email "${EMAIL}")
  fi
fi

# ---------------------------------------------------------------------------
# 4. 申请 / 续期（webroot，全程不停 nginx）
# ---------------------------------------------------------------------------
# 从 staging 切到正式环境时，现有证书仍"有效"，--keep-until-expiring 会直接跳过签发，
# 导致 nginx 继续用浏览器不信任的测试证书。检测到这种情况就强制重新签发。
FORCE_OPTS=()
if [ -z "${STAGING}" ] && [ -f "${LIVE_DIR}/cert.pem" ] \
   && openssl x509 -in "${LIVE_DIR}/cert.pem" -noout -issuer | grep -qi "STAGING"; then
  log "检测到现有证书是 staging 测试证书，本次强制换发正式证书"
  FORCE_OPTS=(--force-renewal --server https://acme-v02.api.letsencrypt.org/directory)
fi

log "申请/续期证书: ${DOMAIN} （HTTP-01 / webroot，不中断服务）"
certbot certonly \
  --webroot \
  --webroot-path "${WEBROOT_DIR}" \
  --preferred-challenges http-01 \
  -d "${DOMAIN}" \
  --non-interactive \
  --agree-tos \
  "${EMAIL_OPTS[@]}" \
  ${EMAIL_ARG:+${EMAIL_ARG}} \
  ${STAGING} \
  "${FORCE_OPTS[@]}" \
  --keep-until-expiring

if [ ! -f "${LIVE_DIR}/fullchain.pem" ]; then
  die "certbot 未生成 ${LIVE_DIR}/fullchain.pem，请检查上方输出"
fi

# ---------------------------------------------------------------------------
# 5. 同步到 nginx 容器挂载目录并热加载
# ---------------------------------------------------------------------------
# 注意：不要把 nginx 的 ssl_certificate 直接指向 /etc/letsencrypt/live/，
#       那里的 *.pem 是指向 archive/ 的符号链接，挂载进容器后会断开。
log "同步证书到 ${CERT_DIR}"
install -m 644 "${LIVE_DIR}/fullchain.pem" "${CERT_DIR}/fullchain.pem"
install -m 600 "${LIVE_DIR}/privkey.pem"   "${CERT_DIR}/privkey.pem"

if docker ps --format '{{.Names}}' | grep -qx "${NGINX_CONTAINER}"; then
  log "重载 nginx"
  # 先校验配置再 reload（顺序反了会在配置有误时先加载失败）
  docker exec "${NGINX_CONTAINER}" nginx -t
  docker exec "${NGINX_CONTAINER}" nginx -s reload
  # reload 是异步的：新 worker 起来前握手仍由旧 worker 处理，立即检查会看到旧证书
  sleep 3
  log "实际在 443 上提供的证书："
  timeout 15 openssl s_client -connect "127.0.0.1:443" -servername "${DOMAIN}" </dev/null 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates 2>/dev/null || log "⚠ 本地握手检查失败（不影响外部访问，可用浏览器复核）"
else
  log "⚠ ${NGINX_CONTAINER} 未运行，跳过重载（下次启动会自动加载新证书）"
fi

# ---------------------------------------------------------------------------
# 6. 续期钩子（证书更新后自动同步 + 热加载）
# ---------------------------------------------------------------------------
# HTTP-01 续期同样不停 nginx，因此钩子只需同步证书 + reload，无需重启容器。
HOOK_DIR="/etc/letsencrypt/renewal-hooks/deploy"
HOOK_FILE="${HOOK_DIR}/reload-wcb-nginx.sh"
log "写入续期钩子: ${HOOK_FILE}"
mkdir -p "${HOOK_DIR}"
cat > "${HOOK_FILE}" <<HOOK
#!/bin/sh
# 由 deploy-certs.sh 自动生成 —— certbot 续期成功后执行
# 1) 同步证书到项目挂载目录  2) 热加载 nginx（HTTP-01 续期无需停服）
set -e
install -m 644 ${LIVE_DIR}/fullchain.pem ${CERT_DIR}/fullchain.pem
install -m 600 ${LIVE_DIR}/privkey.pem   ${CERT_DIR}/privkey.pem
docker exec ${NGINX_CONTAINER} nginx -t
docker exec ${NGINX_CONTAINER} nginx -s reload
HOOK
chmod +x "${HOOK_FILE}"

# ---------------------------------------------------------------------------
# 7. 自动续期定时器检查
# ---------------------------------------------------------------------------
if systemctl list-timers --all 2>/dev/null | grep -q 'certbot.timer'; then
  log "✓ certbot.timer 已存在，自动续期已启用"
  systemctl list-timers certbot.timer --no-pager 2>/dev/null | head -3 || true
else
  log "⚠ 未检测到 certbot.timer。请手工启用："
  log "    systemctl enable --now certbot.timer"
fi

show_status
log "完成。浏览器访问 https://${DOMAIN} 应无证书告警。"
