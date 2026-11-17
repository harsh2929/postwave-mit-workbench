# Moosewave TypeScript SDK workbench

This is the existing Moosewave/Postwave TypeScript SDK isolated from the larger application. It includes its client/resources, generated operation types, webhook verification, examples, tests and a small API-contract snapshot. First-party source is MIT-licensed; retain [LICENSE](LICENSE). It is a real client-library codebase, not a new application scaffold.

## Current source baseline

Version 0.3.0 incorporates the completed request/polling lifecycle fixes and
all reviewed event-stream fixes, including the final midstream-BOM regression.
The separate streaming diagnostic now passes all five checks. `BASELINE.json`
records the source lineage and starting test counts; those counts describe
this baseline, not the outcome of any later change.

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

### Event-stream checks without dependencies

```sh
npm run --offline test:events:offline
npm run --offline test:offline
```

`test:events:offline` runs 54 cases against `events.stream()`. Eight are the
compatibility baseline: transport/auth headers and filters, LF data lines,
complete CRLF frames, the existing complete-JSON-at-EOF behavior, malformed
and complete oversized frames, fragmented UTF-8, HTTP error mapping and
consumer early exit. The other 46 are stream-hardening regressions:
identical results at every chunk split point (including CRLF split between
chunks), the frame limit (262,144 UTF-16 code units) at its exact boundary, oversized-frame and
malformed-input recovery, cancellation before and during connect, during
reads and between events with a transport and body that ignore their signal,
an abort after the transport resolves but before the body is read, an abort
after the final end-of-stream event, `break` after an abort, `break` with a
body whose `cancel()` never settles, reader/listener release on end of
stream, dropped connections and HTTP error bodies, demand-driven parsing of
a 10,000-event chunk, reads (event chunk, end of stream, HTTP error body)
that settle just before an abort, an abort at the hand-off after the HTTP
error text is read but before it is parsed, overlapping streams on one
client with independent and shared signals, and demand-driven UTF-8
decoding: bounded decoding per event, frames larger than a decode window,
sliced buffers, characters and CRLF split by window or chunk boundaries,
cancellation (with a negative control) and interleaved streams, and the
frame limit with a leading BOM (whole or fragmented), a U+FEFF after an
oversized frame (content, not a BOM), multi-byte characters and a
surrogate pair at the boundary. Decode and
parse work is checked by counting bytes and parses, not by timing.
`test:offline` runs both focused suites (69 tests).

These are focused checks, not a proof of complete SSE conformance: only
`data` fields are used and there is no reconnection. The full event suite
remains `tests/events-stream.test.ts`, run by `verify`, which covers the
same cases plus the original vitest cases.
If behavior changes, add regression cases for it in the appropriate suites.
Neither offline command replaces linting, type checking, build verification
or the other checks in `npm run verify`.

See [SDK-REFERENCE.md](SDK-REFERENCE.md) for the original client API, and [FIXTURES.md](FIXTURES.md) for the test-data and pinned-contract boundary. Library examples that target a live service are reference code; they are not run by verification and require credentials supplied by the operator.

## Upload contents

The upload archive contains source, contract fixtures, tests, documentation, manifests, the dependency lock and `.gitignore`. It excludes Git metadata, installed dependencies, build/coverage output, caches, unsupported-language source, assistant instructions, workflows and local configuration.

This package and its fixed contracts support client-library work. They do not include or certify the full application backend, live provider integrations or production deployment. Source history and release checks are recorded outside the upload so the package contains only normal project files.
