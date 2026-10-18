# Isolated Nginx TLS proxy acceptance

## Result and boundary

PASS: cached `nginx:1.27-alpine` ran against a host Node 24 synthetic accounts application. This is evidence for the repository Nginx proxy configuration, not for the final app Docker image or deployment. The app image remains unverified because earlier image builds failed fetching the Node base manifest from Docker Hub.

The default OrbStack socket was missing. A read-only check found the Docker Engine reachable through `unix:///var/run/docker.sock`; the successful isolated run selected that endpoint explicitly without changing Docker context, starting the daemon, or touching existing containers.

## Reproduce

```sh
# Static preparation: copies configs and creates only temporary synthetic TLS files.
python3 app/test/verifier-review/proxy-acceptance.py

# Real proxy run: requires an already cached nginx:1.27-alpine.
python3 app/test/verifier-review/proxy-acceptance.py --execute --docker-host unix:///var/run/docker.sock
```

The fixture never pulls or builds an image. It copies all repository `nginx/conf.d/*.conf` and `nginx/security-headers.inc` to a temporary directory and changes only `http://app:3000` upstream URLs to `host.docker.internal:<random-port>`. Hostname, route matching, security headers, auth subrequests, TLS settings, certificate paths, and Socket.IO proxy settings are preserved. Temporary certificates use the existing expected filenames. The published TLS port is random and bound only to `127.0.0.1`.

The synthetic app uses a temporary database, private 32-byte key, explicit test key ID, synthetic ordinary account, and exact HTTPS origin. It does not read `.env`, Compose-managed data, existing certificates, or browser profiles. Its port is reachable from Docker for the proxy test. A unique container name and ownership label are verified before cleanup; only that container and the temporary directory are removed. The cached image is retained. The app child is terminated and awaited during cleanup.

## Observed checks

- `nginx -t` passed inside the isolated running container.
- TLS connected to the loopback published port with `node.7705.work` SNI. Certificate verification used the fixture CA certificate; verification was not disabled.
- `/healthz` returned `200` and `ok`, with HSTS, nosniff, frame, referrer and CSP headers.
- Anonymous `/api/messages` and `/api/auth/me` returned `401`, `Cache-Control: no-store`, and security headers.
- Password login returned `200`, no-store and security headers, and a `__Host-dn_session` cookie containing `Secure`, `HttpOnly`, `SameSite=Lax`.
- The cookie authenticated `/api/auth/me` and `/api/messages`; authenticated API no-store/security headers were preserved.
- Engine.IO polling open succeeded through the auth-request-protected Socket.IO location.
- CSRF-protected logout succeeded; reusing the revoked cookie for the protected API returned `401`.

The successful execute run exited 0 and completed ownership-checked cleanup. No fixture containers or app processes remain.

## Limits

This does not verify target-image Node/native modules, app-container networking, TOTP through TLS, a real Chrome TLS session, full Socket.IO namespace authorization/upgrade, or OS/browser BFCache navigation. Engine.IO open alone is not a completed Socket.IO application connection. The separate host real-Chrome fixture covers TOTP and full browser workspace/session behavior without this TLS proxy. No production data or deployment was tested.

Configuration SHA-256 values used by the successful run:

```text
00-shared.conf       9bbf226124888d1aaa3c8d5ad8e854229c1a2a9ae84cd1cb9b59ad12f10f8588
10-default.conf      dec30ff5b569c5887bb47f11e577b7847443468b1173d03134858318c08d8bcc
20-clipboard.conf    6f52e4419968e8b61b05f4a3bed64dbce567e0ff8eab891de569354e49a72170
security-headers.inc f4a37bbbb6bddbe673464cecfed74557b22ad32aea2da05724ac876992e241a4
```
