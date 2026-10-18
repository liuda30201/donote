#!/usr/bin/env bash
# 共享运维配置；仅定义变量与函数，source 时不执行 Docker 操作。
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { printf '错误: %s\n' "$*" >&2; exit 1; }

# IMAGE 可显式覆盖，否则以 Compose 配置为唯一来源。
# 使用占位密码解析配置，避免读取或输出真实访问密码。
resolve_image() {
  if [ -n "${IMAGE:-}" ]; then
    printf '%s' "${IMAGE}"
    return 0
  fi
  local from_compose compose_file
  compose_file="${PROJECT_DIR}/docker-compose.yml"
  if [ "${AUTH_MODE:-legacy}" = accounts ]; then
    compose_file="${PROJECT_DIR}/docker-compose.accounts.yml"
  fi
  from_compose="$(ACCESS_PASSWORD=__config_check__ docker compose \
    --project-directory "${PROJECT_DIR}" --env-file "${PROJECT_DIR}/.env.example" \
    -f "${compose_file}" config --format json \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['services']['app']['image'])")" \
    || die "无法从 Compose 解析应用镜像；请检查配置，或显式设置 IMAGE"
  [ -n "${from_compose}" ] || die "Compose 中未配置应用镜像"
  printf '%s' "${from_compose}"
}
