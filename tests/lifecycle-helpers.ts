import { vi } from "vitest";

/**
 * Test helper: count the "abort" listeners still attached to a signal.
 *
 * Shadows add/removeEventListener on this one instance. A listener that the
 * SDK attached and never removed shows up as a non-zero count after the call
 * settles, which is how listener leaks are asserted deterministically.
 */
type ListenerFn = (type: string, listener: unknown, options?: unknown) => void;

export function countAbortListeners(signal: AbortSignal): () => number {
  const live = new Set<unknown>();
  const target = signal as unknown as {
    addEventListener: ListenerFn;
    removeEventListener: ListenerFn;
  };
  const add = target.addEventListener.bind(signal);
  const remove = target.removeEventListener.bind(signal);
  target.addEventListener = (type, listener, options) => {
    if (type === "abort" && listener) live.add(listener);
    add(type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    if (type === "abort") live.delete(listener);
    remove(type, listener, options);
  };
  return () => live.size;
}

/**
 * Model synchronous work blocking the event loop for `ms` (CPU-bound code, a
 * suspended JS thread), under vitest fake timers.
 *
 * Real time passes, so BOTH the monotonic clock (performance.now) and the
 * wall clock (Date.now) move forward by `ms`. Pending timer callbacks keep
 * their relative delays, so none of them has run yet. That is the real
 * situation: when the loop resumes, overdue timers fire in expiry order with
 * microtasks drained between them. A backoff or poll-interval timer due
 * before a deadline therefore runs before the deadline's own timer.
 * Requires vi.useFakeTimers().
 */
export function blockEventLoop(ms: number): void {
  advanceMonotonicClock(ms);
  vi.setSystemTime(Date.now() + ms);
}

/**
 * Model a wall-clock correction: an NTP step, a manual clock change, or a
 * VM/device resume re-sync. ONLY Date.now moves (in either direction). No
 * real time passes, so performance.now and the timers are unaffected.
 * Requires vi.useFakeTimers() (vi.setSystemTime leaves performance.now alone).
 */
export function adjustWallClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

/**
 * Fake timers fake `performance`, but only advancing timers moves it. To
 * move it WITHOUT running timers, layer an offset over the current fake
 * performance.now. The spy is re-installed whenever the fake `performance`
 * object changed or a previous spy was restored (vi.restoreAllMocks).
 */
let monotonicOffset = 0;
function advanceMonotonicClock(ms: number): void {
  const perf = globalThis.performance;
  if (!vi.isMockFunction(perf.now)) {
    monotonicOffset = 0;
    const fakeNow = perf.now.bind(perf);
    vi.spyOn(perf, "now").mockImplementation(() => fakeNow() + monotonicOffset);
  }
  monotonicOffset += ms;
}

/**
 * Run `fn` with `performance.now` unavailable: the condition the SDK's
 * monotonic-clock fallback handles.
 *
 * Only `now` is removed; `performance` itself stays. Replacing the whole
 * global (vi.stubGlobal("performance", undefined)) also breaks the runtime.
 * Node's built-in fetch/Response initialises lazily on first use and reads
 * performance.markResourceTiming while doing so. When a test that stubbed
 * the global happened to run first in a worker, constructing a Response
 * threw a TypeError and the test hung, depending on shuffle order.
 */
export async function withoutPerformanceNow<T>(fn: () => Promise<T>): Promise<T> {
  const perf = globalThis.performance;
  const own = Object.getOwnPropertyDescriptor(perf, "now");
  Object.defineProperty(perf, "now", { value: undefined, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (own) Object.defineProperty(perf, "now", own);
    else delete (perf as { now?: unknown }).now;
  }
}
