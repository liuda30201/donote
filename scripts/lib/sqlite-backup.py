#!/usr/bin/env python3
import argparse,hashlib,json,os,shutil,sqlite3,stat,tarfile,tempfile,subprocess
from pathlib import Path

def fail(message): raise SystemExit(message)
def digest(path):
 h=hashlib.sha256(); size=0
 with open(path,'rb') as stream:
  for chunk in iter(lambda:stream.read(1048576),b''): h.update(chunk); size+=len(chunk)
 return size,h.hexdigest()
def regular(path):
 st=os.lstat(path)
 if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1: fail('unsafe regular file')
def inventory(root,key):
 out=[]
 for base,dirs,files in os.walk(root,followlinks=False):
  bp=Path(base)
  for name in list(dirs):
   if (bp/name).is_symlink(): fail('unsafe directory symlink')
  dirs[:]=sorted(name for name in dirs if name!='temp')
  for name in dirs: out.append(('dir:'+str((bp/name).relative_to(root)),stat.S_IMODE(os.lstat(bp/name).st_mode)))
  for name in sorted(files):
   p=bp/name
   if p.is_symlink(): fail('unsafe file symlink')
   if name in ('donote.db','donote.db-wal','donote.db-shm','messages.json.tmp') or p==key: continue
   regular(p); size,sha=digest(p); out.append(('file:'+str(p.relative_to(root)),size,sha))
 for name in ('donote.db','donote.db-wal','donote.db-shm'):
  p=root/name
  if p.exists() or p.is_symlink():
   if p.is_symlink(): fail('unsafe SQLite symlink')
   regular(p); size,sha=digest(p); out.append(('sqlite:'+name,size,sha))
 return sorted(out)
def check_db(source,dest):
 src=target=None
 try:
  # A cleanly closed WAL database has no sidecars. Normal mode=ro reads
  # recreate WAL/SHM even without writers, invalidating our source inventory.
  # immutable is safe only for that offline, sidecar-free state: never use it
  # when a WAL may contain committed pages absent from the main database.
  sidecars=any(Path(str(source)+suffix).exists() for suffix in ('-wal','-shm'))
  uri=source.resolve().as_uri()+'?mode=ro'+('' if sidecars else '&immutable=1')
  src=sqlite3.connect(uri,uri=True); target=sqlite3.connect(dest); src.backup(target); target.commit(); target.execute('PRAGMA foreign_keys=ON')
  if target.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or target.execute('PRAGMA foreign_key_check').fetchone() is not None: fail('SQLite integrity failure')
  names={row[0] for row in target.execute("select name from sqlite_master where type='table'")}
  required={'schema_migrations','users','sessions','login_challenges','operation_grants','recovery_codes','totp_credentials','audit_log'}
  if not required<=names or target.execute('select version from schema_migrations where version=1').fetchone() is None: fail('SQLite schema contract missing')
 finally:
  if src: src.close()
  if target: target.close()
def inspect_content(root,keyring,auth_key):
 if any(p.name.startswith('.sensitive-rotation') for p in root.iterdir()): fail('sensitive rotation journal must be moved outside data root')
 cmd=[os.environ.get('NODE','node'),str(Path(__file__).with_name('content-backup.js')),'inspect',str(root)]
 if keyring: cmd+=['--keyring',str(keyring)]
 if auth_key: cmd+=['--auth-key',str(auth_key)]
 return json.loads(subprocess.run(cmd,check=True,capture_output=True,text=True).stdout)
def main():
 parser=argparse.ArgumentParser(); parser.add_argument('data'); parser.add_argument('archive'); parser.add_argument('--key',required=True); parser.add_argument('--key-id',default='primary'); parser.add_argument('--content-keyring'); parser.add_argument('--confirmed',action='store_true'); args=parser.parse_args()
 if not args.confirmed: fail('accounts backup requires --confirmed')
 if any(os.path.islink(p) for p in (args.data,args.archive,args.key)): fail('root/archive/key symlink forbidden')
 root=Path(args.data).resolve(); output=Path(args.archive).resolve(); key=Path(args.key).resolve()
 if not root.is_dir() or root in output.parents: fail('unsafe paths')
 regular(key)
 if stat.S_IMODE(key.stat().st_mode)!=0o600 or key.stat().st_size!=32 or root in key.parents: fail('key must be external 0600 32-byte')
 if args.content_keyring and os.path.islink(args.content_keyring): fail('content keyring symlink forbidden')
 db=root/'donote.db'; regular(db)
 with tempfile.TemporaryDirectory(prefix='donote-sqlite-snapshot-') as td:
  if args.content_keyring and os.path.islink(args.content_keyring): fail('content keyring symlink forbidden')
  content=inspect_content(root,args.content_keyring,key)
  before=inventory(root,key); snapshot=Path(td)/'donote.db'; check_db(db,snapshot); size,sha=digest(snapshot); fingerprint=hashlib.sha256(key.read_bytes()).hexdigest(); stage=Path(td)/'tree'; stage.mkdir()
  entries=[]
  for base,dirs,files in os.walk(root,followlinks=False):
   bp=Path(base); rel=bp.relative_to(root)
   if str(rel)!='.': stage.joinpath(rel).mkdir(parents=True,exist_ok=True); entries.append({'path':str(rel),'type':'directory','mode':stat.S_IMODE(os.lstat(bp).st_mode)})
   for name in sorted(files):
    src=bp/name
    if name in ('donote.db','donote.db-wal','donote.db-shm','messages.json.tmp'): continue
    regular(src); dst=stage/src.relative_to(root); dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst); copied_size,copied_sha=digest(dst)
    if (copied_size,copied_sha)!=digest(src): fail('copied file changed during backup')
    entries.append({'path':str(src.relative_to(root)),'type':'file','size':copied_size,'sha256':copied_sha,'mode':stat.S_IMODE(os.lstat(src).st_mode)})
  if inventory(root,key)!=before: fail('data changed during backup')
  shutil.copy2(snapshot,stage/'donote.db'); entries.append({'path':'donote.db','type':'file','size':size,'sha256':sha,'mode':0o600})
  manifest={'format':'donote-backup','formatVersion':2,'storageMode':'accounts','consistency':'sqlite-offline-backup','sqliteSnapshot':{'path':'donote.db','size':size,'sha256':sha,'integrityCheck':'ok','foreignKeyCheck':'ok','schemaVersion':1},'keyId':args.key_id,'keyFingerprint':fingerprint,'requiresExternalAuthKey':True,'requiredContentKeyIds':content['requiredContentKeyIds'],'checksumAlgorithm':'sha256','entries':entries}
  (stage/'backup-manifest.json').write_text(json.dumps(manifest)+'\n'); output.parent.mkdir(mode=0o700,exist_ok=True); tmp=output.with_name('.'+output.name+'.tmp')
  with tarfile.open(tmp,'w:gz') as archive: archive.add(stage,arcname='.')
  os.chmod(tmp,0o600); os.replace(tmp,output)
 print('Accounts backup verified')
if __name__=='__main__': main()
