"""Synthetic subprocess-only ownership/failure tests; never invokes Docker."""
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).with_name('container-acceptance.py'))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class OwnershipTests(unittest.TestCase):
    def test_owned_container(self):
        record = {'Name': '/synthetic', 'Config': {'Labels': {'donote.acceptance': 'nonce'}}}
        with patch.object(acceptance.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps([record]), '')):
            self.assertEqual(acceptance.inspect_owned(['docker', '-H', 'synthetic'], 'container', 'synthetic', 'nonce'), record)

    def test_foreign_container_refused(self):
        record = {'Name': '/synthetic', 'Config': {'Labels': {'donote.acceptance': 'different'}}}
        with patch.object(acceptance.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps([record]), '')):
            with self.assertRaisesRegex(RuntimeError, 'Ownership mismatch'):
                acceptance.inspect_owned(['docker'], 'container', 'synthetic', 'nonce')

    def test_missing_resource_is_absent(self):
        with patch.object(acceptance.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'Error: No such container: synthetic')):
            self.assertIsNone(acceptance.inspect_owned(['docker'], 'container', 'synthetic', 'nonce'))

    def test_daemon_failure_not_absence(self):
        with patch.object(acceptance.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'Cannot connect to Docker daemon')):
            with self.assertRaisesRegex(RuntimeError, 'Cannot verify cleanup'):
                acceptance.inspect_owned(['docker'], 'container', 'synthetic', 'nonce')

    def test_create_failure_still_checks_cleanup(self):
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            if 'create' in argv:
                raise RuntimeError('synthetic create failed after allocation')
            return ''
        def owned(docker, kind, target, nonce):
            return {'Name': '/' + target}
        with patch.object(acceptance, 'command', side_effect=command), patch.object(acceptance, 'inspect_owned', side_effect=owned), patch('sys.argv', ['fixture', '--execute', '--docker-host', 'synthetic-endpoint']):
            with self.assertRaisesRegex(RuntimeError, 'synthetic create failed'):
                acceptance.main()
        self.assertTrue(any('rm' in argv and '-f' in argv for argv in calls))
        self.assertTrue(any('image' in argv and 'rm' in argv for argv in calls))
        self.assertTrue(all(argv[:3] == ['docker', '-H', 'synthetic-endpoint'] for argv in calls))


if __name__ == '__main__':
    unittest.main()
