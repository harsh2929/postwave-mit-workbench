/**
 * Shared poll-until-terminal loop for the async-job waiters
 * (`sequences.waitForJob`, `voiceProfile.waitForIngestJob`,
 * `campaignTemplates.waitForDesign`).
 *
 * The wait deadline is an AbortScope. Its signal goes to EVERY poll request
 * and to every interval sleep, so the deadline and caller cancellation
 * interrupt an in-flight poll, including its body read, rather than only
 * being checked between polls. The scope is disposed on every exit path.
 */

import { RequestAbortedError, TimeoutError } from "../errors.js";
import { AbortScope, LifecycleAbort, sleep } from "./lifecycle.js";

export interface PollUntilTerminalOptions<T> {
  /** Prefix for the timeout message, e.g. `sequences.waitForJob(job_1)`. */
  label: string;
  /**
   * Exact timeout message, overriding `${label}: timed out after ...`. Lets a
   * waiter keep a message callers may already match on.
   */
  timeoutMessage?: string;
  intervalMs: number;
  /**
   * Delay before the next poll, given the last non-terminal result (e.g. to
   * honour a server retry hint). Defaults to `intervalMs`. Whatever it
   * returns, the wait deadline still cuts the delay short.
   */
  nextDelayMs?: (value: T) => number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** One poll. Must forward `signal` to the request it makes. */
  poll: (signal: AbortSignal) => Promise<T>;
  isTerminal: (value: T) => boolean;
}

export async function pollUntilTerminal<T>(
  opts: PollUntilTerminalOptions<T>,
): Promise<T> {
  const scope = new AbortScope({
    parent: opts.signal,
    timeoutMs: opts.timeoutMs,
    timeoutScope: "wait",
  });
  try {
    for (;;) {
      // sync() checks the MONOTONIC clock against the deadline. After a blocked event
      // loop the interval timer can fire before the overdue deadline timer,
      // and without this check the next poll would start past the deadline.
      if (scope.sync()) throw abortError(scope.signal, opts);
      const value = await opts.poll(scope.signal);
      // Settle gate: a result, even a terminal job, is not returned once
      // the caller cancelled or the deadline passed.
      if (scope.sync()) throw abortError(scope.signal, opts);
      if (opts.isTerminal(value)) return value;
      await sleep(opts.nextDelayMs?.(value) ?? opts.intervalMs, scope.signal);
    }
  } catch (e) {
    // Once our scope has fired (or its deadline passed), it alone decides the
    // outcome. A poll cut off by the deadline surfaces as the waiter's
    // timeout, never as whatever the interrupted request happened to throw.
    if (scope.sync()) throw abortError(scope.signal, opts);
    throw e;
  } finally {
    scope.dispose();
  }
}

function abortError(
  signal: AbortSignal,
  opts: { label: string; timeoutMs: number; timeoutMessage?: string },
): TimeoutError | RequestAbortedError {
  const reason: unknown = signal.reason;
  if (reason instanceof LifecycleAbort && reason.kind === "timeout") {
    // Message kept byte-identical to each waiter's historical plain Error.
    return new TimeoutError({
      message:
        opts.timeoutMessage ??
        `${opts.label}: timed out after ${opts.timeoutMs}ms`,
      scope: "wait",
      timeoutMs: opts.timeoutMs,
    });
  }
  return new RequestAbortedError({
    payload: reason instanceof LifecycleAbort ? reason.callerReason : reason,
  });
}

export function normalizePollInterval(value: number | undefined): number {
  if (value === undefined) return 2000;
  if (!Number.isFinite(value) || value <= 0) return 2000;
  return Math.min(Math.floor(value), 30_000);
}

export function normalizeWaitTimeout(value: number | undefined): number {
  if (value === undefined) return 5 * 60_000;
  if (!Number.isFinite(value) || value <= 0) return 5 * 60_000;
  return Math.min(Math.floor(value), 30 * 60_000);
}
