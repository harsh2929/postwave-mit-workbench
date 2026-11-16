# Moosewave TypeScript SDK workbench

This is the existing Moosewave/Postwave TypeScript SDK isolated from the larger application. It includes its client/resources, generated operation types, webhook verification, examples, tests and a small API-contract snapshot. First-party source is MIT-licensed; retain [LICENSE](LICENSE). It is a real client-library codebase, not a new application scaffold.

## Requirements

- Node.js 22.18 or later
- npm
- Python 3 for the read-only bundle check

## Install and verify

```sh
npm ci --ignore-scripts
npm run verify
```

The project npm configuration avoids automatically installing unused optional browser-tooling peers. Verification dependencies are declared and locked.

`verify` runs source linting, TypeScript checks, generated-contract drift checks, mocked unit tests, both module-format export checks, a production library build and the upload-boundary audit. No database, application server, cloud account or real API credential is needed. The suite rejects unmocked network calls.

For a focused run:

```sh
npm test -- tests/webhook.test.ts
npm run typecheck
npm run build
```

### Request-lifecycle checks: two levels

Request lifecycle covers per-attempt timeouts, the optional overall budget,
caller cancellation, clock corrections, a blocked event loop, overlapping
calls and resource release, in the client and all three polling helpers. It is
checked at two levels. They are not interchangeable, so report them
separately.

**1. Full verification (authoritative; needs installed dependencies).**
`npm run verify` above includes the complete deterministic fake-timer suites.
To run just those after `npm ci`:

```sh
npm test -- tests/request-lifecycle.test.ts tests/waiters.test.ts tests/errors.test.ts tests/retry.test.ts
```

**2. Focused offline checks (no dependencies, no network).** For a sandbox
where `npm ci` cannot run (for example `eslint: not found` from `verify`):

```sh
npm run --offline test:lifecycle:offline
```

This needs only Node.js 22.18 or later. It runs
`tests/offline/lifecycle.offline.ts` on Node's built-in test runner,
directly against the TypeScript source (`--experimental-transform-types` plus
the resolve hook in `scripts/offline/`), with the same unmocked-network
block. The 15 cases use real timers, take about 10 s, and cover: cancellation
inside `onResponseHeaders` on a 204; cancellation and per-attempt timeout on
a stalled body; forward and backward wall-clock jumps; a blocked event loop
against a request budget and against all three waiters;
`campaignTemplates.waitForDesign()`'s stalled-poll deadline, listener
release and server retry hint; and overlapping calls.

A passing offline run is **not** a passing `verify`. It does not lint,
type-check, build, check generated contracts or package exports, or run the
rest of the suite, including the fake-timer lifecycle cases that assert
exact timing, timer counts and listener counts. It is not part of `verify`,
which is unchanged.

The semantics are documented under "Timeouts, budgets and cancellation" in
[SDK-REFERENCE.md](SDK-REFERENCE.md).

### Event-stream baseline and offline diagnostics

```sh
npm run --offline test:events:offline
npm run --offline diagnose:events:offline
```

The seven compatibility tests pass on this baseline. The diagnostic reports
five open streaming defects using only mock transports: split CRLF framing,
discarding an oversized frame, pre-aborted requests, cancellation during a
stalled read and HTTP-error reader release. No server or account is needed.

`npm run --offline check:events:offline` runs the same diagnostic in strict
mode and **currently exits 1**. A failure is expected on this starting version;
it is not part of `verify`. Fixing those defects should make it exit 0. The
diagnostic is a reproduction aid, not complete coverage of stream correctness.

`npm run --offline test:offline` runs both passing offline suites, currently
22 cases in total. Their scope and limitations, and the authoritative full
suite, are described in [VERIFYING.md](VERIFYING.md).

See [SDK-REFERENCE.md](SDK-REFERENCE.md) for the original client API, and [FIXTURES.md](FIXTURES.md) for the test-data and pinned-contract boundary. Library examples that target a live service are reference code; they are not run by verification and require credentials supplied by the operator.

## Upload contents

The upload archive contains source, contract fixtures, tests, documentation, manifests, the dependency lock and `.gitignore`. It excludes Git metadata, installed dependencies, build/coverage output, caches, unsupported-language source, assistant instructions, workflows and local configuration.

This package and its fixed contracts support client-library work. They do not include or certify the full application backend, live provider integrations or production deployment. Source history and release checks are recorded outside the upload so the package contains only normal project files.
