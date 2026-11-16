# Verification levels

Run commands from the SDK root. Node.js 22.18 or later and Python 3 are needed.
No live server, provider account or production credential is required.

## Full verification

```sh
npm ci --ignore-scripts
npm run verify
```

The dependency lock is authoritative. `verify` runs source linting, TypeScript
checks, generated-operation checks, the Vitest suite, builds, ESM/CJS export
checks and the source boundary audit. It does not run the separate Node-based
offline tests or the open-defect diagnostic. Report the installed dependency
versions if a scratch install had to be used instead of the lock.

## Passing offline checks

```sh
npm run --offline test:offline
python3 scripts/audit-bundle.py
```

These need no installed npm dependencies and make no network requests. The
starting version has 15 lifecycle checks and ten streaming compatibility
checks. They exercise TypeScript source with Node's native type transformation
and a local resolver. They do not lint, type-check, build, check package exports
or run the full fake-timer suite. A pass is not a full `verify` pass.

## Open streaming defects

```sh
npm run --offline diagnose:events:offline
npm run --offline check:events:offline
```

Both commands use five bounded, mock-only reproductions against the real SDK
source. The diagnostic prints JSON describing each result. The strict check
exits 1 while any of these known defects remain, and exits 0 once all five pass.
All five are unresolved in this starting release. They are genuine existing
defects, not bugs added for the diagnostic. The diagnostic does not replace
regression tests or exhaustively cover parser and stream lifecycle behavior.

The existing SDK deliberately delivers a valid final frame at EOF even if it
has no terminating empty line. Keep that compatibility behavior explicit when
evaluating parser changes; it differs from browser EventSource dispatch rules.

## Reporting results

Record the exact command, exit status, environment and output for each level.
Keep an agent's reported results, a separate local review and checks personally
run in a sandbox distinct. A blocked install or missing development tool is an
environment limitation, not evidence that the full suite passed or failed.
Count cases from the actual output after changes; the starting counts are not
a promise about a later revision.

The source audit checks file boundaries, fixture patterns and license labels.
It does not certify production security, complete license provenance, browser
compatibility or live backend correctness. Inspect the final archive separately
for excluded files. Retained synthetic data is documented in FIXTURES.md.
