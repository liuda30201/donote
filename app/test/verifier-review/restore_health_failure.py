#!/usr/bin/env python3
"""Isolated restore integration fault injection. Never executes real Docker."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('fixture_suite', REPO / 'app/test/verifier/v01_backup_recovery_independent.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class HealthFailureReview(unittest.TestCase):
    def test_unhealthy_new_tree_rolls_back_and_returns_failure(self):
        with tempfile.TemporaryDirectory(prefix='donote-v01-independent-') as temporary:
            root = Path(temporary)
            source, data = root / 'source', root / 'data'
            source.mkdir()
            data.mkdir()
            MODULE.populate(source, 'mixed')
            MODULE.populate(data, 'single')
            (data / '.sentinel').write_text('original target', encoding='utf-8')
            before = MODULE.snapshot(data)
            scripts = root / 'scripts'
            (scripts / 'lib').mkdir(parents=True)
            for name in ['backup.sh', 'restore.sh', 'lib/common.sh', 'lib/backup-data.js', 'lib/restore-validate.py']:
                shutil.copy2(REPO / 'scripts' / name, scripts / name)
            binary = root / 'bin'
            binary.mkdir()
            # Override only inspect result: first start unhealthy, rollback start healthy.
            docker = (REPO / 'app/test/verifier/v01_docker_fixture.py').read_text()
            old = "if args[:1] == ['inspect']:\n        print('healthy')\n        return 0"
            new = """if args[:1] == ['inspect']:
        events = [json.loads(line) for line in (root / 'docker-events.jsonl').read_text().splitlines()]
        starts = sum(event == ['compose', 'start', 'app'] for event in events)
        print('unhealthy' if starts == 1 else 'healthy')
        return 0"""
            self.assertIn(old, docker)
            (binary / 'docker').write_text(docker.replace(old, new))
            (binary / 'docker').chmod(0o755)
            environment = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ['PATH'],
                               IMAGE='synthetic', V01_ROOT=str(root))
            archive = root / 'source.tar.gz'
            result = subprocess.run(['node', str(scripts / 'lib/backup-data.js'), str(source), str(archive)],
                                    env=environment, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run(['bash', str(scripts / 'restore.sh'), str(archive)],
                                    env=environment, input='yes\n', capture_output=True, text=True, timeout=30)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(MODULE.snapshot(data), before)
            events = [json.loads(line) for line in (root / 'docker-events.jsonl').read_text().splitlines()]
            self.assertEqual(events.count(['compose', 'start', 'app']), 2)
            self.assertEqual(events.count(['compose', 'stop', 'app']), 2)
            self.assertTrue(list(root.glob('.restore-failed-*')), 'failed new tree must remain for diagnosis')
            self.assertFalse(list(root.glob('.restore-old-*')), 'old tree must have returned to data')


if __name__ == '__main__':
    unittest.main()
