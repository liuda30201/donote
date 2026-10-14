#!/usr/bin/env bash
# 只检查代码和配置，不启动/重建容器，也不访问真实数据或密码。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

for script in "${PROJECT_DIR}"/scripts/*.sh "${PROJECT_DIR}"/scripts/lib/*.sh; do
  bash -n "${script}"
done
log "Shell 语法检查通过"

python3 - "${PROJECT_DIR}" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
package = json.loads((root / 'app/package.json').read_text())
lock = json.loads((root / 'app/package-lock.json').read_text())
for key in ('name', 'version'):
    assert package[key] == lock[key] == lock['packages'][''][key], key
assert package['license'] == lock['packages']['']['license']
assert package['dependencies'] == lock['packages']['']['dependencies']
for filename in (root / 'app/public').glob('*.json'):
    json.loads(filename.read_text())
print('JSON 与依赖锁文件检查通过')
PY

ACCESS_PASSWORD=__config_check__ docker compose \
  --project-directory "${PROJECT_DIR}" --env-file "${PROJECT_DIR}/.env.example" \
  -f "${PROJECT_DIR}/docker-compose.yml" config --quiet
log "Compose 配置检查通过"

if command -v node >/dev/null 2>&1; then
  node "${PROJECT_DIR}/scripts/check-js.js"
else
  log "未安装 Node.js，跳过 JavaScript 检查；可使用开发文档中的容器命令"
fi
