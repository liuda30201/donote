# Final release validation — 2026-10-17

## Integrated candidate evidence

The accounts, sensitive-text, quota, migration and recovery implementations are integrated. The final host application run `npm --prefix app test` passed **116/116**, zero skipped or cancelled (6.5 seconds). `./scripts/check.sh` passed shell syntax, JSON/lock consistency, Compose configuration and JavaScript syntax (73 files). `git diff --check` passed. The exact Node 24 target image acceptance also passed on 2026-10-17.

- Quota HTTP tests use isolated processes/data roots, real Express HTTP and injected account authentication. Multipart/Data URL rejection returns 413 without residual regular files; delete lowers repository usage; concurrent uploads now require exactly one 200 and one 413. Request ownership is restored explicitly when queued callbacks start. Interrupted multipart requests clean temporary files. See [HTTP quota tests](../app/test/quota-http.test.js).
- Sensitive HTTP tests use real SQLite sessions, Cookie/CSRF and one-use action grants; strong-factor verification is injected for that test. Real password/TOTP behavior is covered separately by the HTTP auth tests. Locked lists/search/favorites/export contain no sensitive plaintext; reveal/copy/remark enforce action, tenant and replay rules. See [sensitive HTTP tests](../app/test/security/sensitive-http.test.js).
- Real host Chrome/CDP acceptance passed login, sensitive checkbox create, locked output, reauth/reveal 200, viewer teardown, logout and two real tabs receiving Socket sensitivity revocation; zero browser exceptions and empty service stderr. Controlled late reveal after synthetic visibility hiding cannot restore Map/DOM plaintext. Synthetic persisted `pageshow` dispatch triggers `/api/auth/me` revalidation. These event simulations are **not a real BFCache navigation**. See [browser acceptance](../app/test/verifier-review/sensitive-browser.cjs).
- Real backup/restore scripts were exercised against temporary product WAL SQLite and authenticated sensitive ciphertext. Restore preserves ciphertext, authenticates historical keys, revokes sessions and consumes challenges/grants/recovery codes; old cookies fail. The six independent backup fixtures now pass **28/28**. Docker lifecycle in these tests uses an allowlisted stub, so this is script/data evidence. A closed WAL database read check no longer creates empty sidecars and invalidates its own inventory. Existing nonempty WAL is read through SQLite backup and source changes still fail closed. See [sensitive restore E2E](../app/test/verifier-review/sensitive-restore-e2e.py).

No production data or keys were used. No production deployment was performed. The target-image gate is now passed for the isolated candidate build. Host/browser event simulations and the listed release limitations remain distinct from the target-image evidence.


## Scope and current status

**PASS: isolated exact target-image acceptance completed on 2026-10-17.** The fixture used an existing Docker daemon, the exact `node:24-bookworm-slim` base, a temporary synthetic data directory and a fresh 0600 32-byte authentication key. It passed all required assertions:

- `/api/version` became healthy through a Docker-assigned loopback-only port.
- Node major 24, native `better-sqlite3` and native `argon2` worked inside the final image.
- Unauthenticated `/api/auth/me` returned `401` with `Cache-Control: no-store`.
- `SIGTERM` exited with status 0 and the mounted temporary data root contained `donote.db`.
- The unique label-scoped image/container were removed; post-run label queries returned no remaining acceptance resources.

The first real build exposed a release defect: `better-sqlite3` had no usable prebuilt binary for this target and `node:24-bookworm-slim` lacked the build toolchain. [Dockerfile](../app/Dockerfile) now installs `python3`, `make`, and `g++` only for `npm ci --omit=dev`, then purges them and apt/npm cache before runtime. A later readiness failure was a fixture defect: Python honored the global HTTP proxy for `127.0.0.1`, producing proxy 502 responses while the container was healthy. The fixture now disables proxies for its local health/auth assertions.

The exact base image was made available to the Docker daemon for the isolated run. No alternate Node image, Compose project, repository `.env`, real data, certificates, or existing container was used.

## Exact target and fixture

The target fixture is `app/test/verifier-review/container-acceptance.py`. It refuses to run if `app/Dockerfile` does not contain exactly one `FROM node:24-bookworm-slim` stage. It never selects an alternate base image or uses Compose, repository `.env`, existing data, or certificates. The exact `node:24-bookworm-slim` base was used for the isolated run.

Dry-run and isolated execution:

```sh
python3 app/test/verifier-review/container-acceptance.py
python3 app/test/verifier-review/container-acceptance.py --execute
```

Run the isolated ownership/failure unit tests without Docker:

```sh
python3 app/test/verifier-review/container-acceptance.test.py
```

The fixture uses a unique random image tag/container name and label, temporary synthetic database directory, a fresh 32-byte `0600` authentication key, explicit synthetic key ID, and Docker-assigned random published port bound to `127.0.0.1`. It first checks Docker availability and the exact build context. After successful startup it checks the published port binding is loopback-only, `/api/version`, native SQLite and Argon2 under Node 24, unauthenticated `/api/auth/me` with `401`/`no-store`, SIGTERM exit zero, and database creation.

Build/create are treated as potentially partially successful even if the Docker client reports failure. Cleanup inspects each exact image/container name and verifies the unique owner label (and container name) before removal. A missing resource is accepted only for an explicit Docker not-found response; daemon/inspection failures are not interpreted as absence. If ownership or cleanup cannot be established, it refuses unsafe deletion and retains the synthetic temporary root for manual investigation. The image is removed only if the exact owner label matches. No other image/container is enumerated for deletion.

The fixture tests use mocked subprocess responses only; they do not invoke Docker. Their current five cases cover exact owned container, mismatched label refusal, explicit not-found, daemon failure, and cleanup after a synthetic partial create failure.

## Release-gate record

All gates that can be exercised in this isolated development environment are complete:

1. Final Dockerfile, startup/shutdown wiring, security startup, and native runtime dependencies were reviewed; image acceptance verified the runtime itself.
2. Fixture dry-run and five mock ownership/failure tests passed.
3. The configured Docker endpoint was reachable.
4. The exact `node:24-bookworm-slim` image was pulled and used; no alternate Node version or tag was selected.
5. Exact-image test passed health, Node 24, native SQLite/Argon2, unauthenticated no-store policy, SIGTERM exit, and persistence checks.
6. Separate cached-Nginx TLS proxy fixture passed, with the documented host-upstream limitation.
7. Host real-Chrome sensitive lifecycle and two-tab tests passed; synthetic event limitations are listed above.
8. Label-scoped cleanup completed; post-run Docker queries found no acceptance image/container resources.
9. Results and boundaries are reported separately here and in [container acceptance](container-acceptance.md).

These are development and synthetic-data release gates only; they do not constitute production deployment or validation against real user data.

## Evidence boundaries

- The real Nginx TLS fixture passed against a host synthetic Node app through cached `nginx:1.27-alpine`; it is proxy/config evidence only. See [proxy-acceptance.md](proxy-acceptance.md).
- Host Chrome evidence covers setup/TOTP/admin/sessions/history/logout and same-profile dual-tab state clearing with zero browser exceptions. The dispatched `pageshow` is not an OS/browser BFCache round-trip. See [container-acceptance.md](container-acceptance.md).
- The target-image fixture passed independently and removed its uniquely owned image/container after SIGTERM and persistence checks.

No production data or deployment was used. These results certify isolated development acceptance, not production operation.
