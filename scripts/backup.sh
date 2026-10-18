#!/usr/bin/env bash
# =============================================================================
# DoNote O01 — complete JSON/file backup foundation (no restore or DB snapshot).
# Legacy messages.json, .mode, uploads/, shares/ and all users/ are inventoried;
# backup-manifest.json records format/version, paths, modes and SHA-256 hashes.
# Stop ALL writers and cleanup tasks first. Change detection is not a write barrier.
#
# Usage: ./scripts/backup.sh              # keep newest 14 successful archives
#        KEEP=30 ./scripts/backup.sh      # count, not days; positive integer
# Synthetic fixtures / readable host data only (explicit opt-in, requires Node):
#        BACKUP_MODE=local DATA_DIR=/tmp/fixture BACKUP_DIR=/tmp/backups ./scripts/backup.sh
# Default Docker mode retains root access to historical attachment ownership;
# data and helper are read-only mounts. No app stop/start is performed here.
# =============================================================================
set -euo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

DATA_DIR="${DATA_DIR:-${PROJECT_DIR}/data}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backup}"
KEEP="${KEEP:-14}"
BACKUP_MODE="${BACKUP_MODE:-docker}"
HELPER="${PROJECT_DIR}/scripts/lib/backup-data.js"
ARCHIVE_NAME="web-clipboard-$(date '+%Y%m%d-%H%M%S')-$$.tar.gz"

[ -f "${HELPER}" ] || die "备份辅助程序不存在: ${HELPER}"
if [ "${1:-}" = "--accounts-offline-confirmed" ]; then
  [ "${AUTH_MODE:-}" = accounts ] || die "账户备份必须 AUTH_MODE=accounts"
  [ "${#}" -eq 1 ] || die "不接受账户备份额外位置参数"
  KEY_FILE="${AUTH_KEY_FILE:-}"
  [ -n "${KEY_FILE}" ] || die "账户备份必须指定 AUTH_KEY_FILE"
  command -v python3 >/dev/null 2>&1 || die "账户备份需要 python3 sqlite3"
  CONTENT_ARGS=()
  [ -z "${SENSITIVE_KEYRING_FILE:-}" ] || CONTENT_ARGS+=(--content-keyring "${SENSITIVE_KEYRING_FILE}")
  exec python3 "${PROJECT_DIR}/scripts/lib/sqlite-backup.py" "${DATA_DIR}" "${BACKUP_DIR}/${ARCHIVE_NAME}" --key "${KEY_FILE}" --key-id "${AUTH_KEY_ID:-primary}" "${CONTENT_ARGS[@]}" --confirmed
fi
# Never silently publish a JSON-only archive for an accounts database.
[ "${AUTH_MODE:-legacy}" != accounts ] || die "账户模式 SQLite 备份尚未支持；请使用 --accounts-offline-confirmed"
for SQLITE_FILE in donote.db donote.db-wal donote.db-shm; do
  [ ! -e "${DATA_DIR}/${SQLITE_FILE}" ] && [ ! -L "${DATA_DIR}/${SQLITE_FILE}" ] \
    || die "检测到 SQLite 数据；本工具只支持 legacy，需受控停写与数据库快照"
done
if [ -n "${AUTH_KEY_FILE:-}" ]; then
  python3 - "${DATA_DIR}" "${AUTH_KEY_FILE}" <<'PYKEY'
import os,sys
root, key = map(os.path.realpath, sys.argv[1:])
if os.path.commonpath([root, key]) == root:
    sys.exit('AUTH_KEY_FILE must remain outside the data backup tree')
PYKEY
fi
command -v python3 >/dev/null 2>&1 || die "需要 python3 校验路径及轮转备份"
case "${BACKUP_MODE}" in
  docker)
    IMAGE="$(resolve_image)"
    docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "镜像不存在: ${IMAGE}"
    ;;
  local) command -v node >/dev/null 2>&1 || die "local 模式需要 node" ;;
  *) die "BACKUP_MODE 必须为 docker 或 local" ;;
esac

# Validate before chmod, mkdir, packaging, or retention; never write into data.
python3 - "${DATA_DIR}" "${BACKUP_DIR}" "${KEEP}" <<'PY'
import os, re, sys
source, output, keep = sys.argv[1:]
if not re.fullmatch(r'[1-9][0-9]{0,5}', keep):
    sys.exit('KEEP must be a positive integer (1..999999)')
source, output = os.path.realpath(source), os.path.realpath(output)
if not os.path.isdir(source):
    sys.exit('Data directory does not exist')
if os.path.commonpath([source, output]) in (source, output):
    sys.exit('Data and backup directories must be disjoint')
os.makedirs(output, mode=0o700, exist_ok=True)
os.chmod(output, 0o700)
PY
DATA_DIR="$(cd "${DATA_DIR}" && pwd -P)"
BACKUP_DIR="$(cd "${BACKUP_DIR}" && pwd -P)"
ARCHIVE="${BACKUP_DIR}/${ARCHIVE_NAME}"
log "开始备份 → ${ARCHIVE}（请先停止全部写入者）"

if [ "${BACKUP_MODE}" = docker ]; then
  docker run --rm --user 0:0 --network none --entrypoint node \
    -e BACKUP_UID="$(id -u)" -e BACKUP_GID="$(id -g)" \
    -v "${DATA_DIR}:/data:ro" \
    -v "${BACKUP_DIR}:/backup" \
    -v "${HELPER}:/backup-helper.js:ro" \
    "${IMAGE}" /backup-helper.js /data "/backup/${ARCHIVE_NAME}"
else
  # Avoid inherited ownership overrides when running as an ordinary host user.
  BACKUP_UID="$(id -u)" BACKUP_GID="$(id -g)" node "${HELPER}" "${DATA_DIR}" "${ARCHIVE}"
fi
[ -f "${ARCHIVE}" ] || die "备份程序未生成归档: ${ARCHIVE}"

# Runs only after successful packaging, verification and publication. No shell
# word splitting or Bash 4 mapfile dependency; only exact regular archive names.
python3 - "${BACKUP_DIR}" "${ARCHIVE_NAME}" "${KEEP}" <<'PY'
import os, re, stat, sys
root, current, keep = sys.argv[1], sys.argv[2], int(sys.argv[3])
root = os.path.realpath(root)
pattern = re.compile(r'web-clipboard-[0-9]{8}-[0-9]{6}(?:-[0-9]+)?\.tar\.gz')
archives = []
for name in os.listdir(root):
    if not pattern.fullmatch(name):
        continue
    target = os.path.join(root, name)
    metadata = os.lstat(target)
    if stat.S_ISREG(metadata.st_mode):
        archives.append((name, metadata.st_mtime_ns))
archives.sort(key=lambda item: (item[0] == current, item[1], item[0]), reverse=True)
for name, _ in archives[keep:]:
    target = os.path.join(root, name)
    if os.path.dirname(os.path.realpath(target)) != root or not stat.S_ISREG(os.lstat(target).st_mode):
        sys.exit('Unsafe retention target; refusing deletion')
    os.unlink(target)
    print('Removed expired backup: ' + name)
print('Retained successful archives: ' + str(min(len(archives), keep)))
PY
log "备份完成: ${ARCHIVE}"
