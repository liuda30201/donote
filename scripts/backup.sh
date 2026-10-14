#!/usr/bin/env bash
# =============================================================================
# web-clipboard —— 备份消息记录与附件
#
# 备份内容：
#   data/messages.json   消息记录（文本/图片/文件的元数据、备注、时间戳）
#   data/uploads/        全部附件（原图、缩略图、上传文件）
#   data/shares/         分享数据（功能已禁用，存在则一并备份）
#
# 为什么用容器来打包：
#   附件的实际属主取决于运行容器与历史迁移，普通宿主机用户可能无法读取/删除。
#   本脚本用同一个应用镜像（tag 见 IMAGE 变量）以 root 身份挂载 data/ 打包，
#   从而无需 sudo。只读挂载数据目录，不会修改原数据。
#
# 一致性保证：
#   * 应用对 messages.json 采用“先写临时文件再 rename”的原子落盘，且写入带约
#     500ms 防抖 —— 因此任何时刻读到的 messages.json 都是完整的 JSON。
#     脚本在打包前会先校验其可解析性，不可解析则重试 5 次。
#   * 先打包 uploads/ 再打包 messages.json。在线备份期间仍可能发生新增/删除，
#     因此不是严格时间点快照；需要严格一致性时先 docker compose stop app。
#   * 打包清单使用 NUL 分隔（find -print0 + tar --null），文件名含换行也不会被拆断。
#   * 备份期间应用保持运行，不需要停机。
#
# 用法：
#   ./scripts/backup.sh                 # 备份到 ./backup/web-clipboard-<时间戳>.tar.gz
#   KEEP=30 ./scripts/backup.sh         # 保留最近 30 份（默认 14）
#
# 建议定时任务（每天 03:17 备份）：
#   17 3 * * * /home/liuqiang/workspace/web-clipboard/scripts/backup.sh >> /home/liuqiang/workspace/web-clipboard/backup/backup.log 2>&1
# =============================================================================
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
DATA_DIR="${PROJECT_DIR}/data"
BACKUP_DIR="${PROJECT_DIR}/backup"
STAMP="$(date '+%Y%m%d-%H%M%S')"
ARCHIVE_NAME="web-clipboard-${STAMP}.tar.gz"
ARCHIVE="${BACKUP_DIR}/${ARCHIVE_NAME}"
KEEP="${KEEP:-14}"

# ---- 解析实际使用的 app 镜像 ----
# 优先用显式传入的 IMAGE；否则从 docker compose 的解析结果里读，保证与
# docker-compose.yml 里 app 服务的镜像 tag 始终一致（硬编码 tag 会在旧镜像被
# docker image prune 清掉后导致备份直接失败）。

[ -d "${DATA_DIR}" ] || die "数据目录不存在: ${DATA_DIR}"

IMAGE="$(resolve_image)"
docker image inspect "${IMAGE}" >/dev/null 2>&1 || die "镜像不存在: ${IMAGE}（请先 docker compose build app）"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# ---- 1. 校验 messages.json 可解析（原子写入期间可能短暂不可用，重试 5 次）----
if [ -f "${DATA_DIR}/messages.json" ]; then
  ok=0
  for i in 1 2 3 4 5; do
    if python3 -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" \
         "${DATA_DIR}/messages.json" 2>/dev/null; then
      ok=1; break
    fi
    log "messages.json 暂不可解析（第 ${i} 次），1 秒后重试…"
    sleep 1
  done
  [ "${ok}" = "1" ] || die "messages.json 无法解析，已中止备份以免产生损坏的归档"
fi

MSG_COUNT="$(python3 -c "
import json,sys
try:
    print(len(json.load(open(sys.argv[1],encoding='utf-8')).get('messages',[])))
except Exception:
    print('unknown')
" "${DATA_DIR}/messages.json" 2>/dev/null || echo unknown)"

# ---- 2. 容器内以 root 打包（先 uploads/ 后 messages.json）----
log "开始备份 → ${ARCHIVE}"

docker run --rm \
  -v "${DATA_DIR}:/data:ro" \
  -v "${BACKUP_DIR}:/backup" \
  "${IMAGE}" \
  sh -c '
    set -e
    cd /data
    # 用 NUL 分隔的清单，避免文件名含换行时被 tar 拆成两条路径
    { [ -d uploads ] && find uploads -type f -print0; } > /tmp/list
    { [ -d shares ]  && find shares  -type f -print0; } >> /tmp/list
    [ -f messages.json ] && printf "messages.json\0" >> /tmp/list
    tar czf "/backup/'"${ARCHIVE_NAME}"'" --null --no-recursion -T /tmp/list
  '

# ---- 3. 收尾：属主归当前用户、校验归档可读 ----
docker run --rm -v "${BACKUP_DIR}:/backup" "${IMAGE}" sh -c \
  "chown $(id -u):$(id -g) '/backup/${ARCHIVE_NAME}' && chmod 600 '/backup/${ARCHIVE_NAME}'" 2>/dev/null \
  || chmod 600 "${ARCHIVE}"

tar -tzf "${ARCHIVE}" >/dev/null || die "归档校验失败: ${ARCHIVE}"
SIZE="$(du -h "${ARCHIVE}" | cut -f1)"
log "备份完成: ${ARCHIVE} (${SIZE}, 消息 ${MSG_COUNT} 条, 归档条目 $(tar -tzf "${ARCHIVE}" | wc -l) 个)"

# ---- 4. 轮转：只保留最近 KEEP 份 ----
mapfile -t OLD < <(ls -1t "${BACKUP_DIR}"/web-clipboard-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
if [ "${#OLD[@]}" -gt 0 ]; then
  log "清理 ${#OLD[@]} 个过期备份（保留最近 ${KEEP} 份）"
  rm -f -- "${OLD[@]}"
fi

log "当前备份列表："
ls -lht "${BACKUP_DIR}"/web-clipboard-*.tar.gz 2>/dev/null | head -"${KEEP}"
