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
The prepared baseline has 620 unit tests in 54 files and 4 package checks.
Report actual results after any change instead of assuming these counts persist.

## Offline checks without installed dependencies

```sh
npm run --offline test:pagination:offline
npm run --offline test:offline
npm run --offline check:events:offline
python3 scripts/audit-bundle.py
```

This baseline has 15 request/polling lifecycle checks, 54 event-stream checks
and 79 pagination checks (148 combined). All five retained streaming diagnostics
pass. Pagination includes public page/item APIs, isolation, real partial-body
recovery, retry matrices and coverage guards. These are completed regressions,
not intentionally seeded defects.

These commands run TypeScript source using Node's native type transformation
and the local resolver. They need no npm installation or network and block
unmocked sockets. They do not lint, type-check, build, inspect package exports
or replace the full fake-timer suite. Offline success is not a full verify pass.

For a failing suite that reports failures but stays alive because a timer leaked,
Node's `--test-force-exit` flag is available for diagnosis. Keep the failure
visible; forcing process exit does not repair a leak.

## Compatibility and lineage

`BASELINE.json` records the previous public workbench revision and the completed
event/pagination exports incorporated here. Request deadlines and polling fixes
are preserved. The event parser retains complete-JSON-at-EOF compatibility and
its 262,144 UTF-16-code-unit frame limit. Only a BOM at the very beginning is
removed; a midstream U+FEFF remains content. Subscriber cursor support follows
the existing optional `next_cursor` in the OpenAPI contract.

## Reporting checks

Keep command output, exit statuses and tool versions. Distinguish checks run
in the active sandbox from an agent's report or an external local review.
If a dependency is unavailable, report it. A substitute dependency version
does not establish verification against the lockfile.

The source audit checks fixture patterns, upload boundaries and license labels.
It does not certify a live backend, exhaustive security or every uploader's
scanner. Inspect the actual ZIP for Git metadata, caches, dependencies, builds,
personal data and credentials. Retain `.gitignore`, `LICENSE` and `FIXTURES.md`.
