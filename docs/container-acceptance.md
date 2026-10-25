# G01 isolated container acceptance

## Scope and safety boundary

`app/test/verifier-review/container-acceptance.py` is an opt-in acceptance fixture. It does not load either Compose file, the repository `.env`, existing `data`, existing certificates, or an existing Docker container. It uses a unique image/container name and Docker label, a temporary synthetic data directory, a temporary 0600 32-byte key with an explicit synthetic key ID, and a host-random published loopback port. Cleanup first verifies the exact ownership label before removing the fixture image/container.

Run the dry-run plan with:

```sh
python3 app/test/verifier-review/container-acceptance.py
```

Execute isolated image acceptance when the Docker registry is reachable:

```sh
python3 app/test/verifier-review/container-acceptance.py --execute
```

The execute path builds only `app/` with a unique temporary tag, starts one isolated app container, waits for `/api/version`, verifies native `better-sqlite3` and `argon2` from inside the image, checks unauthenticated `/api/auth/me` and `Cache-Control: no-store`, sends SIGTERM, waits for exit, and verifies the temporary database was created. It never claims migration CLI availability in the image.

## Static review findings

- `app/Dockerfile` copies `server.js`, `src`, and `public`, but not `app/scripts/accounts.js` or host-side Python migration/restore helpers. Accounts HTTP runtime can be tested from the image; migration CLI availability must remain a documented host-scripts concern.
- The lifecycle integration now installs an app gate, tracks auth/security/admin/messages/files handlers, closes HTTP and Socket.IO, then drains tracked work. Final wiring uses Socket.IO as the HTTP close owner, drains handlers before persistence/security closure, and uses a 25-second shutdown deadline with 35-second Compose stop grace. The isolated target-image execution passed as recorded below.
- Existing container tests must not use the repository's `app/data`, Compose project, `.env`, certificates, or user browser profile.

## Browser and proxy limitation

The browser fixture uses Chrome DevTools Protocol with a dedicated temporary `--user-data-dir` and loopback-only endpoint; it never opens a normal browser profile or real user data. Nginx/TLS validation is a separate fixture using synthetic certificates and an isolated nginx container/config, not the existing Compose service. It passed against a host-synthetic upstream; see [proxy acceptance](proxy-acceptance.md).

### Host synthetic CDP result

The final host-only run passed with zero browser runtime exceptions: login form, offline-admin setup, TOTP login, admin user-list modal (including no-Origin read-only request), sessions, security history, and logout. Chrome's polling requests were observed without `Origin` but with `Referer` and `Sec-Fetch-Site: same-origin`; the server accepted only this constrained case after parsing the Referer origin against the exact allowlist. WebSocket/explicit-origin/unsafe cases remain strict and are covered by the Lead's socket tests. A same-profile second tab restored the cookie session, received a synthetic private message, reloaded and restored that session, and received a dispatched persisted-`pageshow` event that triggered `/api/auth/me` revalidation. After first-tab logout, the second tab observed the BroadcastChannel message, cleared account/CSRF/message/favorite/UI secrets, disconnected its Socket.IO client, and remained logged out after reload. The pageshow event was dispatched through CDP (not an actual OS/browser BFCache navigation). This is not target-container evidence.

## Acceptance status

**PASS (2026-10-17):** The isolated fixture ran against an existing Docker daemon with the exact `node:24-bookworm-slim` base and no Compose project. It confirmed `/api/version` readiness on a loopback-only random port, Node 24, native `better-sqlite3`, native `argon2`, unauthenticated `401` plus `Cache-Control: no-store`, zero-exit SIGTERM shutdown, and creation of the temporary mounted SQLite database. The fixture verified ownership labels before removing its unique image/container; a post-run label query was empty.

The first executable build found a real image issue: the slim base did not contain the build tools required when `better-sqlite3` needed compilation. [Dockerfile](../app/Dockerfile) now installs `python3`, `make`, and `g++` for `npm ci --omit=dev` only, then purges them and package/npm cache. Another fixture issue was corrected: global proxy settings caused Python to proxy `127.0.0.1` readiness traffic, returning 502 even though the container logged successful startup. The fixture now disables proxies for loopback verification. The exact base was used without substituting another Node version or tag.

A separate host-only synthetic browser fixture, `app/test/verifier-review/container-acceptance.browser.cjs`, uses a temporary data/key directory, offline synthetic admin initialization, a dedicated temporary Chrome profile, a loopback app port, and Chrome DevTools Protocol through Node's built-in WebSocket. Its results are explicitly browser evidence for the host runtime only, not image/runtime evidence. Do not use a normal Chrome profile or real user data.
