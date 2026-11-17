# Verification levels

Run commands from the SDK root. Node.js 22.18 or later and Python 3 are needed.
No live service, database, provider account or real credential is required.

## Full verification

```sh
npm ci --ignore-scripts
npm run verify
```

The lockfile is authoritative. `verify` runs lint, TypeScript checks, generated
operation drift checks, Vitest tests, the library build, ESM/CommonJS package
export checks and the source audit. It does not run the separate offline suites.
The prepared baseline has 530 unit tests in 52 files and 3 package checks.
Report actual results after any change instead of assuming these counts persist.

## Offline checks without installed dependencies

```sh
npm run --offline test:offline
python3 scripts/audit-bundle.py
npm run --offline check:events:offline
```

This baseline has 15 request/polling lifecycle checks and 54 event-stream
checks (69 combined). The five older streaming diagnostic cases now all pass.
They are regressions retained from the completed fixes, not open defects in
this version. No task-specific pagination code has been implemented here.

These commands run TypeScript source using Node's native type transformation
and the local resolver. They need no npm installation or network and block
unmocked sockets. They do not lint, type-check, build, inspect package exports
or replace the full fake-timer suite. A passing offline suite is a focused
runtime result, not a full `verify` pass.

## Compatibility and lineage

`BASELINE.json` records the previous public workbench revision and final event
export incorporated in this baseline. Request deadlines and polling fixes are
preserved. The event parser retains its complete-JSON-at-EOF compatibility and
the 262,144 UTF-16-code-unit frame limit. Midstream U+FEFF remains content.
Only a BOM at the very beginning of the stream is removed.

## Reporting checks

Keep command output, exit statuses and tool versions. Distinguish checks run
in the active sandbox from an agent's report or an external local review. If
a dependency is unavailable, report the limitation; do not substitute another
version and describe it as locked verification.

The source audit checks fixture patterns, excluded source boundaries and
license labels. It does not certify live backend behavior, exhaustive security
or every uploader's scanner. Inspect the actual ZIP for Git metadata, caches,
installed dependencies, build output, personal data and credentials. The ZIP
must retain `.gitignore`. Synthetic fixtures are disclosed in `FIXTURES.md`.
