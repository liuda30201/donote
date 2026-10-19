#!/usr/bin/env bash
# =============================================================================
# web-clipboard —— 生成长期自签证书（默认 10 年）
#
# 适用于首次启动或内网测试；正式域名证书请使用 deploy-certs.sh。
# 此脚本会覆盖 fullchain.pem / privkey.pem，不要在正式证书部署后随意重跑。
#
# 生成内容（写入 nginx/certs/）：
#   fullchain.pem  证书（644）
#   privkey.pem    私钥（600）
#   selfsigned.crt / selfsigned.key   同一份证书的副本，供默认站点等使用
#
# 用法：
#   ./scripts/self-signed-cert.sh              # 默认 3650 天
#   DAYS=7300 ./scripts/self-signed-cert.sh    # 自定义有效期
#
# 生成后自动热加载 nginx，无需重启容器。浏览器需要重新接受一次新证书。
# =============================================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
CERT_DIR="${PROJECT_DIR}/nginx/certs"
DAYS="${DAYS:-3650}"
DOMAIN="${DOMAIN:?请先设置 DOMAIN 环境变量，例如 DOMAIN=notes.example.com ./scripts/self-signed-cert.sh}"

command -v openssl >/dev/null 2>&1 || die "未安装 openssl"

mkdir -p "${CERT_DIR}"

# 收集本机可用的 IP，一并写进 SAN，避免用 IP 直接访问时名称不匹配
# IPv6 只取全局地址；IPv4 取内网/全局地址（排除回环与 169.254 链路本地）。
# 注意：公网 IPv6 前缀变化后必须重跑本脚本，否则用 IP 访问会名称不匹配。
SAN="DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1,IP:::1"
if ! command -v ip >/dev/null 2>&1; then
  log "警告: 未找到 ip 命令，SAN 中不会包含本机额外 IP（仅 ${DOMAIN} / localhost / 127.0.0.1 / ::1）"
else
  while read -r ip; do
    [ -n "${ip}" ] && SAN="${SAN},IP:${ip}"
  done < <(ip -o -6 addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^fe80')
  while read -r ip; do
    [ -n "${ip}" ] && SAN="${SAN},IP:${ip}"
  done < <(ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
             | grep -vE '^127\.' | grep -vE '^169\.254\.')
fi

log "有效期: ${DAYS} 天"
log "SAN: ${SAN}"

TMP_CNF="$(mktemp)"
trap 'rm -f "${TMP_CNF}"' EXIT
cat > "${TMP_CNF}" <<EOF
[req]
distinguished_name = dn
x509_extensions    = v3_ext
prompt             = no

[dn]
CN = ${DOMAIN}
O  = web-clipboard
OU = self-signed

[v3_ext]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always,issuer
subjectAltName         = ${SAN}
EOF

umask 077
openssl req -x509 -nodes -newkey rsa:2048 -sha256 \
  -days "${DAYS}" \
  -config "${TMP_CNF}" \
  -keyout "${CERT_DIR}/privkey.pem" \
  -out "${CERT_DIR}/fullchain.pem" 2>/dev/null

chmod 600 "${CERT_DIR}/privkey.pem"
chmod 644 "${CERT_DIR}/fullchain.pem"
install -m 644 "${CERT_DIR}/fullchain.pem" "${CERT_DIR}/selfsigned.crt"
install -m 600 "${CERT_DIR}/privkey.pem"   "${CERT_DIR}/selfsigned.key"

log "已生成:"
openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName

if docker ps --format '{{.Names}}' | grep -qx 'wcb-nginx'; then
  docker exec wcb-nginx nginx -t
  docker exec wcb-nginx nginx -s reload
  log "已热加载 nginx（无需重启容器）"
else
  log "wcb-nginx 未运行，跳过重载（下次启动自动加载）"
fi

log "完成。浏览器首次访问会提示“证书不受信任”，点“高级 → 继续前往”即可。"
