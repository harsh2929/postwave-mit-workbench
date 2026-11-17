# Changelog

All notable changes to `@postwave/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-11-17

- Integrate the reviewed event-stream parser, cancellation, resource-release
  and demand-driven UTF-8 decoding improvements into the public workbench.
- Preserve the completed request and polling lifecycle improvements.
- Include the final oversized-frame/midstream-U+FEFF regression and public
  package export guard. Existing mock-only stream diagnostics now pass.
- Record baseline lineage and keep offline checks separate from full verification.

## [Unreleased]

### Changed

- `events.stream()` cancellation is now enforced by the SDK and reported
  consistently. An abort at any point rejects with `RequestAbortedError`
  (`code: "request_aborted"`, abort reason in `payload`) instead of the
  transport's own error (typically a `DOMException` named `AbortError`).
  Code that checks `err.name === "AbortError"` should check
  `err instanceof RequestAbortedError` or `signal.aborted` instead.
  `RequestAbortedError` is a `NetworkError`.
- `events.stream()` with an already-aborted `signal` now rejects without
  calling `fetch`. It was previously handed to the transport.
- After an abort, `events.stream()` yields no further events, including
  events still buffered from the same chunk, and the next `next()` rejects
  with `RequestAbortedError` even when the final event has already been
  delivered. Only an iteration that has already finished (`done: true`)
  ignores a later abort.
- `events.stream()` parses on demand: each `next()` parses only as far as
  the next valid event, instead of parsing a whole transport chunk first.
  Records, their order and which frames are skipped are unchanged.
- `events.stream()` also decodes on demand. A transport chunk is decoded
  from UTF-8 in windows of at most 8 KiB, only as parsing needs more text,
  instead of all at once when it arrives. A `next()` decodes at most one
  window beyond the frame it returns (plus any frames it skips), and after
  `break` or an abort the rest of the chunk is never decoded. Records are
  unchanged, including characters split across chunks or windows. The
  undecoded chunk is now held by reference until it is used up, so a custom
  transport that reuses or modifies a chunk's buffer after delivering it
  would change what is decoded. Reading every event costs somewhat
  more (about 10-25% in local measurements on 0.8-1.5 MB chunks), while the
  first event of a large chunk arrives several times sooner.
- Documentation: the `events.stream()` frame limit is 262,144 UTF-16 code
  units (JavaScript string length of the decoded frame), not 256 KiB of
  UTF-8 bytes as earlier text for this release said. A frame of multi-byte
  characters at the limit can be up to about three times as many bytes and
  is kept. A leading BOM is removed during decoding and does not count. The
  limit itself is unchanged.
- The transport now receives an SDK-owned `signal` linked to the caller's
  instead of the caller's signal itself. It aborts with the caller's reason,
  and also when the consumer stops iterating early. Transport errors other
  than a caller abort, and HTTP error mapping, are unchanged.

### Fixed

- `events.stream()` lost events when a CRLF line break was split across
  transport chunks inside a multi-line `data` frame.
- `events.stream()` results depended on chunking for large frames. A frame
  exactly at the size limit (262,144 UTF-16 code units) was dropped when a
  chunk ended inside its closing blank line. After an oversized frame was
  dropped mid-stream, its remaining lines could be parsed as a new frame,
  yielding an event the server never sent as one. The parser is now
  incremental and line-based. Oversized frames are skipped to their closing
  blank line, and parse cost is linear in the body size (it was quadratic
  for large frames delivered in small chunks).
- `events.stream()` hung on abort when a custom transport or its body
  ignored the signal: while connecting, while reading, and while reading an
  HTTP error body. A response that arrives after the abort has its body
  cancelled.
- Leaving the `for await` loop hung when the response body's `cancel()`
  never settled. The body is now cancelled without waiting on it.
- HTTP error responses from `events.stream()` left the body reader locked
  when the error body failed mid-read or exceeded 64 KiB. An error body with
  an oversized `content-length` was never cancelled.
- Aborting while the consumer was paused inside its loop body did not
  release the connection until the iterator was resumed. The body is now
  cancelled as soon as the signal aborts.
- An abort that landed after the transport resolved but before the stream
  started reading rejected with `RequestAbortedError` without cancelling the
  response body, for both successful and HTTP error responses.
- An abort after the final end-of-stream event was ignored: the next
  `next()` reported normal completion instead of `RequestAbortedError`.
- A transport chunk holding many events was parsed in full (every frame
  JSON-parsed and validated) before the first event was delivered, and that
  work was wasted when the consumer stopped early.
- A body read that settled just before the caller aborted was still
  processed: the chunk was decoded and parsed up to the next event (for
  example 1,001 frames) before `RequestAbortedError` was thrown. An
  end-of-stream read in the same window still parsed the final
  compatibility frame, and an HTTP error body could still be decoded and
  JSON-parsed. Cancellation is now checked whenever the stream resumes after
  waiting, before anything it received is used, so nothing is decoded or
  parsed after an abort. The abort reason and reader/listener cleanup are
  unchanged.

## [0.2.0-workbench] - 2026-11-16

### Added

- Added `test:events:offline`, an eight-case stream compatibility baseline,
  and `test:offline` to run both focused suites without dependency installation.
- Expanded the synthetic-fixture inventory and verification limitations.
- Added the separate `campaignTemplates` visual-design resource with catalog
  search, CRUD, clone, adapt, generate, and create-campaign-from-template APIs.
- Added explicit `campaignTemplates.favorite()` and `.unfavorite()` helpers for
  authenticated user-private catalog state.
- Added an optional overall request budget: client option `totalTimeoutMs`
  with a per-call `RequestOptions.totalTimeoutMs` override (`null` disables it
  for one call). It bounds every attempt, body read and backoff sleep, and is
  off by default.
- Added `npm run test:lifecycle:offline`: focused lifecycle regressions that
  run with no installed dependencies on Node's built-in test runner. They are
  separate from, and do not replace, `npm run verify`.
- `TimeoutError` now carries `scope` (`"attempt" | "total" | "wait"`) and
  `timeoutMs`; the `TimeoutScope` type is exported.

### Changed

- `sequences.waitForJob()` and `voiceProfile.waitForIngestJob()` now reject
  with `TimeoutError` (`scope: "wait"`) instead of a plain `Error` when their
  deadline expires. The message is unchanged and `instanceof Error` still
  holds. Code that treats every `NetworkError` as a transient transport
  failure will now also catch these.
- `campaignTemplates.waitForDesign()` now uses the shared polling lifecycle.
  Deadline expiry rejects with `TimeoutError` (`scope: "wait"`) instead of
  a plain `Error`; the message is unchanged. Cancellation during the delay
  between polls rejects with `RequestAbortedError` (reason in `payload`)
  instead of rethrowing the raw `signal.reason`. The deadline now bounds the
  whole wait, so a poll, delay or retry hint can no longer overrun
  `timeoutMs`. Non-finite `timeoutMs`/`pollIntervalMs` take the defaults.
  There is still no application-level maximum, but values above the runtime
  timer limit (2^31-1 ms, about 24.8 days) are now clamped to it. A
  `timeoutMs` above it was previously honoured in full. The delay between
  polls is `max(pollIntervalMs, retry_after_seconds * 1000)` ms, as before.
  Options within the timer limit, defaults, floors, terminal statuses and
  server retry hints are unchanged. See "Intentional changes to
  `campaignTemplates.waitForDesign()`" in SDK-REFERENCE.md.
- A request whose `signal` is already aborted now rejects with
  `RequestAbortedError` without calling `fetch`. Previously it was handed to
  the transport, and a custom transport that ignores its signal could send it.

### Fixed

- The per-attempt `timeoutMs` was cleared once response headers arrived, so a
  stalled response body could hang a call indefinitely. It now covers the body
  read for success and error responses.
- Caller cancellation was ignored once headers arrived. Aborting now
  interrupts the body read, and an interrupted error-body read is no longer
  swallowed and retried as if it were the 5xx.
- A transport that ignores its `AbortSignal` can no longer outlive a timeout or
  cancellation. A response that arrives after the call gave up has its body
  cancelled.
- The wait deadline and `signal` of both polling helpers now interrupt an
  in-flight poll instead of being checked only between polls.
- Cancelling from inside `onResponseHeaders` on a body-less 204 still
  resolved the call successfully. A settle gate now rejects any result once
  the caller has cancelled or the budget has passed.
- Deadlines were enforced only when their timer callback ran. After a blocked
  event loop, an earlier backoff or poll-interval timer could run first, so a
  request started another fetch, and a waiter another poll, past the deadline
  and returned success. Deadlines are now also checked against the clock
  before every wire request and poll, and before a result is returned. The
  client's retries inside a poll see the waiter's deadline too.
- Budget and deadline checks measured relative durations with the wall clock
  (`Date.now()`). A forward wall-clock correction of an hour made a 1000ms
  budget throw `TimeoutError` almost at once, and a backward correction made
  the remaining budget look an hour longer. They now use a monotonic clock
  (`performance.now()`), which still advances while the event loop is
  blocked, so the blocked-loop protection is kept.
- `campaignTemplates.waitForDesign()`: its timeout did not end a stalled
  poll, and each delay between polls left an abort listener attached to the
  caller's signal.
- Completed, failed, timed-out and cancelled calls release their timers and
  `AbortSignal` listeners, and cancel any response body they did not finish
  reading.

## [0.1.2-workbench] - 2026-11-15

### Changed

- Removed the optional signed-conversion setup snippet from the SDK reference.
- Removed the contact-shaped template from the synthetic fixture helper.
- Added a source check for contact-domain fragments in interpolated examples.

## [0.1.1-workbench] - 2026-11-15

### Changed

- Centralized synthetic contact and credential fixtures without changing SDK
  transport behavior or the timeout/cancellation work remaining to be done.
- Removed optional contact examples from the OpenAPI annotations and regenerated
  type comments; operation schemas and validation constraints are unchanged.
- Strengthened the source upload check against literal contacts and misleading
  credential-shaped examples.

## [0.1.0] - 2026-05-08

Initial public release.
