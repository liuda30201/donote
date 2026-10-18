#!/usr/bin/env python3
"""Validate DoNote backup archives and extracted trees without writing them."""
import hashlib
import json
import os
import posixpath
import stat
import sys
import tarfile
import tempfile
import subprocess


def fail(message):
    raise SystemExit(message)


def canonical(name):
    if not isinstance(name, str) or not name:
        fail("归档成员名称为空")
    if "\\" in name or "\x00" in name:
        fail(f"归档成员名称非法: {name!r}")
    if name.startswith("/") or name.startswith("../") or "/../" in name or name.endswith("/.."):
        fail(f"拒绝逃逸路径: {name}")
    value = name
    while value.startswith("./"):
        value = value[2:]
    value = posixpath.normpath(value)
    if value in ("", "."):
        return ""
    if value == ".." or value.startswith("../") or value.startswith("/"):
        fail(f"拒绝逃逸路径: {name}")
    return value


def digest(stream):
    h = hashlib.sha256()
    size = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        h.update(chunk)
    return size, h.hexdigest()


def archive_entries(tf):
    entries = {}
    for member in tf.getmembers():
        name = canonical(member.name)
        if not name:
            continue
        if name in entries:
            fail(f"归档含重复成员: {name}")
        if member.issym() or member.islnk():
            fail(f"归档含链接: {member.name}")
        if not (member.isdir() or member.isfile()):
            fail(f"归档含特殊文件: {member.name}")
        entries[name] = member
    return entries


def reject_sqlite(entries, manifest=None):
    if any(posixpath.basename(name) in ("donote.db-wal", "donote.db-shm") for name in entries):
        fail("SQLite WAL/SHM 不得直接进入归档")
    if any(posixpath.basename(name) == "donote.db" for name in entries) and manifest is not None and manifest.get("storageMode") != "accounts":
        fail("SQLite 主库必须声明 accounts 模式")
    if manifest is not None:
        if not isinstance(manifest, dict):
            fail("manifest 必须为对象")
        if manifest.get("storageMode", "legacy") not in ("legacy", "accounts"):
            fail("未知账户存储模式，拒绝恢复")
        if manifest.get("storageMode", "legacy") == "legacy" and (manifest.get("mode", "legacy") != "legacy" or manifest.get("authMode", "legacy") != "legacy" or any(key in manifest for key in ("sqliteSnapshot", "schemaVersion", "keyId"))):
            fail("SQLite 元数据不能作为 legacy 归档恢复")


def read_manifest(tf, entries):
    reject_sqlite(entries)
    manifest_member = entries.get("backup-manifest.json")
    if manifest_member is None:
        return {name: {"path": name, "type": "directory" if member.isdir() else "file",
                       **({"size": member.size, "sha256": digest(tf.extractfile(member))[1]} if member.isfile() else {})}
                for name, member in entries.items()}
    if not manifest_member.isfile():
        fail("backup-manifest.json 必须是普通文件")
    raw = tf.extractfile(manifest_member).read()
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        fail(f"manifest JSON 无效: {exc}")
    reject_sqlite(entries, manifest)
    if manifest.get("format") != "donote-backup" or manifest.get("formatVersion") not in (1, 2):
        fail("不支持的备份格式")
    if manifest.get("storageMode", "legacy") == "accounts":
        if manifest.get("formatVersion") != 2 or manifest.get("consistency") != "sqlite-offline-backup":
            fail("accounts manifest consistency 无效")
        snapshot = manifest.get("sqliteSnapshot")
        if not isinstance(snapshot, dict) or snapshot.get("path") != "donote.db" or snapshot.get("integrityCheck") != "ok" or snapshot.get("foreignKeyCheck") != "ok":
            fail("accounts manifest 缺少有效 SQLite snapshot")
        if not manifest.get("requiresExternalAuthKey") or not isinstance(manifest.get("keyFingerprint"), str) or len(manifest["keyFingerprint"]) != 64:
            fail("accounts manifest 缺少外部 key 指纹")
        ids = manifest.get('requiredContentKeyIds')
        if not isinstance(ids, list) or any(not isinstance(item, str) or not item for item in ids) or ids != sorted(set(ids)):
            fail('accounts manifest requiredContentKeyIds 无效')
        # Accounts archives are explicitly supported; continue with common hash checks.
    elif manifest.get("formatVersion") != 1:
        fail("非 accounts 归档必须使用 formatVersion 1")
    if manifest.get("checksumAlgorithm") != "sha256":
        fail("不支持的校验算法")
    listed = {}
    for item in manifest.get("entries", []):
        if not isinstance(item, dict) or item.get("path") in listed:
            fail("manifest entries 重复或格式无效")
        path = canonical(item.get("path"))
        if not path or path == "backup-manifest.json":
            fail(f"manifest 路径无效: {item.get('path')!r}")
        if path != item.get("path"):
            fail(f"manifest 路径不是规范路径: {item.get('path')!r}")
        if path.startswith('users/') and path.count('/') == 1 and item.get('type') != 'directory':
            fail(f"users user root must be directory: {path}")
        if path == 'backup-manifest.json':
            fail(f"manifest 路径无效: {item.get('path')!r}")
        kind = item.get("type")
        if kind not in ("file", "directory"):
            fail(f"manifest 类型无效: {path}")
        if path != item.get("path") or path in listed:
            fail(f"manifest 路径不是唯一规范路径: {path}")
        listed[path] = item
    actual = {name: member for name, member in entries.items() if name != "backup-manifest.json"}
    if set(listed) != set(actual):
        missing = sorted(set(listed) - set(actual))
        extra = sorted(set(actual) - set(listed))
        fail(f"manifest 与归档不一致: missing={missing[:3]}, extra={extra[:3]}")
    for path, item in listed.items():
        member = actual[path]
        if item["type"] == "directory":
            if not member.isdir():
                fail(f"manifest 声明目录但归档不是目录: {path}")
        else:
            if not member.isfile():
                fail(f"manifest 声明文件但归档不是文件: {path}")
            expected = item.get("sha256")
            if not isinstance(expected, str) or len(expected) != 64:
                fail(f"manifest 缺少有效 sha256: {path}")
            size, actual_hash = digest(tf.extractfile(member))
            if size != item.get("size") or actual_hash != expected:
                fail(f"归档文件校验失败: {path}")
    return listed


def extract_archive(root, archive, legacy=False, keyring=None, auth_key=None):
    if legacy:
        with tarfile.open(archive, "r:gz") as tf:
            entries = archive_entries(tf)
            if not entries:
                fail("回滚归档为空")
            if not any(name == "messages.json" or name.endswith("/messages.json") for name in entries):
                fail("回滚归档没有 messages.json")
    else:
        validate_archive(archive, keyring, auth_key)
    if os.listdir(root):
        fail("暂存目录必须为空")
    with tarfile.open(archive, "r:gz") as tf:
        entries = archive_entries(tf)
        for name, member in entries.items():
            if name == "backup-manifest.json":
                continue
            target = os.path.join(root, *name.split("/"))
            if member.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                with tf.extractfile(member) as source, open(target, "xb") as dest:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        dest.write(chunk)
                os.chmod(target, 0o600)


def verify_content(root, manifest, keyring, auth_key):
    if not os.path.isdir(os.path.join(root, 'users')):
        expected = manifest.get('requiredContentKeyIds')
        if expected != []:
            fail('requiredContentKeyIds mismatch')
        return
    for name in os.listdir(root):
        if name.startswith('.sensitive-rotation'):
            fail('sensitive rotation journal must be moved outside data root')
    command = [os.environ.get('NODE', 'node'), os.path.join(os.path.dirname(__file__), 'content-backup.js'), 'inspect', root]
    if keyring:
        command += ['--keyring', keyring]
    if auth_key:
        command += ['--auth-key', auth_key]
    if manifest is not None:
        command += ['--expected-ids', json.dumps(manifest.get('requiredContentKeyIds'), separators=(',', ':'))]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError:
        fail('sensitive content authentication failed or content keyring missing')


def validate_archive(path, keyring=None, auth_key=None):
    with tarfile.open(path, "r:gz") as tf:
        entries = archive_entries(tf)
        listed = read_manifest(tf, entries)
        manifest_mode = "accounts" if "donote.db" in listed else "legacy"
        manifest = None
        manifest_member = entries.get('backup-manifest.json')
        if manifest_member:
            manifest = json.load(tf.extractfile(manifest_member))
        messages = [p for p, item in listed.items() if item["type"] == "file" and posixpath.basename(p) == "messages.json"]
        if not messages and manifest_mode != "accounts":
            fail("归档没有 messages.json")
        for path_name in messages:
            member = entries[path_name]
            try:
                state = json.load(tf.extractfile(member))
            except Exception as exc:
                fail(f"消息文件 JSON 无效: {path_name}: {exc}")
            if not isinstance(state, dict) or not isinstance(state.get("messages"), list):
                fail(f"消息文件结构无效: {path_name}")
            # A self-consistent manifest is not enough: every persisted attachment
            # reference must resolve inside that user's uploads tree.
            prefix = posixpath.dirname(path_name)
            upload_prefix = posixpath.join(prefix, "uploads") if prefix else "uploads"
            for message in state["messages"]:
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                refs = []
                if isinstance(content, dict):
                    if message.get("type") == "image":
                        refs.extend(x for x in (content.get("originalPath"), content.get("thumbnailPath")) if isinstance(x, str))
                    elif message.get("type") == "file" and isinstance(content.get("filePath"), str):
                        refs.append(content["filePath"])
                for ref in refs:
                    relative = canonical(ref)
                    if not relative:
                        fail(f"消息引用的附件路径为空: {path_name}")
                    target = posixpath.join(upload_prefix, relative)
                    if target not in listed or listed[target]["type"] != "file":
                        fail(f"消息引用的附件不存在: {path_name}: {ref}")
        if manifest_mode == "accounts":
            db_path = entries.get("donote.db")
            if db_path is None or not db_path.isfile():
                fail("accounts 归档缺少 donote.db")
            with tempfile.NamedTemporaryFile() as tmp:
                tmp.write(tf.extractfile(db_path).read()); tmp.flush()
                try:
                    import sqlite3
                    conn = sqlite3.connect(f"file:{tmp.name}?mode=ro", uri=True)
                    conn.execute("PRAGMA foreign_keys=ON")
                    if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
                        fail("accounts SQLite integrity 校验失败")
                    conn.close()
                except Exception as exc:
                    fail(f"accounts SQLite 无法校验: {exc}")
        if manifest_mode == 'accounts':
            # Extract only messages files in memory and authenticate before restore stages can replace data.
            with tempfile.TemporaryDirectory(prefix='content-auth-') as content_root:
                for path_name in messages:
                    target = os.path.join(content_root, *path_name.split('/'))
                    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
                    with tf.extractfile(entries[path_name]) as source, open(target, 'xb') as dest:
                        dest.write(source.read())
                verify_content(content_root, manifest, keyring, auth_key)
        users = {p.split("/")[1] for p in listed if p.startswith("users/") and p.count("/") >= 1 and p.split("/")[1]}
        for user in users:
            if f"users/{user}/messages.json" not in listed:
                fail(f"用户消息文件缺失: users/{user}/messages.json")
    print(f"archive valid: {len(entries)} members")


def validate_tree(root, archive):
    root = os.path.realpath(root)
    with tarfile.open(archive, "r:gz") as tf:
        entries = archive_entries(tf)
        if "backup-manifest.json" in entries:
            listed = read_manifest(tf, entries)
        else:
            listed = {name: {"path": name, "type": "directory" if member.isdir() else "file"}
                      for name, member in entries.items()}
    actual = {}
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            absolute = os.path.join(base, name)
            relative = os.path.relpath(absolute, root).replace(os.sep, "/")
            st = os.lstat(absolute)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                fail(f"暂存目录含链接或特殊文件: {relative}")
            actual[relative] = "directory" if stat.S_ISDIR(st.st_mode) else "file"
    if set(actual) != set(listed):
        fail("暂存目录与 manifest 成员不一致")
    for relative, item in listed.items():
        absolute = os.path.join(root, *relative.split("/"))
        if actual[relative] != item["type"]:
            fail(f"暂存目录类型不一致: {relative}")
        if item["type"] == "file" and "size" in item and "sha256" in item:
            with open(absolute, "rb") as stream:
                size, actual_hash = digest(stream)
            if size != item["size"] or actual_hash != item["sha256"]:
                fail(f"暂存文件校验失败: {relative}")
    print(f"tree valid: {len(actual)} members")


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == '--extract':
        root, archive = sys.argv[2:4]
        options = dict(zip(sys.argv[4::2], sys.argv[5::2]))
        if len(sys.argv[4:]) % 2 or set(options) - {'--keyring', '--auth-key'}:
            fail('用法错误')
        extract_archive(root, archive, keyring=options.get('--keyring'), auth_key=options.get('--auth-key'))
    elif len(sys.argv) == 4 and sys.argv[1] == '--extract-legacy':
        extract_archive(sys.argv[2], sys.argv[3], legacy=True)
    elif len(sys.argv) == 3 and sys.argv[1] == "--rollback":
        with tarfile.open(sys.argv[2], "r:gz") as tf:
            entries = archive_entries(tf)
            if any(posixpath.basename(name) == "donote.db" for name in entries):
                fail("rollback accounts archive requires manifest and external key validation")
            for member in tf.getmembers():
                if member.isfile():
                    digest(tf.extractfile(member))
        print("rollback archive valid")
    elif len(sys.argv) == 4 and sys.argv[1] == "--tree":
        validate_tree(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 4:
        archive = sys.argv[1]
        options = dict(zip(sys.argv[2::2], sys.argv[3::2]))
        if len(sys.argv[2:]) % 2 or set(options) - {'--keyring', '--auth-key'} or '--keyring' not in options or '--auth-key' not in options:
            fail('用法错误')
        validate_archive(archive, options['--keyring'], options['--auth-key'])
    elif len(sys.argv) == 2:
        validate_archive(sys.argv[1])
    else:
        fail("用法: restore-validate.py ARCHIVE | --rollback ARCHIVE | --extract ROOT ARCHIVE | --extract-legacy ROOT ARCHIVE | --tree ROOT ARCHIVE")
