#!/usr/bin/env python3
"""Fail-closed boundary checks with real temporary SQLite, never production data."""
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
BACKUP = ROOT / 'scripts/lib/backup-data.js'
VALIDATOR = ROOT / 'scripts/lib/restore-validate.py'


class SqliteBackupFix(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='donote-sqlite-backup-fix-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.data / 'messages.json').write_text('{"messages":[]}', encoding='utf-8')
        self.output = self.root / 'backup.tar.gz'

    def backup(self, **extra):
        env = dict(os.environ)
        env.pop('AUTH_MODE', None)
        env.pop('AUTH_KEY_FILE', None)
        env.update(extra)
        return subprocess.run(['node', str(BACKUP), str(self.data), str(self.output)], capture_output=True, text=True, env=env)

    def archive(self, storage_mode='legacy', extra=None):
        raw = b'{"messages":[]}'
        manifest = {'format': 'donote-backup', 'formatVersion': 1, 'storageMode': storage_mode, 'checksumAlgorithm': 'sha256', 'entries': [{'path': 'messages.json', 'type': 'file', 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}]}
        manifest.update(extra or {})
        with tarfile.open(self.output, 'w:gz') as tf:
            for name, content in [('messages.json', raw), ('backup-manifest.json', json.dumps(manifest).encode())]:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                tf.addfile(member, io.BytesIO(content))

    def validate(self):
        return subprocess.run(['python3', str(VALIDATOR), str(self.output)], capture_output=True, text=True)

    def test_active_real_wal_database_is_rejected_without_publication(self):
        db = sqlite3.connect(self.data / 'donote.db')
        self.addCleanup(db.close)
        db.execute('pragma journal_mode=wal')
        db.execute('create table users(id text)')
        db.execute("insert into users values ('synthetic')")
        db.commit()
        self.assertTrue((self.data / 'donote.db-wal').exists())
        result = self.backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SQLite', result.stderr)
        self.assertFalse(self.output.exists())
        self.assertEqual(db.execute('select count(*) from users').fetchone()[0], 1)

    def test_orphan_sidecar_is_rejected(self):
        (self.data / 'donote.db-wal').write_bytes(b'synthetic')
        self.assertNotEqual(self.backup().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_accounts_mode_rejects_even_without_database(self):
        self.assertNotEqual(self.backup(AUTH_MODE='accounts').returncode, 0)
        self.assertFalse(self.output.exists())

    def test_sqlite_manifest_missing_database_is_rejected(self):
        for mode in ['sqlite-checkpoint', 'accounts', 'mixed']:
            self.archive(mode)
            self.assertNotEqual(self.validate().returncode, 0, mode)

    def test_forged_legacy_with_sqlite_metadata_is_rejected(self):
        self.archive(extra={'sqliteSnapshot': {'schemaVersion': 1, 'keyId': 'synthetic'}})
        self.assertNotEqual(self.validate().returncode, 0)

    def test_raw_legacy_rollback_cannot_smuggle_sqlite(self):
        with tarfile.open(self.output, 'w:gz') as tf:
            content = b'synthetic db'
            member = tarfile.TarInfo('donote.db')
            member.size = len(content)
            tf.addfile(member, io.BytesIO(content))
        result = subprocess.run(['python3', str(VALIDATOR), '--rollback', str(self.output)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_external_key_inside_data_is_rejected(self):
        key = self.data / 'key.bin'
        key.write_bytes(b'x' * 32)
        self.assertNotEqual(self.backup(AUTH_KEY_FILE=str(key)).returncode, 0)
        self.assertFalse(self.output.exists())

    def test_legacy_roundtrip_still_works(self):
        made = self.backup()
        self.assertEqual(made.returncode, 0, made.stderr)
        checked = self.validate()
        self.assertEqual(checked.returncode, 0, checked.stderr)
        with tarfile.open(self.output) as tf:
            manifest = json.load(tf.extractfile('./backup-manifest.json'))
            self.assertEqual(manifest['storageMode'], 'legacy')


if __name__ == '__main__':
    unittest.main()
