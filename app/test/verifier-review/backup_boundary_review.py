#!/usr/bin/env python3
"""Independent security-boundary acceptance checks; synthetic data only.
Run: python3 app/test/verifier-review/backup_boundary_review.py -v
Failures identify unmet invariants, not expected-failure decorations.
"""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
HELPER = REPO / 'scripts/lib/backup-data.js'


class BackupBoundaryReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='donote-boundary-review-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.archive = self.root / 'backup.tar.gz'

    def put(self, name, value):
        target = self.source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding='utf-8')

    def backup(self):
        return subprocess.run(['node', str(HELPER), str(self.source), str(self.archive)],
                              capture_output=True, text=True, timeout=30)

    def names(self):
        with tarfile.open(self.archive) as archive:
            return {m.name.removeprefix('./') for m in archive.getmembers()}

    def test_user_named_temp_is_not_silently_omitted(self):
        self.put('users/alice/messages.json', '{"messages":[]}')
        self.put('users/temp/messages.json', '{"messages":[]}')
        self.put('users/temp/uploads/files/real.txt', 'real historical attachment')
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('users/temp/messages.json', self.names())
        self.assertIn('users/temp/uploads/files/real.txt', self.names())

    def test_attachment_temp_directory_is_not_application_temp(self):
        self.put('messages.json', json.dumps({'messages': [{
            'id': 'file-1', 'type': 'file',
            'content': {'filePath': 'temp/historical.txt', 'name': 'historical.txt'}}]}))
        self.put('uploads/temp/historical.txt', 'actual referenced attachment')
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('uploads/temp/historical.txt', self.names())

    def test_referenced_attachment_named_messages_tmp_is_preserved(self):
        self.put('messages.json', json.dumps({'messages': [{
            'id': 'file-2', 'type': 'file',
            'content': {'filePath': 'files/messages.json.tmp', 'name': 'messages.json.tmp'}}]}))
        self.put('uploads/files/messages.json.tmp', 'not a storage atomic-write temporary')
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('uploads/files/messages.json.tmp', self.names())

    def test_native_archive_validates_extracts_and_checks_without_test_env_overrides(self):
        self.put('messages.json', '{"messages":[]}')
        self.put('uploads/中文.txt', 'native archive')
        result = self.backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        validator = str(REPO / 'scripts/lib/restore-validate.py')
        stage = self.root / 'stage'
        stage.mkdir()
        for arguments in [[str(self.archive)], ['--extract', str(stage), str(self.archive)],
                          ['--tree', str(stage), str(self.archive)]]:
            result = subprocess.run(['python3', validator, *arguments],
                                   capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((stage / 'uploads/中文.txt').read_text(), 'native archive')

    def test_missing_referenced_attachment_aborts_backup(self):
        self.put('messages.json', json.dumps({'messages': [{
            'id': 'missing-file', 'type': 'file',
            'content': {'filePath': 'files/missing.bin', 'name': 'missing.bin'}}]}))
        (self.source / 'uploads').mkdir()
        result = self.backup()
        self.assertNotEqual(result.returncode, 0, 'backup published while required referenced file was absent')
        self.assertFalse(self.archive.exists(), 'invalid backup must not be published')


class RestoreManifestBoundaryReview(unittest.TestCase):
    def test_manifest_self_consistent_but_attachment_missing_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='donote-restore-boundary-') as temporary:
            archive_path = Path(temporary) / 'incomplete.tar.gz'
            payload = json.dumps({'messages': [{'id': 'missing', 'type': 'image',
                'content': {'originalPath': 'images/missing.png',
                            'thumbnailPath': 'images/missing-thumb.png'}}]}).encode()
            manifest = {'format': 'donote-backup', 'formatVersion': 1,
                'checksumAlgorithm': 'sha256', 'entries': [{
                    'path': 'messages.json', 'type': 'file', 'mode': 384,
                    'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}]}
            with tarfile.open(archive_path, 'w:gz') as archive:
                for name, data in [('messages.json', payload),
                                   ('backup-manifest.json', json.dumps(manifest).encode())]:
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            result = subprocess.run(['python3', str(REPO / 'scripts/lib/restore-validate.py'),
                str(archive_path)], capture_output=True, text=True, timeout=20)
            self.assertNotEqual(result.returncode, 0,
                'manifest hashes alone cannot establish message/attachment completeness')


if __name__ == '__main__':
    unittest.main()
