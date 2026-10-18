#!/usr/bin/env python3
"""Run: python3 app/test/verifier/v01_backup_recovery_independent.py -v
Only synthetic temporary data is used; no real Docker invocation is possible.
Failures are acceptance findings, not expected-failure decorations.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).with_name('v01_docker_fixture.py')

def snapshot(root):
    result = {}
    for item in sorted(root.rglob('*')):
        name = item.relative_to(root).as_posix()
        if item.is_symlink():
            result[name] = ('link', os.readlink(item))
        elif item.is_dir():
            result[name] = ('directory',)
        else:
            result[name] = ('file', hashlib.sha256(item.read_bytes()).hexdigest())
    return result

def put(root, name, content):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content if isinstance(content, bytes) else content.encode())

def populate(root, layout):
    if layout in ('single', 'mixed'):
        put(root, 'messages.json', json.dumps({'messages': [{'id': 'legacy', 'content': '合成消息'}]}))
        put(root, 'uploads/中文 附件.txt', 'synthetic legacy attachment')
        put(root, 'uploads/original.png', bytes(range(256)))
        put(root, 'uploads/thumbnail.png', b'PNG-test-thumbnail')
        (root / 'uploads/空目录').mkdir()
        put(root, 'shares/old.json', '{"synthetic":true}')
    if layout in ('multi', 'mixed'):
        for user in ('alice-uuid', 'bob-uuid'):
            put(root, f'users/{user}/messages.json', json.dumps({'messages': [{'id': user, 'content': '仅合成数据'}]}))
            put(root, f'users/{user}/uploads/同名附件.bin', user.encode() + bytes([0, 255]))
            put(root, f'users/{user}/uploads/原图.png', b'original-' + user.encode())
            put(root, f'users/{user}/uploads/缩略图.png', b'thumb-' + user.encode())
            (root / f'users/{user}/uploads/空目录').mkdir()

class V01(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='donote-v01-independent-')).resolve()
        self.addCleanup(shutil.rmtree, self.root)
        self.data = self.root / 'data'
        self.source = self.root / 'source'
        self.data.mkdir()
        self.source.mkdir()
        put(self.data, 'messages.json', '{"messages":[{"id":"existing-synthetic"}]}')
        put(self.data, '.hidden-sentinel', 'never lose existing target data on failure')
        put(self.data, 'uploads/目标附件.bin', b'original-target\x00\xff')
        (self.data / '空目录').mkdir()
        self.before = snapshot(self.data)
        scripts = self.root / 'scripts'
        (scripts / 'lib').mkdir(parents=True)
        for name in ('backup.sh', 'restore.sh', 'lib/common.sh', 'lib/backup-data.js', 'lib/restore-validate.py'):
            source = REPO / 'scripts' / name
            if source.is_file():
                shutil.copy2(source, scripts / name)
        # Never source the operational scripts from their real project location.
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        shutil.copy2(FIXTURE, self.bin / 'docker')
        (self.bin / 'docker').chmod(0o755)
        (self.root / 'tmp').mkdir()
        self.env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL') if key in os.environ}
        self.env.update(PATH=str(self.bin) + os.pathsep + self.env.get('PATH', ''),
                        IMAGE='v01-synthetic-no-daemon', V01_ROOT=str(self.root),
                        HOME=str(self.root), TMPDIR=str(self.root / 'tmp'), COPYFILE_DISABLE='1')
        self.archive = self.root / 'synthetic.tar.gz'

    def backup(self):
        helper = self.root / 'scripts/lib/backup-data.js'
        self.assertTrue(helper.is_file(), 'O01 helper not present: cannot verify backup')
        return subprocess.run(['node', str(helper), str(self.source), str(self.archive)],
                              env=self.env, cwd=self.root, capture_output=True, text=True, timeout=20)

    def restore(self, answer='yes\n', rollback_fail=False):
        env = dict(self.env)
        if rollback_fail:
            env['V01_ROLLBACK_FAIL'] = '1'
        return subprocess.run(['bash', str(self.root / 'scripts/restore.sh'), str(self.archive)],
                              input=answer, env=env, cwd=self.root, capture_output=True, text=True, timeout=20)

    def legacy_archive(self, overrides=None):
        with tarfile.open(self.archive, 'w:gz') as archive:
            archive.add(self.source, arcname='.')
            for member, body in overrides or []:
                archive.addfile(member, io.BytesIO(body) if body is not None else None)

    def shell_backup(self):
        env = dict(self.env, BACKUP_MODE='local', DATA_DIR=str(self.source),
                   BACKUP_DIR=str(self.root / 'backup'), KEEP='1')
        return subprocess.run(['bash', str(self.root / 'scripts/backup.sh')], env=env,
                              cwd=self.root, capture_output=True, text=True, timeout=20)

    def test_backup_local_wrapper_preserves_all_fixture_paths(self):
        populate(self.source, 'mixed')
        before = snapshot(self.source)
        proc = self.shell_backup()
        self.assertEqual(proc.returncode, 0, self.diagnostic(proc))
        output = self.root / 'backup'
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        archives = list(output.glob('web-clipboard-*.tar.gz'))
        self.assertEqual(len(archives), 1)
        self.assertEqual(archives[0].stat().st_mode & 0o777, 0o600)
        extracted = self.root / 'wrapper-extracted'
        extracted.mkdir()
        with tarfile.open(archives[0]) as archive:
            archive.extractall(extracted, filter='data')
        actual = snapshot(extracted)
        del actual['backup-manifest.json']
        self.assertEqual(actual, before)
        self.assertEqual(snapshot(self.source), before)
        self.assertEqual(snapshot(self.data), self.before)

    def test_backup_tar_failure_keeps_previous_archive_and_source(self):
        populate(self.source, 'mixed')
        before = snapshot(self.source)
        output = self.root / 'backup'
        output.mkdir()
        prior = output / 'web-clipboard-20000101-000000.tar.gz'
        prior.write_bytes(b'previous-backup-synthetic-sentinel')
        # Exit before touching any archive; run the real copied wrapper and helper.
        put(self.bin, 'tar', '#!/bin/sh\nexit 43\n')
        (self.bin / 'tar').chmod(0o755)
        proc = self.shell_backup()
        self.assertNotEqual(proc.returncode, 0, self.diagnostic(proc))
        self.assertIn('tar failed (43)', proc.stderr)
        self.assertEqual(snapshot(self.source), before)
        self.assertEqual(snapshot(self.data), self.before)
        self.assertEqual(list(output.iterdir()), [prior])
        self.assertEqual(prior.read_bytes(), b'previous-backup-synthetic-sentinel')

    def diagnostic(self, proc):
        return f'rc={proc.returncode}\nstdout={proc.stdout}\nstderr={proc.stderr}'

    def rejection(self, **kwargs):
        proc = self.restore(**kwargs)
        self.assertEqual(snapshot(self.data), self.before, 'Target changed on failure: ' + self.diagnostic(proc))
        self.assertFalse((self.root / 'replacement-attempted').exists(),
                         'Reached destructive extraction before rejecting: ' + self.diagnostic(proc))
        self.assertNotEqual(proc.returncode, 0, 'Unsafe archive accepted: ' + self.diagnostic(proc))
        self.assertFalse((self.root / 'escape.txt').exists())

    def test_restore_corrupt_archive(self):
        self.archive.write_bytes(b'not a gzip or tar archive')
        self.rejection()

    def test_restore_cancel_preserves_target(self):
        populate(self.source, 'single')
        self.legacy_archive()
        self.rejection(answer='no\n')

    def test_restore_rollback_failure_preserves_target(self):
        populate(self.source, 'single')
        self.legacy_archive()
        self.rejection(rollback_fail=True)

    def test_backup_refuses_existing_archive(self):
        populate(self.source, 'single')
        self.archive.write_bytes(b'prior valid backup sentinel')
        proc = self.backup()
        self.assertNotEqual(proc.returncode, 0, self.diagnostic(proc))
        self.assertEqual(self.archive.read_bytes(), b'prior valid backup sentinel')

def backup_roundtrip(layout):
    def check(self):
        populate(self.source, layout)
        before = snapshot(self.source)
        proc = self.backup()
        self.assertEqual(proc.returncode, 0, self.diagnostic(proc))
        self.assertEqual(snapshot(self.source), before, 'Backup changed source')
        self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
        extracted = self.root / 'extracted'
        extracted.mkdir()
        with tarfile.open(self.archive) as archive:
            manifest = json.load(archive.extractfile('./backup-manifest.json'))
            archive.extractall(extracted, filter='data')
        self.assertEqual(manifest['format'], 'donote-backup')
        self.assertEqual(manifest['formatVersion'], 1)
        expected_users = [] if layout == 'single' else ['alice-uuid', 'bob-uuid']
        self.assertEqual(sorted(x['sourceId'] for x in manifest['userMapping']), expected_users)
        actual = snapshot(extracted)
        del actual['backup-manifest.json']
        self.assertEqual(actual, before, 'Archive omitted/changed files or empty directories')
        for entry in manifest['entries']:
            if entry['type'] == 'file':
                self.assertEqual(hashlib.sha256((extracted / entry['path']).read_bytes()).hexdigest(), entry['sha256'])
                self.assertEqual((extracted / entry['path']).stat().st_size, entry['size'])
    return check

def restore_roundtrip(layout):
    def check(self):
        populate(self.source, layout)
        # Legacy archives deliberately test compatibility without requiring a new manifest.
        self.legacy_archive()
        proc = self.restore()
        self.assertEqual(proc.returncode, 0, self.diagnostic(proc))
        self.assertEqual(snapshot(self.data), snapshot(self.source), self.diagnostic(proc))
        rollback = list(self.root.glob('data.rollback-*.tar.gz'))
        self.assertEqual(len(rollback), 1)
        previous = self.root / 'previous'
        previous.mkdir()
        with tarfile.open(rollback[0]) as archive:
            archive.extractall(previous, filter='data')
        self.assertEqual(snapshot(previous), self.before)
    return check

def reject_member(kind):
    def check(self):
        populate(self.source, 'single')
        name = {'traversal': '../escape.txt', 'absolute': str(self.root / 'escape.txt'),
                'symlink': 'uploads/dangerous-link', 'hardlink': 'uploads/dangerous-hardlink'}[kind]
        member = tarfile.TarInfo(name)
        body = b'only synthetic'
        member.size = len(body)
        if kind in ('symlink', 'hardlink'):
            member.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
            member.linkname = '../outside-synthetic' if kind == 'symlink' else str(self.root / 'outside-synthetic')
            member.size = 0
            body = None
        self.legacy_archive([(member, body)])
        self.rejection()
    return check

def missing_or_bad(kind, action):
    def check(self):
        if kind == 'root_messages':
            (self.source / 'uploads').mkdir()
            put(self.source, 'uploads/attachment.bin', b'synthetic')
        elif kind == 'user_messages':
            populate(self.source, 'single')
            put(self.source, 'users/incomplete/uploads/attachment.bin', b'synthetic')
        elif kind == 'bad_json':
            populate(self.source, 'single')
            put(self.source, 'messages.json', '{invalid-json')
        elif kind == 'source_symlink':
            populate(self.source, 'single')
            put(self.root, 'outside-synthetic', 'not part of backup')
            (self.source / 'uploads/link').symlink_to(self.root / 'outside-synthetic')
        before = snapshot(self.source)
        if action == 'backup':
            proc = self.backup()
            self.assertNotEqual(proc.returncode, 0, self.diagnostic(proc))
            self.assertFalse(self.archive.exists(), 'Failed backup published an archive')
        else:
            self.legacy_archive()
            self.rejection()
        self.assertEqual(snapshot(self.source), before)
    return check

for layout in ('single', 'multi', 'mixed'):
    setattr(V01, f'test_backup_{layout}_roundtrip', backup_roundtrip(layout))
    setattr(V01, f'test_restore_{layout}_roundtrip', restore_roundtrip(layout))
for kind in ('traversal', 'absolute', 'symlink', 'hardlink'):
    setattr(V01, f'test_restore_rejects_{kind}', reject_member(kind))
for kind in ('root_messages', 'user_messages', 'bad_json', 'source_symlink'):
    setattr(V01, f'test_backup_rejects_{kind}', missing_or_bad(kind, 'backup'))
for kind in ('root_messages', 'user_messages', 'bad_json'):
    setattr(V01, f'test_restore_rejects_{kind}', missing_or_bad(kind, 'restore'))

if __name__ == '__main__':
    unittest.main()
