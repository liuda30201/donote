# Accounts 配额运行时接线

账户模式在 HTTP/Socket 开始监听前配置 [quota-runtime.js](../app/src/quota-runtime.js)，共用 quota 服务的一条 per-user FIFO mutation queue。消息、备注、收藏、敏感状态转换、multipart/Data URL 附件、删除、清空和过期/孤儿清理均使用该队列；不同用户可并行。运行时只支持单 Node 写进程。

`DONOTE_DEFAULT_QUOTA_BYTES` 未设置时为 1073741824。配置须为非负安全整数的十进制；账户 `storage_quota_bytes=0` 采用全局默认。所有未删除账户在启动时扫描实际 JSON 文件和 uploads 内全部普通文件，并写回 `storage_bytes`；扫描或 DB 更新失败拒绝 listen。损坏账户 JSON 不再以空状态继续启动，也不移动或覆盖原件。

[storage.js](../app/src/storage.js) 的 `configurePersistencePolicy` 将校验放在持久化之前：队列开始时测量基线，变更生成后按 `Buffer.byteLength(JSON.stringify(candidate, null, 2)) + uploadsBytes` 准入，再检查磁盘余量。超额账户允许不增加物理用量的变更；拒绝候选时内存和原 JSON 不变。附件在失败时删除本操作拥有的未发布文件，在释放用户锁之前完成回滚。空目录不占用计量字节，也不要求回滚删除。

持久化使用独占 0600 sibling temp、FileHandle.sync 与 rename。JSON durable 后才发布内存、保留附件和广播。SQLite usage 属于可重建的派生记录：若 durable 后更新失败，保留已提交 JSON/附件并阻止该用户后续写入；重启成功 reconcile 后恢复。不能以删除附件来补偿已经 durable 的 JSON。队列退出时再次扫描，因此删除/清空/过期清理只有实际 unlink 成功的文件才释放用量。孤儿文件删除前仍计入。

上传内建 admission 与 storage policy 是对同一候选的重复校验，不修改或预扣 usage，不存在双扣。上传发布前测量 baseline，上传后的 JSON 与文件实测总字节用于最终准入。全局 upload limiter 与 per-user mutation queue 是不同职责，不得在相同用户队列内部再次获取该用户锁。

验证入口：

```sh
node --test app/test/quota.test.js app/test/quota-storage.test.js app/test/quota-upload.test.js app/test/quota-http.test.js
```

真实 HTTP 覆盖范围和最新通过结果以最终验证记录为准。上述机制不提供多进程互斥，也不能使 SQLite 与 JSON/文件系统构成单一原子事务；重启 reconcile 是明确的恢复边界。
