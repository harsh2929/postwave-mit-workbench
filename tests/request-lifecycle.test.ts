/**
 * Request lifecycle: per-attempt timeout, overall budget, caller cancellation
 * and resource release in PostwaveClient.request().
 *
 * Every test drives a mocked transport under fake timers, so nothing here
 * depends on wall-clock speed or a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConflictError,
  NetworkError,
  PostwaveClient,
  RateLimitError,
  RequestAbortedError,
  ServerError,
  TimeoutError,
} from "../src/index.js";
import type { FetchFn } from "../src/index.js";
import {
  adjustWallClock,
  blockEventLoop,
  countAbortListeners,
  withoutPerformanceNow,
} from "./lifecycle-helpers.js";

const BASE = { apiKey: "k", tenantId: "t" } as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A body whose chunks are released only when the test says so. */
function controlledBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  const enc = new TextEncoder();
  return {
    stream,
    cancel,
    push: (text: string) => controller.enqueue(enc.encode(text)),
    close: () => controller.close(),
  };
}

function jsonHeaders(extra: Record<string, string> = {}): HeadersInit {
  return { "content-type": "application/json", ...extra };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders(extra) });
}

/** Transport that never settles and deliberately IGNORES the abort signal. */
function hangingFetch() {
  return vi.fn<FetchFn>(() => new Promise<Response>(() => undefined));
}

describe("per-attempt timeout covers the response body", () => {
  it("times out a stalled success body instead of hanging after headers", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    body.push('{"items":');
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ code: "request_timeout", scope: "attempt", timeoutMs: 1_000 });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled error body instead of mapping a partial read", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 500, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).not.toBeInstanceOf(ServerError);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("retries a body-read timeout on a safe request with a fresh attempt timer", async () => {
    const first = controlledBody();
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(new Response(first.stream, { status: 200, headers: jsonHeaders() }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 1, timeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers");
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 body stalls -> timeout
    await vi.advanceTimersByTimeAsync(250); // backoff (attempt 0, no jitter)

    await expect(outcome).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a transport that ignores the abort signal", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 500 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome).toBeInstanceOf(TimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the body of a response that arrives after the attempt was abandoned", async () => {
    const body = controlledBody();
    let deliver!: (r: Response) => void;
    const fetch = vi.fn<FetchFn>(
      () => new Promise<Response>((resolve) => (deliver = resolve)),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 500 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    expect(await outcome).toBeInstanceOf(TimeoutError);

    deliver(new Response(body.stream, { status: 200, headers: jsonHeaders() }));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("caller cancellation throughout the request lifetime", () => {
  it("cancels during the success body read and releases the reader", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3 });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { signal: ac.signal })
      .catch((e: unknown) => e);
    body.push('{"partial":');
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    const err = await outcome;

    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1); // caller cancellation is never retried
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.stream.locked).toBe(false);
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels during an error body read instead of swallowing it", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 503, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3 });
    const ac = new AbortController();

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { signal: ac.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();

    expect(await outcome).toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a transport that ignores the signal", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch });
    const ac = new AbortController();

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { signal: ac.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort("user navigated away");

    const err = await outcome;
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(err).toMatchObject({ code: "request_aborted", payload: "user navigated away" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hand an already-cancelled request to the transport", async () => {
    const fetch = vi.fn<FetchFn>(async () => json(200, { ok: true }));
    const pw = new PostwaveClient({ ...BASE, fetch });
    const ac = new AbortController();
    ac.abort();

    await expect(
      pw.request("POST", "/api/v1/campaigns", { body: {}, signal: ac.signal }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports caller cancellation as cancellation even when a budget is also set", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 5_000 });
    const ac = new AbortController();

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { signal: ac.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();

    expect(await outcome).toBeInstanceOf(RequestAbortedError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats the caller's own AbortSignal.timeout as cancellation, not an SDK timeout", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, timeoutMs: 60_000 });
    const ac = new AbortController();

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { signal: ac.signal })
      .catch((e: unknown) => e);
    ac.abort(new DOMException("caller deadline", "TimeoutError"));

    const err = await outcome;
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).payload).toBeInstanceOf(DOMException);
  });
});

describe("overall request budget (totalTimeoutMs)", () => {
  it("is off by default, preserving the per-attempt-only behaviour", () => {
    const fetch = vi.fn<FetchFn>();
    const pw = new PostwaveClient({ ...BASE, fetch });
    expect(pw.totalTimeoutMs).toBeUndefined();
    expect(pw.timeoutMs).toBe(30_000);
    expect(pw.retries).toBe(3);
  });

  it("bounds retries plus backoff with the client default budget", async () => {
    const fetch = vi.fn<FetchFn>(async () =>
      json(503, { error: { code: "unavailable", message: "later" } }, { "retry-after": "2" }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 10, totalTimeoutMs: 5_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    const err = await outcome;
    // Attempts at t=0, 2s, 4s. The next 2s backoff cannot fit in the 1s left,
    // so the real server error surfaces instead of a pointless wait.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(ServerError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fires during a hanging attempt and is reported as a total-budget timeout", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({
      ...BASE,
      fetch,
      retries: 3,
      timeoutMs: 10_000,
      totalTimeoutMs: 2_500,
    });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_500);

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ scope: "total", timeoutMs: 2_500, code: "request_timeout" });
    expect(fetch).toHaveBeenCalledTimes(1); // a spent budget is never retried
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes the body read", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, timeoutMs: 10_000 });

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { totalTimeoutMs: 750 })
      .catch((e: unknown) => e);
    body.push("{");
    await vi.advanceTimersByTimeAsync(750);

    expect(await outcome).toMatchObject({ scope: "total", timeoutMs: 750 });
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it("fires during a backoff sleep", async () => {
    const fetch = vi.fn<FetchFn>(async () =>
      json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "1" }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 5, totalTimeoutMs: 1_500 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    // 1s backoff fits (1.5s budget), second 1s backoff does not (0.5s left).
    await vi.advanceTimersByTimeAsync(1_500);

    const err = await outcome;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps each attempt at the remaining budget rather than the attempt timeout", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = hangingFetch();
    const pw = new PostwaveClient({
      ...BASE,
      fetch,
      retries: 3,
      timeoutMs: 1_000,
      totalTimeoutMs: 1_600,
    });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 times out (retryable)
    await vi.advanceTimersByTimeAsync(250); // backoff, attempt 2 starts with 350ms left
    await vi.advanceTimersByTimeAsync(350);

    const err = await outcome;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ scope: "total", timeoutMs: 1_600 });
  });

  it("per-request value overrides the client default in both directions", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 60_000, totalTimeoutMs: 5_000 });

    const shorter = pw
      .request("GET", "/api/v1/subscribers", { totalTimeoutMs: 100 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(await shorter).toMatchObject({ scope: "total", timeoutMs: 100 });

    const longer = pw
      .request("GET", "/api/v1/subscribers", { totalTimeoutMs: 20_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    let settled = false;
    void longer.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await longer).toMatchObject({ scope: "total", timeoutMs: 20_000 });
  });

  it("per-request null disables the client default budget", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 3_000, totalTimeoutMs: 1_000 });

    const outcome = pw
      .request("GET", "/api/v1/subscribers", { totalTimeoutMs: null })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await outcome).toMatchObject({ scope: "attempt", timeoutMs: 3_000 });
  });

  it("rejects invalid budgets instead of silently running unbounded", async () => {
    const fetch = vi.fn<FetchFn>();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: bad })).toThrow(
        /totalTimeoutMs/,
      );
      await expect(
        new PostwaveClient({ ...BASE, fetch }).request("GET", "/api/v1/subscribers", {
          totalTimeoutMs: bad,
        }),
      ).rejects.toThrow(/totalTimeoutMs/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clamps budgets to the largest delay a timer can represent", () => {
    const fetch = vi.fn<FetchFn>();
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 10 ** 12 });
    expect(pw.totalTimeoutMs).toBe(2_147_483_647);
  });
});

describe("write safety is unchanged by the lifecycle work", () => {
  it("reuses one idempotency key across a timed-out attempt and its retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = controlledBody();
    const keys: Array<string | undefined> = [];
    const fetch = vi.fn<FetchFn>(async (_url, init) => {
      keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      return keys.length === 1
        ? new Response(first.stream, { status: 200, headers: jsonHeaders() })
        : json(200, { id: "c_1" });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 2, timeoutMs: 1_000 });

    const outcome = pw.request("POST", "/api/v1/campaigns", { body: { name: "x" } });
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(outcome).resolves.toEqual({ id: "c_1" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("never retries a keyless write whose body read timed out", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, timeoutMs: 1_000 });

    const outcome = pw
      .request("POST", "/api/v1/campaigns", { body: {}, idempotencyKey: null })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await outcome).toBeInstanceOf(TimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honours maxAttempts: 1 under a generous budget", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, timeoutMs: 1_000, totalTimeoutMs: 60_000 });

    const outcome = pw
      .request("POST", "/api/v1/campaigns", { body: {}, maxAttempts: 1 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toMatchObject({ scope: "attempt" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry non-retryable statuses and still maps them", async () => {
    const fetch = vi.fn<FetchFn>(async () => json(409, { error: { code: "conflict", message: "no" } }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 10_000 });

    await expect(pw.request("GET", "/api/v1/subscribers")).rejects.toBeInstanceOf(ConflictError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still surfaces plain transport failures as NetworkError", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      throw new TypeError("socket hang up");
    });
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, totalTimeoutMs: 10_000 });

    const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(err).not.toBeInstanceOf(RequestAbortedError);
    expect(err).toMatchObject({ code: "network_error", message: "socket hang up" });
  });
});

describe("successful calls release everything they armed", () => {
  it("leaves no timers or caller listeners behind after a streamed success", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders({ etag: '"7"' }) }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 10_000 });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);
    const seen: string[] = [];

    const outcome = pw.request("GET", "/api/v1/subscribers", {
      signal: ac.signal,
      onResponseHeaders: (h) => seen.push(h.get("etag") ?? ""),
    });
    body.push('{"items":[],');
    body.push('"total":0}');
    body.close();

    await expect(outcome).resolves.toEqual({ items: [], total: 0 });
    expect(seen).toEqual(['"7"']);
    expect(body.cancel).not.toHaveBeenCalled();
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases after a retried success, a 204 and a text response", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json(503, { error: { message: "x" } }))
      .mockResolvedValueOnce(json(200, { ok: 1 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 1, totalTimeoutMs: 10_000 });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const retried = pw.request("GET", "/a", { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(250);
    await expect(retried).resolves.toEqual({ ok: 1 });
    await expect(pw.request("DELETE", "/b", { signal: ac.signal })).resolves.toBeUndefined();
    await expect(pw.request("GET", "/c", { signal: ac.signal, asText: true })).resolves.toBe("a,b\n1,2\n");

    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases an unread body when the status contract is violated", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0 });

    await expect(
      pw.request("POST", "/api/v1/keys", { body: {}, expectedStatus: 201 }),
    ).rejects.toMatchObject({ name: "ParseError" });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cancellation inside the caller's onResponseHeaders callback", () => {
  it("rejects a 204 whose callback cancels, instead of resolving", async () => {
    const fetch = vi.fn<FetchFn>(async () => new Response(null, { status: 204 }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3 });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const err = await pw
      .request("DELETE", "/api/v1/subscribers/s_1", {
        signal: ac.signal,
        onResponseHeaders: () => ac.abort("navigated away"),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(err).toMatchObject({ payload: "navigated away" });
    expect(fetch).toHaveBeenCalledTimes(1); // cancellation is never retried
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a JSON success whose callback cancels and releases the unread body", async () => {
    const body = controlledBody();
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(body.stream, { status: 200, headers: jsonHeaders() }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch });
    const ac = new AbortController();

    const err = await pw
      .request("GET", "/api/v1/subscribers", {
        signal: ac.signal,
        onResponseHeaders: () => ac.abort(),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("deadlines are enforced by the clock, not only by timer callbacks", () => {
  // These model a blocked event loop: the wall clock passes a deadline while
  // the deadline's timer callback has not run yet. See blockEventLoop().

  it("does not start a retry after the budget passed while the loop was blocked", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // first backoff = 250ms
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json(503, { error: { message: "busy" } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10); // attempt 1 -> 503, backoff armed
    blockEventLoop(1_000); // wall clock now ~1010ms, past the budget
    await vi.advanceTimersByTimeAsync(250); // backoff timer fires first (~1260ms)

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ scope: "total", timeoutMs: 1_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue the 304 cache-bust refetch once the budget has passed", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      blockEventLoop(1_500); // a transport that blocks synchronously
      return new Response(null, { status: 304 });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 1_000 });

    const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "TimeoutError", scope: "total" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve a success that completed after the budget passed", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      blockEventLoop(1_500);
      return json(200, { ok: true });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });

    const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "TimeoutError", scope: "total" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not report an HTTP error that arrived after the budget passed", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      blockEventLoop(1_500);
      return json(409, { error: { code: "conflict", message: "no" } });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 1_000 });

    const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "TimeoutError", scope: "total" });
  });

  it("starts no further wire request within an attempt past its own timeout, then retries", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockImplementationOnce(async () => {
        blockEventLoop(1_500); // past the 1000ms per-attempt timeout
        return new Response(null, { status: 304 });
      })
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.spyOn(Math, "random").mockReturnValue(0);
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 1, timeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers");
    await vi.advanceTimersByTimeAsync(250);

    await expect(outcome).resolves.toEqual({ ok: true });
    // Attempt 1 never sent its cache-bust refetch; attempt 2 is the retry.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).not.toContain("_cb=");
  });

  it("keeps a complete response that merely overran the per-attempt timeout", async () => {
    // Without a budget, the attempt timer only detects stalls. A response
    // that is already complete is returned. Retrying it would repeat work the
    // server already did.
    const fetch = vi.fn<FetchFn>(async () => {
      blockEventLoop(1_500);
      return json(200, { ok: true });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, timeoutMs: 1_000 });

    await expect(pw.request("GET", "/api/v1/subscribers")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("relative budgets ignore wall-clock corrections", () => {
  // adjustWallClock() moves only Date.now, the way an NTP step or a manual
  // clock change does. No real time passes. Budgets are relative durations,
  // so they must neither expire early nor stretch.
  const HOUR = 3_600_000;

  it("does not expire a 1000ms budget when the wall clock jumps forward an hour", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      adjustWallClock(HOUR);
      return json(200, { ok: true });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 1_000 });

    await expect(pw.request("GET", "/api/v1/subscribers")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still retries after a forward jump during the backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json(503, { error: { message: "busy" } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers");
    await vi.advanceTimersByTimeAsync(10);
    adjustWallClock(HOUR);
    await vi.advanceTimersByTimeAsync(250);

    await expect(outcome).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not stretch the budget when the wall clock jumps backward", async () => {
    // With a wall-clock deadline this backward jump made an hour of budget
    // "remain", so a 2s Retry-After backoff was started instead of failing
    // fast with the real error.
    const fetch = vi.fn<FetchFn>(async () => {
      adjustWallClock(-HOUR);
      return json(503, { error: { message: "busy" } }, { "retry-after": "2" });
    });
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });

    const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires on schedule after a backward jump while the transport hangs", async () => {
    const fetch = vi.fn<FetchFn>(() => {
      adjustWallClock(-HOUR);
      return new Promise<Response>(() => undefined);
    });
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "total" });
  });

  it("does not expire the per-attempt timeout on a forward jump (304 refetch still sent)", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockImplementationOnce(async () => {
        adjustWallClock(HOUR);
        return new Response(null, { status: 304 });
      })
      .mockResolvedValueOnce(json(200, { ok: true }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 1_000 });

    await expect(pw.request("GET", "/api/v1/subscribers")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain("_cb=");
  });

  it("keeps the blocked-loop protection when a wall-clock jump happens too", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json(503, { error: { message: "busy" } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });

    const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    adjustWallClock(-HOUR); // correction backward...
    blockEventLoop(1_000); // ...while real time still passes the budget
    await vi.advanceTimersByTimeAsync(250);

    expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "total" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to a non-decreasing wall clock when performance.now is unavailable", async () => {
    await withoutPerformanceNow(async () => {
      const fetch = vi.fn<FetchFn>(() => {
        adjustWallClock(-HOUR); // must not stretch the budget
        return new Promise<Response>(() => undefined);
      });
      const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 1_000 });

      const outcome = pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "total" });
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("monotonic clock fallback without performance.now", () => {
  it("does not let a backward wall-clock jump inflate the remaining budget", async () => {
    // The fallback clamps the wall clock so it never runs backwards. Unclamped,
    // this jump would make an hour "remain" and start a doomed 2s backoff.
    await withoutPerformanceNow(async () => {
      const fetch = vi.fn<FetchFn>(async () => {
        adjustWallClock(-3_600_000);
        return json(503, { error: { message: "busy" } }, { "retry-after": "2" });
      });
      const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });

      const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServerError);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("overlapping requests", () => {
  it("cancels every in-flight call sharing one caller signal and releases all listeners", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 60_000 });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const a = pw.request("GET", "/a", { signal: ac.signal }).catch((e: unknown) => e);
    const b = pw.request("POST", "/b", { body: {}, signal: ac.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(liveListeners()).toBe(2); // one request scope per call

    ac.abort();

    expect(await a).toBeInstanceOf(RequestAbortedError);
    expect(await b).toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a call that finishes first releases only its own listener", async () => {
    let release!: (r: Response) => void;
    const fetch = vi
      .fn<FetchFn>()
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
      .mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const pw = new PostwaveClient({ ...BASE, fetch });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const a = pw.request("GET", "/a", { signal: ac.signal });
    const b = pw.request("GET", "/b", { signal: ac.signal }).catch((e: unknown) => e);
    release(json(200, { a: 1 }));

    await expect(a).resolves.toEqual({ a: 1 });
    expect(liveListeners()).toBe(1); // b still needs it
    ac.abort();
    expect(await b).toBeInstanceOf(RequestAbortedError);
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps per-call budgets independent and never aborts the caller's signal", async () => {
    const fetch = hangingFetch();
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 60_000 });
    const ac = new AbortController();

    const short = pw
      .request("GET", "/short", { signal: ac.signal, totalTimeoutMs: 500 })
      .catch((e: unknown) => e);
    const long = pw
      .request("GET", "/long", { signal: ac.signal, totalTimeoutMs: 2_000 })
      .catch((e: unknown) => e);
    let longSettled = false;
    void long.then(() => (longSettled = true));

    await vi.advanceTimersByTimeAsync(500);
    expect(await short).toMatchObject({ scope: "total", timeoutMs: 500 });
    expect(ac.signal.aborted).toBe(false); // an SDK deadline never propagates upward
    expect(longSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(await long).toMatchObject({ scope: "total", timeoutMs: 2_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a blocked loop expires each overlapping call against its own deadline", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetch = vi.fn<FetchFn>(async () =>
      json(503, { error: { message: "busy" } }),
    );
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 1 });

    const tight = pw
      .request("GET", "/tight", { totalTimeoutMs: 1_000 })
      .catch((e: unknown) => e);
    const roomy = pw
      .request("GET", "/roomy", { totalTimeoutMs: 10_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10); // both got a 503, both backing off
    blockEventLoop(1_000);
    await vi.advanceTimersByTimeAsync(250);

    expect(await tight).toMatchObject({ name: "TimeoutError", scope: "total" });
    expect(await roomy).toBeInstanceOf(ServerError); // its retry ran, then retries ran out
    expect(fetch).toHaveBeenCalledTimes(3); // tight: 1, roomy: 2
    expect(vi.getTimerCount()).toBe(0);
  });
});
