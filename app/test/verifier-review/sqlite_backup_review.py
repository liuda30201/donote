#!/usr/bin/env python3
"""Read-only synthetic review of SQLite coverage in O01/O02."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
HELPER = REPO / 'scripts/lib/backup-data.js'
VALIDATOR = REPO / 'scripts/lib/restore-validate.py'


class SQLiteBackupReview(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='donote-sqlite-review-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        (self.data / 'messages.json').write_text('{"messages":[]}', encoding='utf-8')
        self.archive = self.root / 'backup.tar.gz'

    def run_backup(self):
        return subprocess.run(['node', str(HELPER), str(self.data), str(self.archive)],
                              capture_output=True, text=True, timeout=30)

    def archive_names(self):
        with tarfile.open(self.archive, 'r:gz') as tf:
            return {m.name.removeprefix('./') for m in tf.getmembers()}

    def test_database_and_sidecars_are_rejected_without_data_loss(self):
        db = self.data / 'donote.db'
        connection = sqlite3.connect(db)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('CREATE TABLE accounts(id TEXT PRIMARY KEY, marker TEXT)')
        connection.execute("INSERT INTO accounts VALUES ('u1', 'committed')")
        connection.commit()
        connection.close()
        # Synthetic sidecars exercise the legacy helper's refusal boundary;
        # it must not open, alter, or silently omit any SQLite source files.
        (self.data / 'donote.db-wal').write_bytes(b'synthetic wal')
        (self.data / 'donote.db-shm').write_bytes(b'synthetic shm')
        before = {p.name: p.read_bytes() for p in self.data.iterdir()}
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('SQLite backup unsupported', result.stderr)
        self.assertIn('refusing to omit database', result.stderr)
        self.assertFalse(self.archive.exists())
        self.assertEqual({p.name: p.read_bytes() for p in self.data.iterdir()}, before)
        # Read only the main file immutably so synthetic sidecars stay untouched.
        with sqlite3.connect(db.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as checked:
            self.assertEqual(checked.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(checked.execute('SELECT id, marker FROM accounts').fetchall(),
                             [('u1', 'committed')])

    def test_restore_validator_accepts_manifest_without_database(self):
        payload = b'{"messages":[]}'
        entries = [{'path': 'messages.json', 'type': 'file', 'mode': 384,
                    'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}]
        manifest = {'format': 'donote-backup', 'formatVersion': 1,
                    'checksumAlgorithm': 'sha256', 'entries': entries}
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data in [('messages.json', payload),
                               ('backup-manifest.json', json.dumps(manifest).encode())]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, __import__('io').BytesIO(data))
        result = subprocess.run(['python3', str(VALIDATOR), str(self.archive)],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
