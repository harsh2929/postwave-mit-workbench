# Moosewave TypeScript SDK workbench

This is the existing Moosewave/Postwave TypeScript SDK isolated from the larger application. It includes its client/resources, generated operation types, webhook verification, examples, tests and a small API-contract snapshot. First-party source is MIT-licensed; retain [LICENSE](LICENSE). It is a real client-library codebase, not a new application scaffold.

## Current source baseline

Version 0.4.0 incorporates the completed request/polling lifecycle,
event-stream and typed-pagination work. Pagination supports subscribers,
list members, outbound webhooks, delivery histories and audit entries, with
concurrent-traversal isolation and retry/truncation regression coverage.
All five retained stream diagnostics pass. `BASELINE.json` records lineage
and the starting counts; report actual results after later changes.


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
`test:offline` runs all three focused suites: lifecycle, events and
pagination (148 tests: 15 + 54 + 79).

### Pagination checks without dependencies

```sh
npm run --offline test:pagination:offline
```

Runs the 79 shared pagination cases in `tests/pagination-cases.ts` (49),
`tests/pagination-concurrency-cases.ts` (12) and
`tests/pagination-retry-cases.ts` (18) on Node's
built-in runner, against the TypeScript source, with the same unmocked-network
block. They cover every iterator's route, contract keys and stable filters;
offset, cursor and offset-to-cursor continuation; laziness, no prefetch and
queued concurrent `next()`; empty pages; malformed pages and repeated
continuation data (a page is rejected whole); the finite default and
configured page guard; the item limit; the page hand-off window (an abort or
budget expiry after a page is accepted but before it is yielded, on the first
or a later page and on an empty page, rejected identically by page and item
iterators, with a no-trap control); conservative completion on numbered-page
metadata conflicts (each conflict kind, genuinely empty collections, a resume
page past the end, conflicts surviving the switch to a cursor, unchecked
cursor pages); invalid options; request-error
propagation; cancellation before, during and between pages; listener release;
the time budget's start at the first `next()`, consumer pauses, stalled
requests and retry backoff; diagnostics free of cursor, filter and row values;
and unchanged single-page requests.

The 12 concurrency cases run all ten public iterator methods at once on one
client, each in its own loop, against a stateless mock. The mock delays every
response by a per-URL amount, so requests overlap and complete out of order.
It routes by the filters each request carries and rejects a cursor minted for
another collection. Each traversal's solo run is the baseline: delivered ids,
error, `progress` and its exact request URLs (filters, page numbers,
cursors). With the fleet running, one traversal is cancelled (paused, or with
a request in flight), timed out (stalled request, paused consumer), stopped,
or failed (malformed page, 5xx, repeated cursor, page guard). Every other
traversal must reproduce its baseline exactly, with none of its wire requests
aborted. Further cases cover two traversals of the same collection and
filters, and a client reused after trouble. Shared-signal cases cover one
abort reaching traversals that are finished, paused with buffered items, in
flight and not yet started, and nothing outside the signal. They also show
that the SDK never aborts the signal when one of its traversals stops, times
out or fails, and that 25 in-flight traversals on one signal cancel with all
listeners released and no `MaxListenersExceededWarning`.

The 18 retry cases enable client retries and inject transient failures into
the first attempts at an exact page URL. The kinds are 503, 429, a transport
error, a truncated body, a per-attempt timeout and a 304. What each case runs:

| Case | Iterators | Failure kinds | Where |
| --- | --- | --- | --- |
| Recovery matrix | all 10 public iterator methods | all 6 | pages 1 and 2 (offset first pages, the hybrid's switch page, cursor pages) |
| 503 recovery, 2 failures per page | all 10 | 503 | pages 1 and 2 |
| Exhaustion matrix | all 10 | all 6 | page 2 |
| Exhaustion at other positions | `audit.queryAll`, `webhooks.listPages`, `lists.membersAll`, `subscribers.listAll` | 503, 429, network, stall, truncated | first and last pages |
| Truncation proof | `lists.membersAll`/`membersPages` (offset), `subscribers.listAll`/`listPages` (hybrid), plus a 10-traversal fleet | truncated | every page |
| Limits, resume, concurrency, cancellation, budgets | see the case names in `tests/pagination-retry-cases.ts` | mostly 503/429 | as named |

- **Recovery** means ids and `progress` equal the no-failure baseline, and the
  requests equal the baseline with only the failing page repeated back to
  back.
- **Exhaustion** means the last attempt's own typed error, exactly
  `retries + 1` attempts (a 304 is not retried: one cache-bust refetch, then
  its error), nothing after, and `progress` equal to the delivered prefix.
- **Truncation is real.** The mock sends a genuine prefix of the actual page
  JSON, holding at least one complete real row and cut mid-array. It arrives
  in at least two chunks through a pull-driven stream, then the connection
  fails. An instrumented reader on the body the SDK consumed records every
  chunk received. The tests assert that every prefix byte reached the
  reader, that the read after it failed, and that the prefix is not valid
  JSON. Each complete row it carried is delivered exactly once after
  recovery, and never after exhaustion.
- **Guard.** Both matrices count the pairs they actually asserted and fail
  unless every iterator-kind pair was covered. A coverage-guard case checks
  that the test fleet matches the iterator methods the public resources
  actually expose, and that every failure kind is listed (also enforced at
  compile time).
- **Also covered:** resuming after exhaustion; page and item limits counting
  pages and items, not attempts; all ten traversals retrying at once, or one
  retrying beside nine at exact baseline, exhausting, or in a long
  `Retry-After`; an abort during a backoff or inside a failing attempt
  sending no retry; no attempt starting after the traversal budget; a real
  budget cutting a 5 s backoff short; the client's per-request
  `totalTimeoutMs` still failing fast; retries within a budget completing.

Vitest adds a fake-timer check that a `Retry-After` backoff counts exactly
toward the traversal budget.

Timing: a case that needs work to succeed within a budget uses a 60 s budget
and crosses it by advancing the SDK's monotonic clock (`performance.now`,
with an offset the test controls) instead of waiting. Only cases that assert
failure after a budget use short real budgets. So a slow or briefly frozen
machine cannot fail them. This was checked by running the suite while
repeatedly freezing the test process (`SIGSTOP`/`SIGCONT`). If a change leaks
an SDK timer, the offline runner reports the failing cases but then waits for
the leaked timer. Add `--test-force-exit` when diagnosing. The hand-off cases drive the shared engine
directly so the trigger lands in that window deterministically. `npm test`
runs the same cases under vitest in `tests/pagination.test.ts`, plus
fake-timer checks of the budget's exact boundary (including in the hand-off
window), a blocked event loop, wall-clock corrections and timer release.
`tests/pagination-types.test.ts` holds type-level checks enforced by
`npm run typecheck`, and `test:package` checks the built ESM/CJS exports. The
offline run covers none of those.

These are focused checks, not a proof of complete SSE conformance: only
`data` fields are used and there is no reconnection. The full event suite
remains `tests/events-stream.test.ts`, run by `verify`, which covers the
same cases plus the original vitest cases.
If behavior changes, add regression cases for it in the appropriate suites.
Neither offline command replaces linting, type checking, build verification
or the other checks in `npm run verify`.

Pagination API, stopping behavior and consistency limits are documented
under "Pagination" in [SDK-REFERENCE.md](SDK-REFERENCE.md).

See [SDK-REFERENCE.md](SDK-REFERENCE.md) for the original client API, and [FIXTURES.md](FIXTURES.md) for the test-data and pinned-contract boundary. Library examples that target a live service are reference code; they are not run by verification and require credentials supplied by the operator.

## Upload contents

The upload archive contains source, contract fixtures, tests, documentation, manifests, the dependency lock and `.gitignore`. It excludes Git metadata, installed dependencies, build/coverage output, caches, unsupported-language source, assistant instructions, workflows and local configuration.

This package and its fixed contracts support client-library work. They do not include or certify the full application backend, live provider integrations or production deployment. Source history and release checks are recorded outside the upload so the package contains only normal project files.
