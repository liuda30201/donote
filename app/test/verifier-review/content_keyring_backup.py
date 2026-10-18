#!/usr/bin/env python3
import json, os, subprocess, tempfile, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
HELPER=ROOT/'scripts/lib/content-backup.js'
NODE=os.environ.get('NODE','node')
class ContentKeyBackup(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='content-key-backup-'); self.addCleanup(self.temp.cleanup)
  self.root=Path(self.temp.name); self.data=self.root/'data'; (self.data/'users'/'user-a').mkdir(parents=True)
  self.ring=self.root/'keyring.json'; self.key1=bytes(range(32)); self.key2=bytes(reversed(range(32)))
  self.write_ring({'content-old':self.key1,'content-new':self.key2})
 def write_ring(self, keys):
  self.ring.write_text(json.dumps({'version':1,'activeKeyId':'content-new','keys':{k:v.hex() for k,v in keys.items()}}))
  # Replace hex with the required canonical base64 encoding.
  import base64
  value=json.loads(self.ring.read_text()); value['keys']={k:base64.b64encode(v).decode() for k,v in keys.items()}; self.ring.write_text(json.dumps(value)); os.chmod(self.ring,0o600)
 def create_record(self, key, key_id='content-old'):
  fixture=self.root/'fixture.json'; fixture.write_text(json.dumps({'version':1,'activeKeyId':key_id,'keys':{key_id:__import__('base64').b64encode(key).decode()}})); os.chmod(fixture,0o600)
  script="const s=require(process.argv[1]); const k=Buffer.from(process.argv[2],'base64'); const r=s.createSensitiveKeyring({activeKeyId:process.argv[3],keys:{[process.argv[3]]:k}}); console.log(JSON.stringify(r.encrypt({content:'synthetic secret',remark:'synthetic remark'},{userId:'user-a',messageId:'m1'}))); r.close();"
  encoded=__import__('base64').b64encode(key).decode()
  payload=json.loads(subprocess.check_output([NODE,'-e',script,str(ROOT/'app/src/security/sensitive.js'),encoded,key_id],text=True))
  (self.data/'users'/'user-a'/'messages.json').write_text(json.dumps({'messages':[{'id':'m1','type':'text','sensitive':True,'content':None,'remark':'','encryptedPayload':payload}]}))
  return payload
 def inspect(self, ring=None):
  return subprocess.run([NODE,str(HELPER),'inspect',str(self.data),'--keyring',str(ring or self.ring)],capture_output=True,text=True)
 def test_collects_ids_and_authenticates_all_records(self):
  self.create_record(self.key1)
  result=self.inspect(); self.assertEqual(result.returncode,0,result.stderr)
  self.assertEqual(json.loads(result.stdout)['requiredContentKeyIds'],['content-old'])
 def test_missing_historical_key_fails_closed(self):
  self.create_record(self.key1); self.write_ring({'content-new':self.key2})
  self.assertNotEqual(self.inspect().returncode,0)
 def test_wrong_key_with_same_id_fails_closed(self):
  self.create_record(self.key1); self.write_ring({'content-old':self.key2,'content-new':bytes([9])*32})
  self.assertNotEqual(self.inspect().returncode,0)
 def test_tamper_fails_closed_without_plaintext_output(self):
  payload=self.create_record(self.key1); payload['content']['ciphertext']=('A' if payload['content']['ciphertext'][0]!='A' else 'B')+payload['content']['ciphertext'][1:]
  (self.data/'users'/'user-a'/'messages.json').write_text(json.dumps({'messages':[{'id':'m1','type':'text','sensitive':True,'content':None,'remark':'','encryptedPayload':payload}]}))
  result=self.inspect(); self.assertNotEqual(result.returncode,0); self.assertNotIn('synthetic secret',result.stdout+result.stderr)
 def test_plaintext_and_journal_fail_closed(self):
  (self.data/'users'/'user-a'/'messages.json').write_text(json.dumps({'messages':[{'id':'m1','type':'text','sensitive':True,'content':'plaintext','remark':'','encryptedPayload':{}}]}))
  self.assertNotEqual(self.inspect().returncode,0)
  (self.data/'users'/'user-a'/'messages.json').write_text('{"messages":[]}')
  (self.data/'.sensitive-rotation.tmp-test').mkdir()
  self.assertNotEqual(self.inspect().returncode,0)
if __name__=='__main__': unittest.main()
