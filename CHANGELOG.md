# Changelog

All notable changes to `@postwave/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
