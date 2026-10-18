#!/usr/bin/env python3
"""Isolated exact Node24 target-image acceptance. Never uses Compose/data/env.
Default is dry-run; --docker-host selects endpoint without changing context.
"""
import argparse
import json
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[3]
BASE = 'node:24-bookworm-slim'
OWNER = 'donote.acceptance'


def command(args, *, stdin=None, timeout=180):
    result = subprocess.run(args, input=stdin, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr[-2500:]}')
    return result.stdout


def inspect_owned(docker, kind, target, nonce):
    argv = docker + (['image', 'inspect'] if kind == 'image' else ['container', 'inspect']) + [target]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    if result.returncode:
        # Only explicit not-found is safe absence; daemon failure must be reported.
        if 'No such image' in result.stderr or 'No such container' in result.stderr or 'No such object' in result.stderr:
            return None
        raise RuntimeError(f'Cannot verify cleanup ownership for {target}: {result.stderr[-500:]}')
    item = json.loads(result.stdout)[0]
    if (item.get('Config', {}).get('Labels') or {}).get(OWNER) != nonce:
        raise RuntimeError(f'Ownership mismatch for {target}; refusing cleanup')
    if kind == 'container' and item['Name'] != '/' + target:
        raise RuntimeError('Container name mismatch; refusing cleanup')
    return item


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--docker-host')
    args = parser.parse_args()
    docker = ['docker'] + (['-H', args.docker_host] if args.docker_host else [])
    dockerfile = REPO / 'app/Dockerfile'
    stages = [line.split() for line in dockerfile.read_text().splitlines() if line.strip().upper().startswith('FROM ')]
    if len(stages) != 1 or stages[0][1] != BASE:
        raise RuntimeError(f'Target Dockerfile must use exactly FROM {BASE}')
    if not args.execute:
        print(json.dumps({'mode': 'dry-run', 'base': BASE, 'endpoint': args.docker_host or 'current configured endpoint', 'isolation': 'unique labels; synthetic temp root/key; random loopback port; no Compose', 'executed': False}, indent=2))
        return
    # Preflight occurs before any resource creation. Never start a daemon or pull a substitute.
    command(docker + ['version'], timeout=15)
    nonce = secrets.token_hex(12)
    name = 'donote-acceptance-' + nonce
    image = name + ':review'
    label = OWNER + '=' + nonce
    build_attempted = create_attempted = False
    results = {}
    temporary = tempfile.TemporaryDirectory(prefix=name + '-')
    root = Path(temporary.name).resolve()
    cleanup_errors = []
    try:
        build_attempted = True
        command(docker + ['build', '--label', label, '-t', image, str(REPO / 'app')], timeout=900)
        inspect_owned(docker, 'image', image, nonce)
        data = root / 'data'
        data.mkdir()
        key = root / 'key'
        key.write_bytes(secrets.token_bytes(32))
        key.chmod(0o600)
        env = root / 'synthetic.env'
        env.write_text('AUTH_MODE=accounts\nAUTH_ORIGIN=http://127.0.0.1\nAUTH_DEV_HTTP=1\nAUTH_KEY_FILE=/run/acceptance-key\nAUTH_KEY_ID=acceptance\nSTORAGE_ROOT=/app/data\n')
        env.chmod(0o600)
        # Separate create/start: failures after creation still enter ownership-checked cleanup.
        create_attempted = True
        command(docker + ['create', '--name', name, '--label', label, '--pull=never', '--env-file', str(env), '--mount', f'type=bind,source={data},target=/app/data', '--mount', f'type=bind,source={key},target=/run/acceptance-key,readonly', '-p', '127.0.0.1::3000', image])
        inspect_owned(docker, 'container', name, nonce)
        command(docker + ['start', name])
        inspected = inspect_owned(docker, 'container', name, nonce)
        binding = inspected['NetworkSettings']['Ports']['3000/tcp'][0]
        assert binding['HostIp'] == '127.0.0.1'
        # The daemon endpoint can inherit a global HTTP proxy. Never proxy the
        # fixture's loopback health traffic through that external proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = 'http://127.0.0.1:' + binding['HostPort']
        readiness_errors = []
        for _ in range(100):
            try:
                with opener.open(base + '/api/version', timeout=1) as response:
                    results['health'] = response.status == 200
                break
            except (OSError, urllib.error.URLError) as error:
                readiness_errors.append(repr(error))
                time.sleep(0.1)
        if not results.get('health'):
            logs = subprocess.run(docker + ['logs', name], capture_output=True, text=True, timeout=30)
            raise AssertionError(f"isolated app failed readiness at {base}; last errors: {readiness_errors[-5:]}; container logs: {(logs.stdout + logs.stderr)[-5000:]}")
        native = command(docker + ['exec', '-i', name, 'node'], stdin="""
(async()=>{if(process.versions.node.split('.')[0]!=='24')throw Error('requires Node24');const DB=require('better-sqlite3');const d=new DB(':memory:');d.exec('create table x(v integer)');d.close();const a=require('argon2');const h=await a.hash('synthetic-native-only');if(!await a.verify(h,'synthetic-native-only'))throw Error('argon verification');console.log('native modules PASS');})().catch(()=>process.exit(1));
""")
        results['node24_native_sqlite_argon2'] = 'PASS' in native
        try:
            opener.open(base + '/api/auth/me', timeout=3)
            raise AssertionError('unauthenticated /me accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 401
            results['unauthenticated_no_store'] = 'no-store' in error.headers.get('Cache-Control', '')
        command(docker + ['kill', '--signal', 'TERM', name])
        results['sigterm_exit_zero'] = command(docker + ['wait', name], timeout=35).strip() == '0'
        results['database_created'] = (data / 'donote.db').is_file()
        assert all(results.values()), results
        print(json.dumps({'kind': 'exact-node24-target-image', 'results': results}, indent=2))
    finally:
        # Attempt cleanup even when build/create returned nonzero or timed out after success.
        # Keep bound data/key available until the owned container is removed.
        for kind, target, attempted in [('container', name, create_attempted), ('image', image, build_attempted)]:
            if not attempted:
                continue
            try:
                owned = inspect_owned(docker, kind, target, nonce)
                if owned:
                    command(docker + (['image', 'rm', target] if kind == 'image' else ['rm', '-f', target]))
            except Exception as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            # Do not erase bind sources while ownership/removal is uncertain.
            temporary._finalizer.detach()
            raise RuntimeError('Cleanup incomplete; retained synthetic root ' + str(root) + '; ' + '; '.join(cleanup_errors))
        temporary.cleanup()


if __name__ == '__main__':
    main()
