#!/usr/bin/env bash
# =============================================================================
# web-clipboard —— 使用 DNS-01 申请/续期 xm.7705.work 的正式证书
#
# 适用范围：
#   - 公网 80 / 443 均不可用，因此【只能】使用 DNS-01 验证
#   - 严禁改用 HTTP-01 或 TLS-ALPN-01 绕过端口限制
#   - 证书签发后由 nginx 容器加载到 8443 端口，无需对外开放 443
#
# 前置条件（缺一不可）：
#   1. 已安装 certbot 与 dnspod 插件（脚本会检测并给出安装命令）
#   2. {PROJECT_DIR}/dns-credentials.ini 存在且权限为 600
#   3. 该文件内含有效的 DNSPod API 凭据（见下方模板）
#
# 凭据文件模板（dns-credentials.ini，权限 600）：
#   dns_dnspod_api_id = <你的 DNSPod API ID>
#   dns_dnspod_api_key = <你的 DNSPod API Token>
#   # 若使用腾讯云 DNSPod 的“API 密钥”新版凭据，certbot-dns-dnspod 可能要求：
#   # dns_dnspod_api_token = <id>,<token>
#
# 用法：
#   ./scripts/deploy-certs.sh             # 申请（证书不存在时）或续期
#   ./scripts/deploy-certs.sh --staging   # 先用 Let's Encrypt 测试环境演练，避免触发速率限制
#   ./scripts/deploy-certs.sh --status    # 仅查看当前证书状态
#
# 凭据安全：本脚本只读取 dns-credentials.ini 的路径，绝不打印其内容；
#           certbot 的日志中也不会包含 API Key。
# =============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${PROJECT_DIR}/nginx/certs"
CRED_FILE="${PROJECT_DIR}/dns-credentials.ini"
DOMAIN="xm.7705.work"
EMAIL_FILE="${PROJECT_DIR}/acme-email.txt"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

show_status() {
  if [ -f "${CERT_DIR}/fullchain.pem" ]; then
    log "当前 ${CERT_DIR}/fullchain.pem 信息："
    openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName || true
    if openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -issuer | grep -q "CN *= *${DOMAIN}$"; then
      log "⚠ 这是自签证书（issuer 与 subject 相同），【不构成正式部署完成】。"
    else
      log "✓ 看起来是 CA 签发的证书。"
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

本机为 Debian 12，请以 root 或有 sudo 权限的账号执行：

    apt-get update
    apt-get install -y certbot python3-certbot-dns-dnspod

若 apt 源中没有 python3-certbot-dns-dnspod，可改用 pip 方式：

    python3 -m venv /opt/certbot-dnspod
    /opt/certbot-dnspod/bin/pip install certbot certbot-dns-dnspod

说明：7705.work 的 NS 为 elm.dnspod.net / mushroom.dnspod.net（DNSPod），
     因此需要 DNSPod 的 DNS 插件。
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. 凭据检查（存在性 + 权限，不读取内容）
# ---------------------------------------------------------------------------
if [ ! -f "${CRED_FILE}" ]; then
  cat >&2 <<EOF
错误: 缺少 DNS API 凭据文件：${CRED_FILE}

公网 80/443 不可用，只能用 DNS-01 验证，因此必须提供 DNS 服务商 API 凭据。
请按以下步骤创建（不会把密钥写进日志或 Git）：

    cat > ${CRED_FILE} <<'CRED'
    dns_dnspod_api_id = <DNSPod API ID>
    dns_dnspod_api_key = <DNSPod API Token>
    CRED
    chmod 600 ${CRED_FILE}

其中 dns-credentials.ini 已被 .gitignore 排除。
获取方式：DNSPod 控制台 -> 用户中心 -> 密钥管理 -> 创建密钥（DNSPod Token）。
EOF
  exit 1
fi

PERM="$(stat -c '%a' "${CRED_FILE}")"
if [ "${PERM}" != "600" ]; then
  log "凭据文件权限为 ${PERM}，收紧为 600"
  chmod 600 "${CRED_FILE}"
fi

log "凭据文件就绪: ${CRED_FILE} (权限 600，内容不输出)"

# ---------------------------------------------------------------------------
# 3. 联系邮箱（可选，用于到期提醒）
# ---------------------------------------------------------------------------
EMAIL_ARG="--register-unsafely-without-email"
if [ -f "${EMAIL_FILE}" ]; then
  EMAIL="$(head -n1 "${EMAIL_FILE}" | tr -d '[:space:]')"
  if [ -n "${EMAIL}" ]; then
    EMAIL_ARG="--email ${EMAIL}"
  fi
fi

# ---------------------------------------------------------------------------
# 4. 申请 / 续期
# ---------------------------------------------------------------------------
log "申请/续期证书: ${DOMAIN} （DNS-01，不占用 80/443）"

# certbot 以 root 运行；凭据文件需可被 root 读取
certbot certonly \
  --dns-dnspod \
  --dns-dnspod-credentials "${CRED_FILE}" \
  --dns-dnspod-propagation-seconds 120 \
  -d "${DOMAIN}" \
  --non-interactive \
  --agree-tos \
  ${EMAIL_ARG} \
  ${STAGING} \
  --keep-until-expiring

if [ ! -f "${LIVE_DIR}/fullchain.pem" ]; then
  die "certbot 未生成 ${LIVE_DIR}/fullchain.pem，请检查上方输出"
fi

# ---------------------------------------------------------------------------
# 5. 同步到 nginx 容器挂载目录并热加载
# ---------------------------------------------------------------------------
log "同步证书到 ${CERT_DIR}"
install -m 644 "${LIVE_DIR}/fullchain.pem" "${CERT_DIR}/fullchain.pem"
install -m 600 "${LIVE_DIR}/privkey.pem"   "${CERT_DIR}/privkey.pem"

if docker ps --format '{{.Names}}' | grep -qx 'wcb-nginx'; then
  log "重载 nginx"
  docker exec wcb-nginx nginx -s reload
  docker exec wcb-nginx nginx -t
else
  log "wcb-nginx 未运行，跳过重载（下次启动会自动加载新证书）"
fi

show_status
log "完成。浏览器访问 https://${DOMAIN}:8443 应无证书告警。"
