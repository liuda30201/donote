#!/usr/bin/env bash
# Project-local Certbot storage; runs as the Docker-enabled deployment user.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
DOMAIN="${DOMAIN:-donote.cc}"
CONFIG_DIR="${PROJECT_DIR}/.letsencrypt"
WORK_DIR="${PROJECT_DIR}/.letsencrypt-work"
LOG_DIR="${PROJECT_DIR}/.letsencrypt-logs"
CERT_DIR="${PROJECT_DIR}/nginx/certs"
LIVE_DIR="${CONFIG_DIR}/live/${DOMAIN}"
export PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"

mkdir -p "${WORK_DIR}" "${LOG_DIR}"
exec 9>"${WORK_DIR}/renew.lock"
flock -n 9 || exit 0

case "${1:-}" in
  --sync-only) ;;
  --dry-run)
    certbot renew --cert-name "${DOMAIN}" --config-dir "${CONFIG_DIR}" \
      --work-dir "${WORK_DIR}" --logs-dir "${LOG_DIR}" --dry-run
    exit 0
    ;;
  "")
    certbot renew --quiet --cert-name "${DOMAIN}" --config-dir "${CONFIG_DIR}" \
      --work-dir "${WORK_DIR}" --logs-dir "${LOG_DIR}"
    ;;
  *) die "Usage: $0 [--dry-run|--sync-only]" ;;
esac

# Copy resolved files: the live/ symlinks cannot be mounted alone in Nginx.
install -m 644 "${LIVE_DIR}/fullchain.pem" "${CERT_DIR}/fullchain.pem"
install -m 600 "${LIVE_DIR}/privkey.pem" "${CERT_DIR}/privkey.pem"
docker exec wcb-nginx nginx -t
docker exec wcb-nginx nginx -s reload
log "Certificate synchronized and Nginx reloaded for ${DOMAIN}"
