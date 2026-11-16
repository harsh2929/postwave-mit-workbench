/**
 * FOCUSED OFFLINE LIFECYCLE REGRESSIONS. These need no installed dependencies.
 *
 *   npm run test:lifecycle:offline
 *
 * Runs on Node's built-in test runner against the TypeScript SOURCE (via
 * --experimental-transform-types and scripts/offline/register-ts.mjs), with
 * the same socket block as the vitest suite. It is a focused subset for
 * environments where `npm ci` cannot run. It does not replace
 * `npm run verify`: the full fake-timer suite lives in
 * tests/request-lifecycle.test.ts and tests/waiters.test.ts.
 *
 * Real timers are used, so each case is built around guaranteed lower bounds
 * (busy-waits, never-settling transports) and generous upper margins. No
 * outcome depends on scheduler jitter. Global overrides (Date.now,
 * Math.random) are restored in `finally`, and the cases run sequentially.
 * Named *.offline.ts so vitest's *.test.ts glob does not pick it up.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PostwaveClient,
  RequestAbortedError,
  ServerError,
  TimeoutError,
} from "../../src/index.js";
import type { FetchFn } from "../../src/index.js";

const HOUR = 3_600_000;
const BASE = { apiKey: "k", tenantId: "t" } as const;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function job(status: string): Response {
  return json(200, {
    id: "job_1",
    tenant_id: "t",
    source_id: "src_1",
    status,
    item_count: 0,
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:00:00Z",
  });
}

/** Block the event loop synchronously, as CPU-bound application code would. */
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

/** Run `fn` with the wall clock shifted from the moment `shift()` is called. */
async function withWallClock<T>(fn: (shift: (ms: number) => void) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    return await fn((ms) => {
      offset += ms;
    });
  } finally {
    Date.now = realNow;
  }
}

async function withNoJitter<T>(fn: () => Promise<T>): Promise<T> {
  const realRandom = Math.random;
  Math.random = () => 0; // first retry backoff is exactly 250ms
  try {
    return await fn();
  } finally {
    Math.random = realRandom;
  }
}

function designDraft(status: string, extra: Record<string, unknown> = {}): Response {
  return json(200, {
    id: "design_1",
    mode: "generate",
    status,
    reference_template_ids: [],
    current_revision: 1,
    attempt_count: 1,
    created_at: "2026-05-20T00:00:00Z",
    updated_at: "2026-05-20T00:00:00Z",
    expires_at: "2026-05-21T00:00:00Z",
    ...extra,
  });
}

/** Count "abort" listeners still attached to `signal` (no vitest available here). */
function countAbortListeners(signal: AbortSignal): () => number {
  type ListenerFn = (type: string, listener: unknown, options?: unknown) => void;
  const live = new Set<unknown>();
  const target = signal as unknown as { addEventListener: ListenerFn; removeEventListener: ListenerFn };
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

const never = (): Promise<Response> => new Promise<Response>(() => undefined);

describe("offline: cancellation", { concurrency: 1 }, () => {
  test("cancelling inside onResponseHeaders rejects a 204 instead of resolving", async () => {
    let calls = 0;
    const fetch: FetchFn = async () => {
      calls++;
      return new Response(null, { status: 204 });
    };
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 3 });
    const ac = new AbortController();

    await assert.rejects(
      pw.request("DELETE", "/api/v1/subscribers/s_1", {
        signal: ac.signal,
        onResponseHeaders: () => ac.abort(),
      }),
      RequestAbortedError,
    );
    assert.equal(calls, 1);
  });

  test("cancelling during a stalled body read rejects and cancels the body", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const fetch: FetchFn = async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    const pw = new PostwaveClient({ ...BASE, fetch, timeoutMs: 60_000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);

    const err = await pw
      .request("GET", "/api/v1/subscribers", { signal: ac.signal })
      .catch((e: unknown) => e);
    assert.ok(err instanceof RequestAbortedError);
    assert.ok(!(err instanceof TimeoutError));
    assert.equal(cancelled, 1);
  });

  test("the per-attempt timeout covers a stalled body", async () => {
    const fetch: FetchFn = async () =>
      new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 100 });

    const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
    assert.ok(err instanceof TimeoutError);
    assert.equal(err.scope, "attempt");
  });
});

describe("offline: wall-clock corrections do not move relative budgets", { concurrency: 1 }, () => {
  test("a forward jump of an hour does not expire a 1000ms budget", async () => {
    await withWallClock(async (shift) => {
      const fetch: FetchFn = async () => {
        shift(HOUR);
        return json(200, { ok: true });
      };
      const pw = new PostwaveClient({ ...BASE, fetch, totalTimeoutMs: 1_000 });
      assert.deepEqual(await pw.request("GET", "/api/v1/subscribers"), { ok: true });
    });
  });

  test("a backward jump of an hour does not stretch the budget", async () => {
    await withWallClock(async (shift) => {
      const fetch: FetchFn = async () => {
        shift(-HOUR);
        return json(503, { error: { message: "busy" } }, { "retry-after": "2" });
      };
      const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });
      const started = performance.now();
      // The 2s Retry-After cannot fit in the 1s budget: fail fast with the
      // real error rather than believing an hour of budget remains.
      await assert.rejects(pw.request("GET", "/api/v1/subscribers"), ServerError);
      assert.ok(performance.now() - started < 900, "should fail fast, not wait out the budget");
    });
  });

  test("a waiter keeps polling across a forward jump", async () => {
    await withWallClock(async (shift) => {
      let calls = 0;
      const fetch: FetchFn = async () => {
        calls++;
        if (calls === 1) {
          shift(HOUR);
          return job("running");
        }
        return job("succeeded");
      };
      const pw = new PostwaveClient({ ...BASE, fetch, retries: 0 });
      const result = await pw.voiceProfile.waitForIngestJob("src_1", "job_1", {
        timeoutMs: 1_000,
        intervalMs: 20,
      });
      assert.equal(result.status, "succeeded");
      assert.equal(calls, 2);
    });
  });
});

describe("offline: a blocked event loop cannot outrun a deadline", { concurrency: 1 }, () => {
  // The loop is blocked ~1.1s by unrelated synchronous work. When it resumes,
  // an earlier backoff/interval timer can run before the overdue deadline
  // timer. Whichever order Node picks, nothing may start or settle past the
  // deadline.
  test("no retry starts after a 1000ms budget passed", async () => {
    await withNoJitter(async () => {
      let calls = 0;
      const fetch: FetchFn = async () => {
        calls++;
        return calls === 1 ? json(503, { error: { message: "busy" } }) : json(200, { ok: true });
      };
      const pw = new PostwaveClient({ ...BASE, fetch, retries: 3, totalTimeoutMs: 1_000 });
      setTimeout(() => busyWait(1_100), 10);

      const err = await pw.request("GET", "/api/v1/subscribers").catch((e: unknown) => e);
      assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
      assert.equal(err.scope, "total");
      assert.equal(calls, 1);
    });
  });

  for (const [name, start] of [
    ["sequences.waitForJob", (pw: PostwaveClient) => pw.sequences.waitForJob("job_1", { timeoutMs: 1_000, intervalMs: 250 })],
    ["voiceProfile.waitForIngestJob", (pw: PostwaveClient) => pw.voiceProfile.waitForIngestJob("src_1", "job_1", { timeoutMs: 1_000, intervalMs: 250 })],
    ["campaignTemplates.waitForDesign", (pw: PostwaveClient) => pw.campaignTemplates.waitForDesign("design_1", { timeoutMs: 1_000, pollIntervalMs: 250 })],
  ] as const) {
    test(`${name}: no poll starts after a 1000ms wait deadline passed`, async () => {
      let calls = 0;
      const design = name === "campaignTemplates.waitForDesign";
      const fetch: FetchFn = async () => {
        calls++;
        if (design) return designDraft(calls === 1 ? "generating" : "ready");
        return job(calls === 1 ? "running" : "succeeded");
      };
      const pw = new PostwaveClient({ ...BASE, fetch, retries: 0 });
      setTimeout(() => busyWait(1_100), 10);

      const err = await start(pw).catch((e: unknown) => e);
      assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
      assert.equal(err.scope, "wait");
      assert.equal(calls, 1);
    });
  }
});

describe("offline: campaignTemplates.waitForDesign", { concurrency: 1 }, () => {
  test("a 1000ms timeout ends a stalled poll", async () => {
    let calls = 0;
    const fetch: FetchFn = () => {
      calls++;
      return never();
    };
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0, timeoutMs: 60_000 });
    const started = performance.now();

    const err = await pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs: 1_000 })
      .catch((e: unknown) => e);
    assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
    assert.equal(err.scope, "wait");
    assert.equal(err.message, "Campaign template design design_1 did not finish within 1000ms");
    assert.equal(calls, 1);
    assert.ok(performance.now() - started < 5_000, "the stalled poll must not outlive the deadline");
  });

  test("a successful three-poll wait leaves no abort listeners", async () => {
    const statuses = ["queued", "generating", "ready"];
    let calls = 0;
    const fetch: FetchFn = async () => designDraft(statuses[calls++] ?? "ready");
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0 });
    const ac = new AbortController();
    const live = countAbortListeners(ac.signal);

    const result = await pw.campaignTemplates.waitForDesign("design_1", {
      signal: ac.signal,
      pollIntervalMs: 250,
    });
    assert.equal(result.status, "ready");
    assert.equal(calls, 3);
    assert.equal(live(), 0);
  });

  test("a server retry hint longer than the interval is honoured", async () => {
    let calls = 0;
    const fetch: FetchFn = async () =>
      ++calls === 1 ? designDraft("generating", { retry_after_seconds: 0.4 }) : designDraft("ready");
    const pw = new PostwaveClient({ ...BASE, fetch, retries: 0 });
    const started = performance.now();

    const result = await pw.campaignTemplates.waitForDesign("design_1", { pollIntervalMs: 250 });
    assert.equal(result.status, "ready");
    // Timers never fire early, so this lower bound is deterministic.
    assert.ok(performance.now() - started >= 390, "must wait the 400ms hint, not the 250ms interval");
  });
});

describe("offline: overlapping requests", { concurrency: 1 }, () => {
  test("one caller signal cancels every overlapping call", async () => {
    const pw = new PostwaveClient({ ...BASE, fetch: never, totalTimeoutMs: 60_000 });
    const ac = new AbortController();
    const a = pw.request("GET", "/a", { signal: ac.signal }).catch((e: unknown) => e);
    const b = pw.request("POST", "/b", { body: {}, signal: ac.signal }).catch((e: unknown) => e);
    setTimeout(() => ac.abort(), 20);

    assert.ok((await a) instanceof RequestAbortedError);
    assert.ok((await b) instanceof RequestAbortedError);
  });

  test("overlapping calls keep independent budgets and never abort the caller", async () => {
    const pw = new PostwaveClient({ ...BASE, fetch: never, retries: 0, timeoutMs: 60_000 });
    const ac = new AbortController();
    let longSettled = false;
    const short = pw
      .request("GET", "/short", { signal: ac.signal, totalTimeoutMs: 100 })
      .catch((e: unknown) => e);
    const long = pw
      .request("GET", "/long", { signal: ac.signal, totalTimeoutMs: 400 })
      .catch((e: unknown) => e)
      .finally(() => {
        longSettled = true;
      });

    const shortErr = await short;
    assert.ok(shortErr instanceof TimeoutError);
    assert.equal(shortErr.timeoutMs, 100);
    assert.equal(ac.signal.aborted, false);
    assert.equal(longSettled, false);

    const longErr = await long;
    assert.ok(longErr instanceof TimeoutError);
    assert.equal(longErr.timeoutMs, 400);
  });
});
