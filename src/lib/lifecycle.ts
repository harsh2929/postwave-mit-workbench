/**
 * Request-lifecycle primitives shared by PostwaveClient.request() and the
 * polling helpers.
 *
 * Every SDK-owned deadline or cancellation is an AbortScope: a private
 * AbortController linked to an optional parent signal and an optional timer.
 * Scopes nest (caller signal -> request budget -> one attempt), and the first
 * thing to fire decides the abort reason for the whole subtree. That reason is
 * what classifies the failure afterwards. Looking at the error a transport
 * threw is not reliable: transports disagree on what they throw, and some
 * ignore their signal entirely.
 *
 * A scope releases its timer and its parent listener as soon as it fires or
 * is disposed, whichever comes first, so neither completed nor cancelled
 * operations leave anything armed.
 *
 * DEADLINES ARE CLOCK FACTS, NOT JUST TIMER CALLBACKS. The timer is only the
 * prompt way to notice a deadline. It is not the deadline. When the event
 * loop is blocked past a deadline (CPU-bound work, a suspended JS thread),
 * Node runs the overdue timers in expiry order and drains microtasks between
 * them. A backoff or poll-interval timer that was due earlier therefore runs
 * first, and its continuation (next fetch, mocked or fast response, body
 * read, return) can finish entirely in microtasks before the deadline timer
 * ever fires. `signal.aborted` is false throughout. Decision points therefore
 * call `sync()`, which compares the clock with this scope's deadline and every
 * SDK-owned ancestor's, and aborts on the spot if one has passed.
 *
 * THAT CLOCK IS MONOTONIC, NEVER THE WALL CLOCK. Budgets are relative
 * durations, so they are measured with `monotonicNow()`. Date.now() is
 * wall-clock time, and NTP step corrections, manual changes and VM/device
 * resume re-syncs move it in either direction. Measured with it, a forward
 * correction of an hour expired a 1000ms budget immediately, and a backward
 * one made the remaining budget look an hour longer. A monotonic clock is
 * unaffected by corrections, yet still advances while the event loop is
 * blocked, which is what the protection above relies on.
 */

import {
  PostwaveError,
  RequestAbortedError,
  TimeoutError,
  type TimeoutScope,
} from "../errors.js";

/**
 * Largest delay setTimeout honours. Above this, runtimes fire the timer
 * immediately, which would turn a huge budget into an instant timeout.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Abort reason installed on SDK-owned signals.
 *
 * Named "AbortError" so transports and user code that check `err.name` keep
 * recognising it. Internal: it is never surfaced to callers, who get a
 * TimeoutError or RequestAbortedError instead.
 */
export class LifecycleAbort extends Error {
  readonly kind: "timeout" | "caller";
  readonly scope: TimeoutScope | undefined;
  readonly timeoutMs: number | undefined;
  /** The caller's original `signal.reason`, for `kind: "caller"`. */
  readonly callerReason: unknown;

  constructor(
    opts:
      | { kind: "timeout"; scope: TimeoutScope; timeoutMs: number }
      | { kind: "caller"; callerReason: unknown },
  ) {
    super(
      opts.kind === "timeout"
        ? `Postwave ${opts.scope} deadline of ${opts.timeoutMs}ms expired`
        : "Cancelled by caller",
    );
    this.name = "AbortError";
    this.kind = opts.kind;
    if (opts.kind === "timeout") {
      this.scope = opts.scope;
      this.timeoutMs = opts.timeoutMs;
      this.callerReason = undefined;
    } else {
      this.scope = undefined;
      this.timeoutMs = undefined;
      this.callerReason = opts.callerReason;
    }
  }
}

let lastFallbackNow = Number.NEGATIVE_INFINITY;

/**
 * Monotonic milliseconds for measuring relative deadlines. Only differences
 * are meaningful.
 *
 * Uses `performance.now()`, read from globalThis on every call, and available
 * in Node, browsers, React Native/Hermes, Deno, Bun and workers. Where it is
 * missing, it falls back to the wall clock clamped so it never runs
 * backwards: a backward correction then pauses the clock instead of
 * extending budgets, but a forward correction can still expire them early.
 * The deadline timers themselves run on the runtime's monotonic timer clock
 * either way.
 */
export function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } })
    .performance;
  if (perf && typeof perf.now === "function") return perf.now();
  const wall = Date.now();
  if (wall > lastFallbackNow) lastFallbackNow = wall;
  return lastFallbackNow;
}

/**
 * SDK-owned signals -> their scope, so a scope whose parent signal belongs to
 * another SDK scope (waiter -> request -> attempt) can check that ancestor's
 * deadline by the clock. Weak: nothing here outlives its scope.
 */
const scopeBySignal = new WeakMap<AbortSignal, AbortScope>();

export interface AbortScopeOptions {
  /** Aborting this aborts the scope. Its reason is inherited. */
  parent?: AbortSignal;
  /** Arm a deadline. Omit for a scope that only follows its parent. */
  timeoutMs?: number;
  /** How an expired deadline is reported. Required with `timeoutMs`. */
  timeoutScope?: TimeoutScope;
}

export class AbortScope {
  private readonly controller = new AbortController();
  private readonly parent: AbortSignal | undefined;
  private readonly parentScope: AbortScope | undefined;
  private readonly deadline: number | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly timeoutScope: TimeoutScope;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onParentAbort = (): void => {
    this.abort(inheritReason(this.parent?.reason));
  };

  constructor(opts: AbortScopeOptions = {}) {
    scopeBySignal.set(this.controller.signal, this);
    this.parent = opts.parent;
    this.parentScope = opts.parent ? scopeBySignal.get(opts.parent) : undefined;
    this.timeoutMs = opts.timeoutMs;
    this.timeoutScope = opts.timeoutScope ?? "attempt";
    this.deadline =
      opts.timeoutMs === undefined
        ? undefined
        : monotonicNow() + opts.timeoutMs;
    if (opts.parent?.aborted) {
      this.controller.abort(inheritReason(opts.parent.reason));
      return;
    }
    opts.parent?.addEventListener("abort", this.onParentAbort, { once: true });
    if (opts.timeoutMs !== undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.expire();
      }, opts.timeoutMs);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds until this scope's own deadline; undefined when it has none. */
  remainingMs(): number | undefined {
    if (this.deadline === undefined) return undefined;
    return Math.max(0, this.deadline - monotonicNow());
  }

  /**
   * Bring the signal up to date with the clock: abort now if this scope or
   * any SDK-owned ancestor is past its deadline, even if the timer callback
   * has not run yet. Ancestors are checked first, so when several deadlines
   * have passed the outermost wins. For example, a spent request budget
   * reports as `total` and is not retried as an attempt timeout.
   * Returns whether the scope is now aborted.
   */
  sync(): boolean {
    if (this.controller.signal.aborted) return true;
    // An ancestor aborting propagates here synchronously via onParentAbort.
    this.parentScope?.sync();
    if (this.controller.signal.aborted) return true;
    if (this.deadline !== undefined && monotonicNow() >= this.deadline) {
      this.expire();
    }
    return this.controller.signal.aborted;
  }

  /** The public error this scope's abort represents. Only valid once aborted. */
  error(): PostwaveError {
    return lifecycleError(this.controller.signal.reason);
  }

  /** Release the timer and the parent listener. Idempotent. */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.parent?.removeEventListener("abort", this.onParentAbort);
  }

  private expire(): void {
    this.abort(
      new LifecycleAbort({
        kind: "timeout",
        scope: this.timeoutScope,
        timeoutMs: this.timeoutMs ?? 0,
      }),
    );
  }

  private abort(reason: LifecycleAbort): void {
    // Release first: an aborted scope has nothing left to wait for, and a
    // caller that forgets dispose() must not leak the parent listener.
    this.dispose();
    this.controller.abort(reason);
  }
}

/**
 * A parent's reason passes through unchanged when an SDK scope set it, so a
 * budget expiry stays a budget expiry at every level. Anything else came from
 * the caller.
 */
function inheritReason(reason: unknown): LifecycleAbort {
  return reason instanceof LifecycleAbort
    ? reason
    : new LifecycleAbort({ kind: "caller", callerReason: reason });
}

/** Map an SDK scope's abort reason to the error callers see. */
export function lifecycleError(reason: unknown): PostwaveError {
  if (reason instanceof LifecycleAbort) {
    if (reason.kind === "timeout") {
      return new TimeoutError({
        message: timeoutMessage(reason.scope, reason.timeoutMs),
        scope: reason.scope,
        timeoutMs: reason.timeoutMs,
      });
    }
    return new RequestAbortedError({ payload: reason.callerReason });
  }
  return new RequestAbortedError({ payload: reason });
}

function timeoutMessage(
  scope: TimeoutScope | undefined,
  timeoutMs: number | undefined,
): string {
  switch (scope) {
    case "total":
      return `Request exceeded its total time budget of ${timeoutMs}ms`;
    case "wait":
      return `Wait exceeded its deadline of ${timeoutMs}ms`;
    default:
      return `Request attempt timed out after ${timeoutMs}ms`;
  }
}

/**
 * Settle with `promise`, or reject with `signal.reason` as soon as the signal
 * aborts, whichever comes first. Reaching the deadline must not depend on the
 * underlying operation honouring its signal: a custom transport or a body
 * stream may ignore it.
 *
 * `onLateValue` receives a value that arrives after the abort won, so the
 * caller can release it. A late rejection is swallowed; it has no observer.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    promise.then(onLateValue, noop);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** setTimeout as a promise that rejects with `signal.reason` on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Cancel a response body nobody will read, so its stream/socket is freed. */
export function discardBody(resp: Response): void {
  const body = resp.body;
  if (!body || resp.bodyUsed || body.locked) return;
  body.cancel().catch(noop);
}

function noop(): void {
  /* intentionally empty */
}
