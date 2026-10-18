#!/usr/bin/env python3
import hashlib, json, os, sqlite3, subprocess, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
SCRIPT=ROOT/'scripts/lib/sqlite-backup.py'; VALID=ROOT/'scripts/lib/restore-validate.py'
class AccountsBackup(unittest.TestCase):
 def test_real_snapshot_and_manifest(self):
  with tempfile.TemporaryDirectory(prefix='accounts-') as d:
   root=Path(d); data=root/'data'; data.mkdir(); db=data/'donote.db'; key=root/'key'; key.write_bytes(b'k'*32); os.chmod(key,0o600)
   (data/'users'/'u').mkdir(parents=True); (data/'users'/'u'/'messages.json').write_text('{"messages":[]}',encoding='utf-8')
   c=sqlite3.connect(db); c.executescript('create table schema_migrations(version integer); create table users(id text); create table sessions(id text); create table login_challenges(id text); create table operation_grants(id text); create table recovery_codes(id text); create table totp_credentials(id text); create table audit_log(id text); insert into schema_migrations values(1)'); c.commit(); c.close()
   out=root/'a.tar.gz'; p=subprocess.run(['python3',str(SCRIPT),str(data),str(out),'--key',str(key),'--confirmed'],capture_output=True,text=True); self.assertEqual(p.returncode,0,p.stderr)
   self.assertEqual(subprocess.run(['python3',str(VALID),str(out)]).returncode,0); self.assertTrue(out.exists())
 def test_confirmation_and_key_are_required(self):
  with tempfile.TemporaryDirectory() as d:
   data=Path(d); (data/'donote.db').write_bytes(b'x'); out=data/'x'; key=data/'key'; key.write_bytes(b'k'*32); os.chmod(key,0o600)
   self.assertNotEqual(subprocess.run(['python3',str(SCRIPT),str(data),str(out),'--key',str(key)]).returncode,0)
 def test_wrong_key_fixture_is_distinct(self):
  with tempfile.TemporaryDirectory(prefix='accounts-') as d:
   root=Path(d); key=root/'key'; wrong=root/'wrong'; key.write_bytes(b'k'*32); wrong.write_bytes(b'w'*32); os.chmod(key,0o600); os.chmod(wrong,0o600)
   self.assertNotEqual(hashlib.sha256(key.read_bytes()).hexdigest(), hashlib.sha256(wrong.read_bytes()).hexdigest())
   self.assertFalse(list(root.glob('.restore-input.*')))
if __name__=='__main__': unittest.main()
