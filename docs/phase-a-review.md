# 阶段 A 独立复核报告

> 复核范围：O01 备份、O02 恢复、独立验证夹具。
> 复核者：verifier 角色。
> 数据范围：仅合成临时目录；未读取项目 `data/`，未访问生产数据。
> 结论：合成安全边界复核通过；真实 Docker 运行时验证阻塞，不能据此宣称已完成生产恢复验收。

## 1. 复核内容

检查了：

- `scripts/backup.sh` 与 `scripts/lib/backup-data.js` 的目录清单、排除规则、SHA-256 manifest、复制后二次清单和发布方式。
- `scripts/restore.sh` 与 `scripts/lib/restore-validate.py` 的路径规范化、重复成员、链接/特殊文件拒绝、manifest 对账、消息 JSON、附件引用、暂存提取、旧目录保留、健康失败回退。
- `app/test/verifier/backup-recovery-fixtures.test.js` 统一入口及其独立 Python 合成 Docker 替身。
- 新增的 `app/test/verifier-review/backup_boundary_review.py` 和 `restore_health_failure.py`。

## 2. 已复现并修复的问题

初始独立实验复现了以下缺陷，修复后重新验证通过：

1. 备份 helper 将路径中任意 `temp` 目录排除，导致合法用户 `users/temp` 和真实 `uploads/temp/...` 附件遗漏。
2. 备份 helper 将任意 `messages.json.tmp` 排除，导致真实附件同名时遗漏。
3. 消息引用的附件缺失时，备份仍可成功发布。
4. 归档 manifest/hash 自洽但消息引用附件缺失时，恢复校验仍可成功。
5. restore 校验曾错误使用 `lstrip('./')` 风格的路径处理，可能把非法前缀误当作安全路径；现已使用逐段去除 `./` 和规范化后的重复/逃逸检查。
6. `--tree` 参数计数与实际参数不一致；已修正并加入真实 CLI 调用。

相关独立复现命令：

```bash
python3 app/test/verifier-review/backup_boundary_review.py -v
```

当前结果：6 项通过。覆盖用户 ID 为 `temp`、附件路径含 `temp`、真实附件名 `messages.json.tmp`、缺失附件拒绝、宿主机原生 tar 往返、manifest 自洽但附件缺失拒绝。

## 3. 健康检查失败复核

使用隔离 Docker 替身注入“新数据启动 unhealthy、旧数据恢复后 healthy”：

```bash
python3 app/test/verifier-review/restore_health_failure.py -v
```

结果：1 项通过。验证了：

- 新数据健康检查失败后 restore 返回失败。
- 新数据目录保留为 `.restore-failed-*`，便于诊断。
- 旧数据目录恢复回 `data/`。
- 旧 app 停止后重新启动并再次健康检查。
- 目标原始数据快照与恢复前一致。

现有统一入口也已改为带超时的 Node 测试，调用独立 Python 套件；既有 23 项合成验收通过，避免维护两套不一致的 Docker 模拟逻辑。

## 4. 安全不变量审查结果

通过的边界：

- 归档成员拒绝绝对路径、`..` 逃逸、符号链接、硬链接和特殊文件。
- 规范化后重复路径拒绝，manifest 必须覆盖实际归档成员，文件大小和 SHA-256 必须一致。
- 空归档、缺少消息文件、无效消息 JSON、用户目录缺少对应 `messages.json` 会被拒绝。
- 消息中的文件/图片附件引用必须解析到对应用户的 `uploads/` 文件；不能只相信 manifest 自洽。
- 暂存目录必须为空，提取后再次按 manifest 校验；目标数据在确认、验证和回滚点完成前不覆盖。
- 健康检查失败时保留失败现场并尝试恢复旧目录，恢复结果必须再次健康检查。
- 备份通过临时目录、复制后 hash 检查、二次 inventory 和原子硬链接发布，失败不会发布半成品。
- 应用临时工作区仅排除根 `temp/` 及约定的根/用户消息原子临时文件；合法用户和附件路径中的 `temp` 不再被误排除。

## 5. 尚未完成或无法在本环境验证的内容

### 5.1 真实 Docker 运行时

执行：

```bash
docker info --format '{{.ServerVersion}}'
```

结果失败：Docker API `unix:///Users/liu/.orbstack/run/docker.sock` 不存在。因而本次无法验证：

- 目标应用镜像是否存在且可启动。
- 目标镜像内 tar/gzip 对 rollback positional 参数的实际支持。
- 容器 root 读取旧附件、chown 回滚归档和宿主机目录 rename 的实际权限。
- Compose `stop/start/ps` 和 healthcheck 的真实行为。
- Nginx、app 写入者和外部清理任务是否确实全部停止。

这不是合成测试失败，但必须在可用 Docker/目标 CPU 环境补做，不能把 Python 替身结果当作真实容器验收。

### 5.2 停写和源数据一致性

helper 的双 inventory 与文件 hash 只能检测部分备份期间变化，不能构成写屏障。正式备份前仍必须停止 app、清理任务和其他写入者；若无法建立写屏障，应拒绝宣称一致快照。

### 5.3 归档输入竞态

该问题已由 restore 修复：脚本在解析用户指定路径后，先复制到项目目录下受控的 `.restore-input.XXXXXX.tar.gz` 临时快照；后续归档校验、提取和 tree 校验全部使用该快照 inode，退出时删除快照。这样可避免验证完成后原始归档路径被替换导致后续步骤处理另一份内容。

本次复核命令：

```bash
bash -n scripts/restore.sh
python3 -m py_compile scripts/lib/restore-validate.py
python3 app/test/verifier-review/backup_boundary_review.py -v
python3 app/test/verifier-review/restore_health_failure.py -v
node --test app/test/verifier/backup-recovery-fixtures.test.js
```

结果：脚本/验证器语法检查通过；独立边界测试 6/6 通过；健康失败回退测试 1/1 通过；统一合成恢复入口 1/1 通过。以上仍是合成环境验证，不替代真实 Docker 镜像测试。

### 5.4 回滚归档语义

自动回退优先使用保留的旧目录并再次健康检查。restore 现已根据 `data.rollback-*.tar.gz` 文件名进入 legacy rollback 分支，使用 `--rollback` 校验及 `--extract-legacy` 提取；普通带 manifest 的备份继续使用标准校验和提取流程。回滚归档仍需在真实目标镜像环境验证 tar、权限和人工恢复操作。

## 6. 阶段 A 结论

在合成临时数据和隔离 Docker 替身范围内，O01/O02 的路径安全、manifest 完整性、附件引用和健康失败回退达到试行通过条件。建议状态标记为：

> **阶段 A：合成验收通过，真实 Docker 验证阻塞，禁止直接生产发布。**

进入 D01 数据库基础前，lead 应保留本报告、收集 23 项统一夹具结果，并在 Docker 可用后补做真实镜像恢复演练。前端现有样式和既有用户改动本轮未修改。
