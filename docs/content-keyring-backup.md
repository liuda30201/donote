# Sensitive content key backup/restore contract

Accounts backups now record `requiredContentKeyIds`, the sorted unique IDs actually used by sensitive messages. They never include content keys or key fingerprints. This is a data dependency inventory, not proof of authenticity: every sensitive payload is independently decrypted and authenticated before backup publication and before restored data can replace the live tree.

The optional `SENSITIVE_KEYRING_FILE` must match the E02 contract: an external, real-path, regular single-link mode-0600 JSON file with exact shape `{ "version": 1, "activeKeyId": "...", "keys": { "id": "canonical-base64-32-byte-key" } }`. There is no default key or automatic key recovery. A tree with no sensitive records may omit the keyring. Missing historical keys, a wrong key under an existing ID, malformed records, plaintext residue, and any GCM authentication failure are fatal.

The checker scans only `users/<directory-user-id>/messages.json`. It uses the directory name and each record ID as the trusted E01 AAD context. A sensitive record must be text, have `content: null`, `remark: ""`, and carry an E01 `encryptedPayload` whose two envelopes use the same key ID. Its content and remark are both authenticated. Successful restore validation reports only counts and IDs; it never prints plaintext or key material.

Backup and restore refuse any data-root entry whose name begins `.sensitive-rotation`, including unpublished rotation staging directories. Those directories may contain complete old/new user states requiring retired key IDs and must first be moved to protected storage outside the data root. Do not delete them as part of backup. Keep old keys while any retained backup or journal depends on them.

All backup consistency claims remain subject to the accounts offline requirement: stop app, cleanup, workers, and external writers before taking the SQLite snapshot and accompanying files. SQLite's online backup API gives a consistent database snapshot; it does not make SQLite and JSON/files simultaneous. Inventory comparison detects changes but is not a write barrier.

Synthetic tests (no real data or key material):

```sh
python3 app/test/verifier-review/content_keyring_backup.py -v
node --check scripts/lib/content-backup.js
python3 -m py_compile scripts/lib/sqlite-backup.py scripts/lib/restore-validate.py
bash -n scripts/backup.sh scripts/restore.sh
```
