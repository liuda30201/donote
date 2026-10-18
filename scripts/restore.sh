#!/usr/bin/env bash
# Restore into a validated staging tree; keep the complete old tree for rollback.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
DATA_DIR="${PROJECT_DIR}/data"
VALIDATOR="${PROJECT_DIR}/scripts/lib/restore-validate.py"
cd "${PROJECT_DIR}"
if [ "${AUTH_MODE:-legacy}" = accounts ]; then
  export COMPOSE_FILE="${PROJECT_DIR}/docker-compose.accounts.yml"
fi
ARCHIVE="${1:-}"
if [ -z "${ARCHIVE}" ]; then
  shopt -s nullglob
  FOUND=("${PROJECT_DIR}"/backup/web-clipboard-*.tar.gz "${PROJECT_DIR}"/data.rollback-*.tar.gz)
  if [ "${#FOUND[@]}" -gt 0 ]; then ls -lht "${FOUND[@]}"; else log "未找到备份"; fi
  printf '用法: %s <备份归档>\n' "$0"
  exit 0
fi
[ -f "${ARCHIVE}" ] || die "备份不存在"
ARCHIVE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${ARCHIVE}")"
[ -f "${ARCHIVE}" ] || die "归档路径不是普通文件"
STORAGE_MODE="$(python3 - "${ARCHIVE}" <<'PYMODE'
import json,sys,tarfile
with tarfile.open(sys.argv[1], 'r:gz') as tf:
 try:
  member=next((m for m in tf.getmembers() if m.name.lstrip('./') == 'backup-manifest.json'), None)
  print(json.load(tf.extractfile(member)).get('storageMode','legacy') if member else 'legacy')
 except Exception: print('legacy')
PYMODE
)"
[ "${STORAGE_MODE}" = legacy ] || [ "${STORAGE_MODE}" = accounts ] || die "未知归档存储模式"
if [ "${STORAGE_MODE}" = accounts ]; then
  [ "${AUTH_MODE:-}" = accounts ] || die "accounts 归档必须 AUTH_MODE=accounts"
  KEY_FILE="${AUTH_KEY_FILE:-}"
  [ -n "${KEY_FILE}" ] || die "账户恢复必须指定 AUTH_KEY_FILE"
  KEY_FILE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${KEY_FILE}")"
  python3 - "${DATA_DIR}" "${KEY_FILE}" <<'PYKEY'
import os,sys
root,key=map(os.path.realpath,sys.argv[1:])
if os.path.commonpath([root,key]) == root: raise SystemExit('AUTH_KEY_FILE must be outside data root')
PYKEY
fi
for SQLITE_FILE in donote.db-wal donote.db-shm; do
  [ ! -e "${DATA_DIR}/${SQLITE_FILE}" ] && [ ! -L "${DATA_DIR}/${SQLITE_FILE}" ] \
    || die "目标含 SQLite 数据，本恢复器拒绝覆盖账户数据库"
done
ARCHIVE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${ARCHIVE}")"
[ -f "${ARCHIVE}" ] || die "归档路径不是普通文件"
ORIGINAL_BASENAME="$(basename "${ARCHIVE}")"
# Snapshot the operator-selected archive once; all subsequent checks use this inode.
INPUT_SNAPSHOT="$(mktemp "${PROJECT_DIR}/.restore-input.XXXXXX")"
cleanup_input() { [ -z "${INPUT_SNAPSHOT:-}" ] || rm -f -- "${INPUT_SNAPSHOT}"; }
trap 'cleanup_input' EXIT
cp -- "${ARCHIVE}" "${INPUT_SNAPSHOT}" || die "无法创建归档输入快照"
ARCHIVE="${INPUT_SNAPSHOT}"
if [ "${STORAGE_MODE}" = accounts ]; then
  CONTENT_KEYRING_FILE="${SENSITIVE_KEYRING_FILE:-}"
  python3 - "${ARCHIVE}" "${KEY_FILE}" <<'PYKEY'
import hashlib,json,os,stat,sys,tarfile
archive,key=sys.argv[1:]; st=os.lstat(key)
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size != 32: raise SystemExit('invalid AUTH_KEY_FILE')
with tarfile.open(archive,'r:gz') as tf:
 member=next((x for x in tf.getmembers() if x.name.lstrip('./')=='backup-manifest.json'),None)
 if member is None: raise SystemExit('manifest missing')
 m=json.load(tf.extractfile(member))
if m.get('storageMode') != 'accounts' or m.get('keyFingerprint') != hashlib.sha256(open(key,'rb').read()).hexdigest() or m.get('keyId') != os.environ.get('AUTH_KEY_ID','primary'): raise SystemExit('AUTH_KEY_FILE key identity mismatch')
PYKEY
fi
CONTENT_KEYRING_FILE="${SENSITIVE_KEYRING_FILE:-}"
LEGACY_ROLLBACK=0
if [[ "${ORIGINAL_BASENAME}" == data.rollback-*.tar.gz && "${STORAGE_MODE}" != accounts ]]; then
  LEGACY_ROLLBACK=1
  python3 "${VALIDATOR}" --rollback "${ARCHIVE}" || die "回滚归档校验失败，未修改目标数据"
else
  VALIDATE_ARGS=("${ARCHIVE}")
  [ -z "${CONTENT_KEYRING_FILE}" ] || VALIDATE_ARGS+=(--keyring "${CONTENT_KEYRING_FILE}" --auth-key "${KEY_FILE}")
  python3 "${VALIDATOR}" "${VALIDATE_ARGS[@]}" || die "归档校验失败，未修改目标数据"
fi
# Stage beside data so the eventual directory rename stays on the same filesystem.
STAGE_DIR="$(mktemp -d "${PROJECT_DIR}/.restore-stage.XXXXXX")"
cleanup_stage() {
  # Only this mktemp-owned directory is eligible for cleanup.
  if [ -n "${STAGE_DIR:-}" ] && [ "$(dirname "${STAGE_DIR}")" = "${PROJECT_DIR}" ] && [[ "$(basename "${STAGE_DIR}")" == .restore-stage.* ]]; then
    if [ -d "${STAGE_DIR}" ]; then rm -rf -- "${STAGE_DIR}"; fi
  fi
}
trap 'cleanup_stage; cleanup_input' EXIT
if [ "${LEGACY_ROLLBACK}" -eq 1 ]; then
  python3 "${VALIDATOR}" --extract-legacy "${STAGE_DIR}" "${ARCHIVE}"
else
  EXTRACT_ARGS=("${STAGE_DIR}" "${ARCHIVE}")
  [ -z "${CONTENT_KEYRING_FILE}" ] || EXTRACT_ARGS+=(--keyring "${CONTENT_KEYRING_FILE}" --auth-key "${KEY_FILE}")
  python3 "${VALIDATOR}" --extract "${EXTRACT_ARGS[@]}"
fi
python3 "${VALIDATOR}" --tree "${STAGE_DIR}" "${ARCHIVE}"
if [ "${STORAGE_MODE}" = accounts ]; then
  python3 - "${STAGE_DIR}/donote.db" <<'PYINVALIDATE'
import sqlite3,sys
p=sys.argv[1]; c=sqlite3.connect(p)
try:
 c.execute('PRAGMA foreign_keys=ON')
 c.execute('BEGIN IMMEDIATE')
 c.execute("UPDATE sessions SET revoked_at=COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE revoked_at IS NULL")
 c.execute("UPDATE login_challenges SET consumed_at=COALESCE(consumed_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE consumed_at IS NULL")
 c.execute("UPDATE operation_grants SET consumed_at=COALESCE(consumed_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE consumed_at IS NULL")
 c.execute("UPDATE login_challenges SET consumed_at=COALESCE(consumed_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE consumed_at IS NOT NULL")
 c.execute("UPDATE recovery_codes SET consumed_at=COALESCE(consumed_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE consumed_at IS NULL")
 c.execute('UPDATE users SET security_version=security_version+1')
 c.commit()
 if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or c.execute('PRAGMA foreign_key_check').fetchone() is not None: raise RuntimeError('post-invalidation SQLite check failed')
finally: c.close()
PYINVALIDATE
fi
IMAGE="$(resolve_image)"
docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "应用镜像不存在"
printf '\n将恢复到 %s，输入 yes 确认: ' "${DATA_DIR}"
read -r ANSWER || ANSWER=""
[ "${ANSWER}" = yes ] || die "已取消"
[ ! -L "${DATA_DIR}" ] || die "目标 data 不能是符号链接"
[ ! -e "${DATA_DIR}" ] || [ -d "${DATA_DIR}" ] || die "目标 data 不是目录"
STAMP="$(date '+%Y%m%d-%H%M%S')-$$"
OLD_DIR="${PROJECT_DIR}/.restore-old-${STAMP}"
ROLLBACK="${PROJECT_DIR}/data.rollback-${STAMP}.tar.gz"
[ ! -e "${OLD_DIR}" ] && [ ! -e "${ROLLBACK}" ] || die "回滚路径已存在"
log "停止 app 写入者；其他外部写入者必须事先停止"
docker compose stop app >/dev/null || die "停止 app 失败，未替换数据"
# Any failure below leaves app stopped unless an explicitly checked rollback succeeds.
if [ -d "${DATA_DIR}" ]; then
  if [ "${STORAGE_MODE}" = accounts ]; then
    [ -n "${KEY_FILE:-}" ] || die "账户回滚必须有 AUTH_KEY_FILE"
    ROLLBACK_ARGS=(--key "${KEY_FILE}")
    [ -z "${CONTENT_KEYRING_FILE}" ] || ROLLBACK_ARGS+=(--content-keyring "${CONTENT_KEYRING_FILE}")
    python3 "${PROJECT_DIR}/scripts/lib/sqlite-backup.py" "${DATA_DIR}" "${ROLLBACK}" "${ROLLBACK_ARGS[@]}" --confirmed \
      || die "账户回滚快照创建失败，app 保持停止，原数据未覆盖"
    ROLLBACK_VALIDATE_ARGS=("${ROLLBACK}")
    [ -z "${CONTENT_KEYRING_FILE}" ] || ROLLBACK_VALIDATE_ARGS+=(--keyring "${CONTENT_KEYRING_FILE}" --auth-key "${KEY_FILE}")
    python3 "${VALIDATOR}" "${ROLLBACK_VALIDATE_ARGS[@]}" || die "账户回滚归档无效，app 保持停止，原数据未覆盖"
  else
    docker run --rm -v "${DATA_DIR}:/data:ro" -v "${PROJECT_DIR}:/out" \
      "${IMAGE}" sh -c 'set -e; umask 077; tar czf "/out/$1" -C /data .; chown "$2:$3" "/out/$1"' \
      sh "$(basename "${ROLLBACK}")" "$(id -u)" "$(id -g)" \
      || die "回滚点创建失败，app 保持停止，原数据未覆盖"
    python3 "${VALIDATOR}" --rollback "${ROLLBACK}" || die "回滚归档无效，app 保持停止，原数据未覆盖"
  fi
  mv -- "${DATA_DIR}" "${OLD_DIR}" || die "无法保留旧目录，app 保持停止"
fi
if ! mv -- "${STAGE_DIR}" "${DATA_DIR}"; then
  if [ -d "${OLD_DIR}" ]; then mv -- "${OLD_DIR}" "${DATA_DIR}" || die "旧数据恢复失败，app 保持停止"; fi
  die "替换失败，原数据保留，app 保持停止"
fi
STAGE_DIR=""
healthy() {
  local container status i
  container="$(docker compose ps -q app)" || return 1
  [ -n "${container}" ] || return 1
  for i in {1..20}; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "${container}" 2>/dev/null)" || return 1
    [ "${status}" = healthy ] && return 0
    [ "${status}" = unhealthy ] && return 1
    sleep 2
  done
  return 1
}
if ! docker compose start app >/dev/null || ! healthy; then
  docker compose stop app >/dev/null || die "新数据健康检查失败且停止 app 失败；保留现场，禁止覆盖"
  FAILED_DIR="${PROJECT_DIR}/.restore-failed-${STAMP}"
  [ ! -e "${FAILED_DIR}" ] || die "失败现场目录冲突，app 保持停止"
  mv -- "${DATA_DIR}" "${FAILED_DIR}" || die "无法保存失败现场，app 保持停止"
  if [ -d "${OLD_DIR}" ]; then
    mv -- "${OLD_DIR}" "${DATA_DIR}" || die "无法恢复旧目录，app 保持停止"
    if docker compose start app >/dev/null && healthy; then
      die "恢复失败，已回到原数据并通过健康检查；失败现场: ${FAILED_DIR}"
    fi
  fi
  die "恢复失败，app/旧数据健康状态未确认；请检查保留的目录和回滚归档"
fi
log "恢复成功，健康检查通过"
log "旧目录（如存在）: ${OLD_DIR}；回滚归档（如存在）: ${ROLLBACK}"
