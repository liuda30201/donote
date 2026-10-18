#!/usr/bin/env python3
"""Real synthetic backup/restore shell flow; Docker lifecycle only is stubbed.

No daemon, image or real data is accessed. Product scripts run from a copied
private project tree. This does not certify container startup/health behavior.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
NODE = os.environ.get('NODE', 'node')


class SensitiveRestoreE2E(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='donote-sensitive-restore-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / 'project'
        (self.project / 'scripts').mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts/restore.sh', self.project / 'scripts/restore.sh')
        shutil.copy2(ROOT / 'scripts/backup.sh', self.project / 'scripts/backup.sh')
        shutil.copytree(ROOT / 'scripts/lib', self.project / 'scripts/lib')
        # content-backup.js resolves only this pure cryptographic product module.
        target = self.project / 'app/src/security'
        target.mkdir(parents=True)
        shutil.copy2(ROOT / 'app/src/security/sensitive.js', target / 'sensitive.js')
        shutil.copy2(ROOT / 'app/src/security/primitives.js', target / 'primitives.js')
        self.data = self.project / 'data'
        self.data.mkdir()
        self.auth = self.root / 'auth-key'
        self.auth.write_bytes(os.urandom(32))
        self.auth.chmod(0o600)
        self.ring = self.root / 'content-ring.json'
        self.ring_config = {'version': 1, 'activeKeyId': 'current', 'keys': {
            'historical': base64.b64encode(os.urandom(32)).decode(),
            'current': base64.b64encode(os.urandom(32)).decode()}}
        self.write_ring(self.ring_config)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        # Exact allowlist: no fallback to a real docker executable.
        docker = self.bin / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['SYNTHETIC_DOCKER_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
if args == ['image', 'inspect', 'synthetic-restore-image']: pass
elif args in [['compose', 'stop', 'app'], ['compose', 'start', 'app']]: pass
elif args == ['compose', 'ps', '-q', 'app']: print('synthetic-container')
elif args == ['inspect', '--format', '{{.State.Health.Status}}', 'synthetic-container']: print('healthy')
else: sys.exit('Unapproved synthetic Docker command')
''')
        docker.chmod(0o700)
        self.log = self.root / 'docker-calls.jsonl'
        self.env = dict(os.environ)
        for key in ['AUTH_KEY_FILE', 'SENSITIVE_KEYRING_FILE', 'COMPOSE_FILE', 'DATA_DIR', 'NODE_OPTIONS']:
            self.env.pop(key, None)
        self.env.update(AUTH_MODE='accounts', AUTH_KEY_FILE=str(self.auth), AUTH_KEY_ID='primary',
                        SENSITIVE_KEYRING_FILE=str(self.ring), IMAGE='synthetic-restore-image',
                        PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        NODE_PATH=str(ROOT / 'app/node_modules'),
                        SYNTHETIC_DOCKER_LOG=str(self.log))
        fixture = self.node(r'''
const fs=require('node:fs'),path=require('node:path');
const {openDatabase}=require(process.argv[1]+'/app/src/db');
const {SECURITY_MIGRATION}=require(process.argv[1]+'/app/src/db/schema');
const {createRepositories}=require(process.argv[1]+'/app/src/db/repositories');
const {createSensitiveKeyring}=require(process.argv[1]+'/app/src/security/sensitive');
const p=require(process.argv[1]+'/app/src/security/primitives');
const db=openDatabase({storageRoot:process.argv[2],migrations:[SECURITY_MIGRATION]});
const repo=createRepositories(db),at=Date.now();
const user=repo.createUser({username:'restore-fixture',displayName:'Synthetic',passwordHash:'synthetic-not-login',at});
const token=p.generateToken(),csrf='synthetic-csrf-token';
const session=repo.createSession({userId:user.id,token,csrfToken:csrf,createdAt:at,idleExpiresAt:at+3600000,expiresAt:at+7200000,authStrength:'password'});
// Populate every class invalidated by the actual restore script.
db.prepare('INSERT INTO login_challenges(id,user_id,challenge_hash,kind,security_version,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run('challenge',user.id,p.hashToken(p.generateToken()),'login',1,at,at+300000);
db.prepare('INSERT INTO operation_grants(id,user_id,session_id,grant_hash,action,security_version,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run('grant',user.id,session.id,p.hashToken(p.generateToken()),'session.revoke-all',1,at,at+120000);
repo.addRecoveryCodes(user.id,['synthetic-recovery-code-at-least-16'],at);
const config=JSON.parse(fs.readFileSync(process.argv[3]));
const keys=Object.fromEntries(Object.entries(config.keys).map(([id,key])=>[id,Buffer.from(key,'base64')]));
const ring=createSensitiveKeyring({activeKeyId:'historical',keys});
const record={id:'sensitive-restored',type:'text',timestamp:at,sensitive:true,content:null,remark:'',encryptedPayload:ring.encrypt({content:'synthetic restore private body',remark:'synthetic restore private remark'},{userId:user.id,messageId:'sensitive-restored'})};
const dir=path.join(process.argv[2],'users',user.id);fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'messages.json'),JSON.stringify({messages:[record],lastActivity:at}),{mode:0o600});
console.log(JSON.stringify({userId:user.id,token,securityVersion:user.security_version}));
ring.close();db.close();
''', str(ROOT), str(self.data), str(self.ring))
        self.fixture = json.loads(fixture.stdout)
        backup_env = dict(self.env, DATA_DIR=str(self.data), BACKUP_DIR=str(self.root / 'backups'))
        result = self.run_cmd(['bash', str(self.project / 'scripts/backup.sh'), '--accounts-offline-confirmed'], env=backup_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.archive = next((self.root / 'backups').glob('*.tar.gz'))
        self.original = (self.data / 'users' / self.fixture['userId'] / 'messages.json').read_bytes()

    def run_cmd(self, args, **kwargs):
        return subprocess.run(args, capture_output=True, text=True, timeout=40, **kwargs)

    def node(self, code, *args):
        result = self.run_cmd([NODE, '-e', code, *args], env=getattr(self, 'env', None))
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def write_ring(self, config):
        self.ring.write_text(json.dumps(config))
        self.ring.chmod(0o600)

    def restore(self, env=None):
        return self.run_cmd(['bash', str(self.project / 'scripts/restore.sh'), str(self.archive)],
                            input='yes\n', env=env or self.env)

    def test_sensitive_ciphertext_roundtrip_and_security_invalidation(self):
        with tarfile.open(self.archive) as tf:
            manifest = json.load(tf.extractfile('./backup-manifest.json'))
            self.assertEqual(manifest['requiredContentKeyIds'], ['historical'])
            names = tf.getnames()
            self.assertFalse(any('key' in name for name in names))
            self.assertFalse(any(name.endswith(('-wal', '-shm')) for name in names))
            for member in tf.getmembers():
                if member.isfile():
                    self.assertNotIn(b'synthetic restore private', tf.extractfile(member).read())
        # Create a distinct current target, proving replacement and rollback preservation.
        marker = self.data / 'current-target-only.txt'
        marker.write_text('synthetic-current-state')
        result = self.restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(marker.exists())
        self.assertEqual((self.data / 'users' / self.fixture['userId'] / 'messages.json').read_bytes(), self.original)
        old = list(self.project.glob('.restore-old-*'))
        self.assertEqual(len(old), 1)
        self.assertEqual((old[0] / marker.name).read_text(), 'synthetic-current-state')
        self.assertEqual(len(list(self.project.glob('data.rollback-*.tar.gz'))), 1)
        self.assertFalse(list(self.project.glob('.restore-stage.*')))
        self.assertFalse(list(self.project.glob('.restore-input.*')))
        with sqlite3.connect(self.data / 'donote.db') as db:
            self.assertEqual(db.execute('pragma integrity_check').fetchone()[0], 'ok')
            self.assertIsNone(db.execute('pragma foreign_key_check').fetchone())
            self.assertEqual(db.execute('select security_version from users').fetchone()[0], 2)
            for table, column in [('sessions', 'revoked_at'), ('login_challenges', 'consumed_at'), ('operation_grants', 'consumed_at'), ('recovery_codes', 'consumed_at')]:
                self.assertGreater(db.execute(f'select count(*) from {table}').fetchone()[0], 0)
                self.assertEqual(db.execute(f'select count(*) from {table} where {column} is null').fetchone()[0], 0)
        # Verify restored ciphertext through the product keyring and old cookie rejection
        # through the real authService/repository, independently of the Docker stub.
        self.node(r'''
const fs=require('node:fs'),assert=require('node:assert/strict');
const {openDatabase}=require(process.argv[1]+'/app/src/db');
const {createRepositories}=require(process.argv[1]+'/app/src/db/repositories');
const {createAuthService}=require(process.argv[1]+'/app/src/security/auth-service');
const {createSensitiveKeyring}=require(process.argv[1]+'/app/src/security/sensitive');
const {SECURITY_MIGRATION}=require(process.argv[1]+'/app/src/db/schema');
const db=openDatabase({storageRoot:process.argv[2],migrations:[SECURITY_MIGRATION]}),repo=createRepositories(db);
const service=createAuthService({repo,allowedOrigins:['https://synthetic.test'],encryptionKey:fs.readFileSync(process.argv[3]),keyId:'primary'});
assert.throws(()=>service.authenticateRequest({headers:{cookie:service.cookieName+'='+process.argv[6]}}),error=>error.status===401);
const c=JSON.parse(fs.readFileSync(process.argv[4]));
const ring=createSensitiveKeyring({activeKeyId:c.activeKeyId,keys:Object.fromEntries(Object.entries(c.keys).map(([id,k])=>[id,Buffer.from(k,'base64')]))});
const record=JSON.parse(fs.readFileSync(process.argv[2]+'/users/'+process.argv[5]+'/messages.json')).messages[0];
assert.deepEqual(ring.decrypt(record.encryptedPayload,{userId:process.argv[5],messageId:record.id}),{content:'synthetic restore private body',remark:'synthetic restore private remark'});
ring.close();db.close();console.log('restored ciphertext authenticated; old session rejected');
''', str(ROOT), str(self.data), str(self.auth), str(self.ring), self.fixture['userId'], self.fixture['token'])
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertIn(['compose', 'stop', 'app'], calls)
        self.assertIn(['compose', 'start', 'app'], calls)
        self.assertNotIn('synthetic restore private', result.stdout + result.stderr)

    def test_nonempty_wal_pages_are_included_in_snapshot(self):
        # Hold a real writer connection open with committed, uncheckpointed WAL.
        # This proves the immutable fast path cannot silently ignore WAL pages.
        with sqlite3.connect(self.data / 'donote.db') as source:
            source.execute('pragma journal_mode=wal')
            source.execute('pragma wal_autocheckpoint=0')
            source.execute("update users set display_name='committed-in-wal'")
            source.commit()
            self.assertGreater(Path(str(self.data / 'donote.db') + '-wal').stat().st_size, 0)
            output = self.root / 'wal-backup.tar.gz'
            result = self.run_cmd(['python3', str(ROOT / 'scripts/lib/sqlite-backup.py'), str(self.data), str(output),
                                   '--key', str(self.auth), '--content-keyring', str(self.ring), '--confirmed'], env=self.env)
            # Reader lock bytes may change SHM; the complete offline wrapper
            # must reject that inventory change instead of overlooking it.
            if result.returncode:
                self.assertIn('data changed during backup', result.stderr)
                self.assertFalse(output.exists())
            snapshot = self.root / 'snapshot.db'
            checked = self.run_cmd(['python3', '-c',
                'import importlib.util,sys; from pathlib import Path; '
                's=importlib.util.spec_from_file_location("backup",sys.argv[1]); '
                'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
                'm.check_db(Path(sys.argv[2]),Path(sys.argv[3]))',
                str(ROOT / 'scripts/lib/sqlite-backup.py'), str(self.data / 'donote.db'), str(snapshot)])
            self.assertEqual(checked.returncode, 0, checked.stderr)
            with sqlite3.connect(snapshot) as restored:
                self.assertEqual(restored.execute('select display_name from users').fetchone()[0], 'committed-in-wal')

    def test_missing_historical_key_aborts_before_docker_or_replacement(self):
        self.write_ring({'version': 1, 'activeKeyId': 'current', 'keys': {'current': self.ring_config['keys']['current']}})
        result = self.restore()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())
        self.assertEqual((self.data / 'users' / self.fixture['userId'] / 'messages.json').read_bytes(), self.original)
        self.assertFalse(list(self.project.glob('.restore-input.*')))
        self.assertFalse(list(self.project.glob('.restore-old-*')))

    def test_wrong_auth_key_aborts_before_docker_or_replacement(self):
        wrong = self.root / 'wrong-auth-key'
        wrong.write_bytes(os.urandom(32))
        wrong.chmod(0o600)
        result = self.restore(dict(self.env, AUTH_KEY_FILE=str(wrong)))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('key identity mismatch', result.stderr)
        self.assertFalse(self.log.exists())
        self.assertEqual((self.data / 'users' / self.fixture['userId'] / 'messages.json').read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
