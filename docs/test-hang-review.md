# npm Test Hang Review

## Scope

Read-only diagnosis. No product code or existing test files were changed. Every diagnostic run used a hard Perl alarm and orphaned Node test runners were terminated after inspection.

## Test command

`app/package.json` defines:

```text
node --test test/*.test.js test/db/*.test.js test/security/*.test.js
```

Environment: Node `v24.21.0`, npm `11.19.0`; `better-sqlite3` and `argon2` load successfully.

## Results

- Full `npm test`, 60-second hard timeout: exit `142` (SIGALRM). All 23 database tests completed successfully; the last output was `recovery completion revokes session and consumes old code atomically`. No database failure was reported.
- Core group (`multi-user`, `routes`, `lifecycle`, `lifecycle-storage`, `server-lifecycle`), 60-second timeout: exit `142`. Output stopped after `flush writes only dirty users to isolated real data files`.
- Migration/quota/verifier group: exit `0`, 19 tests passed in about 5.9 seconds.
- Security group: exit `0`, 43 tests passed in about 4.4 seconds.
- Isolated files: `multi-user`, `routes`, `lifecycle`, and `server-lifecycle` each exited `0`. `lifecycle-storage.test.js` alone timed out at 40 seconds after its first test passed.
- Isolated `flush shares` run: exit `124` after 10 seconds with an unresolved deferred promise.
- Isolated `failure rejects` run: exit `1` in about 66ms, `Missing expected rejection`; its injected `writeFile` failure hook is not reached for the same FileHandle mismatch.
- Isolated `stop waits` run: exit `1` with `MODULE_NOT_FOUND: ./quota` from the VM fixture's dependency map. This is a separate fixture/environment defect exposed by name-pattern execution, not the full-suite hang.

## Root cause

The hang is in `test/lifecycle-storage.test.js`, specifically the mocked concurrent-flush test beginning at `flush shares an active drain and persists changes made during IO` (test lines 48-69).

That test injects an override:

```js
async writeFile(...args) {
  if (++writes === 1) { started.resolve(); await release.promise; }
  return fs.writeFile(...args);
}
```

The production implementation in `src/storage.js` does not call the injected `fs/promises.writeFile` function. It opens a file and writes through the returned FileHandle:

```js
const handle = await fs.open(tmpFile, 'wx', 0o600);
await handle.writeFile(JSON.stringify(candidate, null, 2));
```

Therefore the test's `started.resolve()` hook is never reached. The test waits forever at `await started.promise`; `release.resolve()` is never executed. The same API mismatch means the failure-injection branch is never called, so `failure rejects` reports a missing rejection rather than exercising persistence failure. This is a test double/API mismatch, not a SQLite or native dependency hang.

The first storage test succeeds because it does not rely on the overridden `writeFile` hook. The remaining lifecycle-storage tests are not reached or cannot complete after the unresolved deferred.

## Cleanup

The hard-alarm wrapper can orphan Node descendants when Perl is replaced with `exec`; those exact `node --test ... lifecycle-storage.test.js` PIDs were identified with `ps` and terminated. Final process inspection showed no remaining `node --test`, `npm test`, or `lifecycle-storage` process.

## Conclusion

The full suite's apparent hang is localized to the existing lifecycle-storage test mock, whose `writeFile` interception no longer matches the FileHandle-based persistence implementation. The database 23-test boundary is incidental: the full command reaches that point before entering the top-level test files in this run order. Fixing the test double or injecting the FileHandle write boundary is required; this diagnostic task intentionally made no such change.
