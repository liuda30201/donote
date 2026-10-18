#!/usr/bin/env python3
"""Isolated real nginx TLS acceptance with host synthetic app, NOT final app image.
Default is static preparation; --execute runs only cached nginx:1.27-alpine.
Optional --docker-host selects an explicit daemon without modifying Docker context.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import tempfile
import time

REPO = Path(__file__).resolve().parents[3]


def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{argv[0]} failed ({result.returncode}): {result.stderr[-1200:]}')
    return result.stdout


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--docker-host')
    args = parser.parse_args()
    docker = ['docker'] + (['-H', args.docker_host] if args.docker_host else [])
    nonce = secrets.token_hex(8)
    name = 'donote-proxy-acceptance-' + nonce
    label = 'donote.proxy.acceptance'
    app = None
    container = False
    results = {}
    with tempfile.TemporaryDirectory(prefix=name + '-') as temporary:
        root = Path(temporary).resolve()
        conf = root / 'conf.d'
        conf.mkdir()
        data = root / 'data'
        data.mkdir(mode=0o700)
        certs = root / 'certs'
        certs.mkdir()
        (root / 'acme').mkdir()
        app_port, tls_port = port(), port()
        origin = f'https://node.7705.work:{tls_port}'
        source_hashes = {}
        for source in sorted((REPO / 'nginx/conf.d').glob('*.conf')):
            original = source.read_text()
            source_hashes[source.name] = hashlib.sha256(original.encode()).hexdigest()
            # Preserve all route/security rules and server_name. Only upstream changes.
            (conf / source.name).write_text(original.replace('http://app:3000', f'http://host.docker.internal:{app_port}'))
        shutil.copyfile(REPO / 'nginx/security-headers.inc', root / 'security-headers.inc')
        source_hashes['security-headers.inc'] = hashlib.sha256((root / 'security-headers.inc').read_bytes()).hexdigest()
        openssl = shutil.which('openssl')
        if not openssl:
            raise RuntimeError('openssl unavailable')
        run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=node.7705.work', '-addext', 'subjectAltName=DNS:node.7705.work', '-keyout', str(certs / 'privkey.pem'), '-out', str(certs / 'fullchain.pem')])
        (certs / 'privkey.pem').chmod(0o600)
        shutil.copyfile(certs / 'privkey.pem', certs / 'selfsigned.key')
        (certs / 'selfsigned.key').chmod(0o600)
        shutil.copyfile(certs / 'fullchain.pem', certs / 'selfsigned.crt')
        if not args.execute:
            print(json.dumps({'static_preparation': 'PASS', 'config_sha256': source_hashes, 'config_change': 'only app upstream -> host.docker.internal random port', 'real_nginx': 'NOT RUN'}, indent=2))
            return
        try:
            # Never pull or build; fail if this exact image is not cached.
            run(docker + ['image', 'inspect', 'nginx:1.27-alpine'])
            password = 'Synthetic-proxy-' + secrets.token_hex(16)
            key = root / 'auth-key'
            key.write_bytes(secrets.token_bytes(32))
            key.chmod(0o600)
            seed = """const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));const {openDatabase}=require('./src/db');const {SECURITY_MIGRATION}=require('./src/db/schema');const {createRepositories}=require('./src/db/repositories');const p=require('./src/security/primitives');(async()=>{const h=await p.hashPassword(x.password);const db=openDatabase({storageRoot:x.data,migrations:[SECURITY_MIGRATION]});createRepositories(db).createUser({username:'proxyreview',displayName:'Synthetic proxy',passwordHash:h,role:'user',mustChangePassword:false});db.close();})().catch(()=>process.exit(1));"""
            run(['node', '-e', seed], cwd=REPO / 'app', input=json.dumps({'data': str(data), 'password': password}))
            env = {'PATH': os.environ['PATH'], 'AUTH_MODE': 'accounts', 'AUTH_ORIGIN': origin, 'AUTH_KEY_ID': 'proxy-acceptance', 'AUTH_KEY_FILE': str(key), 'STORAGE_ROOT': str(data), 'PORT': str(app_port)}
            app = subprocess.Popen(['node', 'server.js'], cwd=REPO / 'app', env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                try:
                    conn = http.client.HTTPConnection('127.0.0.1', app_port, timeout=1)
                    conn.request('GET', '/api/version')
                    status = conn.getresponse().status
                    conn.close()
                    if status == 200:
                        break
                except OSError:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError('Synthetic upstream did not start')
            mounts = []
            for source, target in [(conf, '/etc/nginx/conf.d'), (certs, '/etc/nginx/certs'), (root / 'security-headers.inc', '/etc/nginx/security-headers.inc'), (root / 'acme', '/var/www/acme')]:
                mounts += ['--mount', f'type=bind,source={source},target={target},readonly']
            # Exact random fixture identity is recorded before start, including failed starts.
            run(docker + ['create', '--name', name, '--label', f'{label}={nonce}', '--pull=never', '-p', f'127.0.0.1:{tls_port}:443'] + mounts + ['nginx:1.27-alpine'])
            container = True
            run(docker + ['start', name])
            run(docker + ['exec', name, 'nginx', '-t'])
            results['nginx_config_test'] = True
            context = ssl.create_default_context(cafile=str(certs / 'fullchain.pem'))

            def request(method, url, body=None, cookie=None, extra=None):
                # SNI and Host retain repository hostname; TCP destination is loopback.
                raw = socket.create_connection(('127.0.0.1', tls_port), timeout=5)
                tls = context.wrap_socket(raw, server_hostname='node.7705.work')
                conn = http.client.HTTPConnection('node.7705.work', tls_port, timeout=5)
                conn.sock = tls
                headers = {'Host': f'node.7705.work:{tls_port}', 'Origin': origin}
                if body is not None:
                    body = json.dumps(body)
                    headers['Content-Type'] = 'application/json'
                if cookie:
                    headers['Cookie'] = cookie
                headers.update(extra or {})
                conn.request(method, url, body, headers)
                response = conn.getresponse()
                result = (response.status, response.headers, response.read())
                conn.close()
                return result

            def security(headers):
                assert headers.get('Strict-Transport-Security')
                assert headers.get('X-Content-Type-Options') == 'nosniff'
                assert headers.get('X-Frame-Options') == 'SAMEORIGIN'
                assert headers.get('Referrer-Policy') == 'same-origin'
                assert headers.get('Content-Security-Policy')

            for _ in range(50):
                try:
                    status, headers, body = request('GET', '/healthz')
                    assert status == 200 and body == b'ok\n'
                    security(headers)
                    break
                except (OSError, AssertionError):
                    time.sleep(0.1)
            else:
                raise RuntimeError('TLS nginx readiness failed')
            results['tls_verified_health_headers'] = True
            status, headers, _ = request('GET', '/api/messages')
            assert status == 401
            security(headers)
            assert 'no-store' in headers.get('Cache-Control', '')
            results['anonymous_api_401_headers'] = True
            status, headers, _ = request('GET', '/api/auth/me')
            assert status == 401 and 'no-store' in headers.get('Cache-Control', '')
            security(headers)
            results['anonymous_auth_me_401'] = True
            status, headers, body = request('POST', '/api/auth/login', {'username': 'proxyreview', 'password': password})
            assert status == 200, f'login status {status}'
            security(headers)
            assert 'no-store' in headers.get('Cache-Control', '')
            cookie_header = headers.get('Set-Cookie', '')
            assert '__Host-dn_session=' in cookie_header and 'HttpOnly' in cookie_header and 'Secure' in cookie_header and 'SameSite=Lax' in cookie_header
            cookie = cookie_header.split(';')[0]
            results['login_secure_cookie_no_store_headers'] = True
            status, headers, body = request('GET', '/api/auth/me', cookie=cookie)
            assert status == 200
            csrf = json.loads(body)['csrfToken']
            results['cookie_me'] = True
            status, headers, body = request('GET', '/api/messages', cookie=cookie)
            assert status == 200 and 'no-store' in headers.get('Cache-Control', '')
            security(headers)
            results['authenticated_api'] = True
            status, _, body = request('GET', '/socket.io/?EIO=4&transport=polling', cookie=cookie)
            assert status == 200 and body.startswith(b'0')
            results['engine_polling_through_auth_request'] = True
            status, _, _ = request('POST', '/api/auth/logout', {}, cookie=cookie, extra={'X-CSRF-Token': csrf})
            assert status == 200
            status, _, _ = request('GET', '/api/messages', cookie=cookie)
            assert status == 401
            results['logout_revokes_proxy_access'] = True
            print(json.dumps({'kind': 'real-nginx-TLS-host-synthetic-upstream', 'results': results, 'config_sha256': source_hashes, 'limitations': ['not final app image', 'ordinary password account only; no TOTP or browser Socket namespace/upgrade verified']}, indent=2))
        finally:
            if container:
                owned = json.loads(run(docker + ['inspect', name]))[0]
                if owned['Name'] != '/' + name or owned['Config']['Labels'].get(label) != nonce:
                    raise RuntimeError('Ownership mismatch; refusing removal')
                run(docker + ['rm', '-f', name])
            if app is not None:
                app.terminate()
                try:
                    app.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    app.kill()
                    app.wait(timeout=5)


if __name__ == '__main__':
    main()
