#!/usr/bin/env bash
# =============================================================================
# web-clipboard —— 从备份恢复
#
# 用法：
#   ./scripts/restore.sh                 # 列出可用备份
#   ./scripts/restore.sh backup/web-clipboard-YYYYmmdd-HHMMSS.tar.gz
#
# 行为：
#   1. 恢复前以容器 root 把“当前 data/”整体打包成回滚点
#      data.rollback-<时间戳>.tar.gz（普通用户 wt 无法直接复制 root 属主的附件）
#   2. 停止 app 容器（nginx 保持运行，仅短暂 502）
#   3. 清空并解包归档到 data/
#   4. 重新启动 app 并等待健康检查通过
#
# 回滚到恢复前的状态：
#   ./scripts/restore.sh data.rollback-20261013-070000.tar.gz
# =============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${PROJECT_DIR}/data"
cd "${PROJECT_DIR}"

IMAGE="${IMAGE:-web-clipboard-local:1.6.8-p1}"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

ARCHIVE="${1:-}"

if [ -z "${ARCHIVE}" ]; then
  log "可用备份："
  # 用 nullglob 避免某个 glob 无匹配时 ls 报错，导致误报“未找到备份”
  shopt -s nullglob
  FOUND=("${PROJECT_DIR}"/backup/web-clipboard-*.tar.gz "${PROJECT_DIR}"/data.rollback-*.tar.gz)
  shopt -u nullglob
  if [ "${#FOUND[@]}" -gt 0 ]; then
    ls -lht "${FOUND[@]}"
  else
    log "（未找到备份，请先执行 ./scripts/backup.sh）"
  fi
  echo
  echo "用法: $0 <备份文件路径>"
  exit 0
fi

[ -f "${ARCHIVE}" ] || die "备份文件不存在: ${ARCHIVE}"
ARCHIVE="$(readlink -f "${ARCHIVE}")"
ARCHIVE_DIR="$(dirname "${ARCHIVE}")"
ARCHIVE_BASE="$(basename "${ARCHIVE}")"
tar -tzf "${ARCHIVE}" >/dev/null || die "备份文件损坏，无法读取: ${ARCHIVE}"

docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "镜像不存在: ${IMAGE}"

log "备份内容预览（前 10 项）："
tar -tzf "${ARCHIVE}" | head -10

printf '\n确认从该备份恢复？将覆盖 %s 下的全部数据。输入 yes 继续: ' "${DATA_DIR}"
read -r ANSWER
[ "${ANSWER}" = "yes" ] || die "已取消"

# ---- 1. 建立回滚点（容器 root 打包，普通用户无法读取 root 属主附件）----
ROLLBACK_NAME="data.rollback-$(date '+%Y%m%d-%H%M%S').tar.gz"
docker run --rm \
  -v "${DATA_DIR}:/data:ro" \
  -v "${PROJECT_DIR}:/out" \
  "${IMAGE}" sh -c "tar czf '/out/${ROLLBACK_NAME}' -C /data ." 2>/dev/null || true
if [ -f "${PROJECT_DIR}/${ROLLBACK_NAME}" ]; then
  docker run --rm -v "${PROJECT_DIR}:/out" "${IMAGE}" sh -c \
    "chown 1000:1000 '/out/${ROLLBACK_NAME}'" 2>/dev/null || true
  log "已保存回滚点: ${PROJECT_DIR}/${ROLLBACK_NAME}"
else
  log "警告: 回滚点创建失败（原 data 可能为空）"
fi

# ---- 2. 停止应用 ----
log "停止 app 容器"
docker compose stop app >/dev/null

# ---- 3. 清空并解包 ----
log "解包备份到 ${DATA_DIR}"
docker run --rm \
  -v "${DATA_DIR}:/data" \
  -v "${ARCHIVE_DIR}:/in:ro" \
  "${IMAGE}" sh -c "
    set -e
    rm -rf /data/* /data/.[!.]* 2>/dev/null || true
    mkdir -p /data
    tar xzf '/in/${ARCHIVE_BASE}' -C /data
    ls /data
  "

[ -f "${DATA_DIR}/messages.json" ] || [ -d "${DATA_DIR}/uploads" ] \
  || die "恢复后 data/ 中既无 messages.json 也无 uploads/，归档结构可能不符合预期"

# ---- 4. 启动并检查 ----
log "启动 app 容器"
docker compose start app >/dev/null

STATUS=unknown
for _ in $(seq 1 20); do
  STATUS="$(docker inspect --format '{{.State.Health.Status}}' wcb-app 2>/dev/null || echo unknown)"
  [ "${STATUS}" = "healthy" ] && break
  sleep 2
done
log "wcb-app 健康状态: ${STATUS}"

COUNT="$(python3 -c "
import json,sys
try:
    print(len(json.load(open(sys.argv[1],encoding='utf-8')).get('messages',[])))
except Exception:
    print('?')
" "${DATA_DIR}/messages.json" 2>/dev/null || echo '?')"
log "恢复完成，消息记录条数: ${COUNT}"
log "如需回滚: $0 ${ROLLBACK_NAME}"
