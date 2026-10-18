# SQLite 备份一致性边界（O04 当前交付）

本轮仅修复数据丢失风险，未伪造 SQLite 成功备份路径。

## 当前结论

现有 `backup-data.js` 是 legacy JSON/附件备份器，不是 SQLite 快照工具。只要数据根目录检测到 `donote.db`、`donote.db-wal` 或 `donote.db-shm`，或 `AUTH_MODE=accounts`，备份立即 fail-closed，且归档不会发布。`AUTH_KEY_FILE` 位于数据树内也会拒绝，密钥不会进入普通归档。

`backup.sh` 同样在生成归档前检查这些条件；无 SQLite CLI 或受控 checkpoint/online-backup API 时，不会把普通逐文件复制伪装成 SQLite 备份。账户模式必须等待后续受控实现。

恢复校验器拒绝：

- 归档内任何 SQLite 主库或 WAL/SHM 成员；
- `storageMode`/`mode`/`authMode` 声明为 accounts、SQLite 或 mixed 的 manifest；
- legacy manifest 携带 `sqliteSnapshot`、`schemaVersion` 或 `keyId` 元数据；
- 原始 rollback 归档中混入 SQLite 文件。

这避免了“manifest 自洽但缺少主库”的假成功，也避免 legacy JSON 恢复覆盖账户数据。旧 legacy 归档仍按原路径校验和恢复。

## 当前未完成

尚未实现 SQLite 成功备份。要开放该路径，必须先停止 app 及所有写入者，确认连接关闭，执行受控 `PRAGMA wal_checkpoint(TRUNCATE)` 或 SQLite online backup/VACUUM INTO，生成单一稳定快照，并在 manifest 记录 `storageMode=sqlite-checkpoint`、schema/migration 版本、快照状态和不含原始密钥的 `keyId`。恢复前还要做 SQLite integrity/schema/pragma、外部 32 字节 `AUTH_KEY_FILE` 权限及 keyId 检查，成功后才替换数据。

当前没有 sqlite3 CLI 或等价受控快照能力时，必须维持拒绝；不得通过复制 `donote.db`、WAL 和 SHM 三个文件来绕过。

## 合成验证

```bash
python3 app/test/verifier-review/sqlite_backup_fix.py -v
```

8 项临时目录测试覆盖真实 WAL 数据库、孤立 sidecar、accounts 模式、缺主库 manifest、自洽元数据伪装、rollback 混入 SQLite、数据树内 key，以及 legacy 正常备份恢复。测试不访问生产数据。
