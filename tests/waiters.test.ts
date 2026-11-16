import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NotFoundError,
  PostwaveClient,
  RequestAbortedError,
  TimeoutError,
} from "../src/index.js";
import type { FetchFn } from "../src/index.js";
import { pollUntilTerminal } from "../src/lib/polling.js";
import {
  adjustWallClock,
  blockEventLoop,
  countAbortListeners,
} from "./lifecycle-helpers.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("polling wait helpers", () => {
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };

  it("aborts sequence job waits during the poll sleep", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        id: "job_1",
        tenant_id: "t",
        status: "running",
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:00:00Z",
      }),
    );
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const promise = pw.sequences.waitForJob("job_1", {
      signal: ac.signal,
      intervalMs: 30_000,
    });

    await Promise.resolve();
    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts voice ingest waits during the poll sleep", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        id: "job_1",
        tenant_id: "t",
        source_id: "src_1",
        status: "pending",
        item_count: 0,
        created_at: "2026-05-20T00:00:00Z",
        updated_at: "2026-05-20T00:00:00Z",
      }),
    );
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const promise = pw.voiceProfile.waitForIngestJob("src_1", "job_1", {
      signal: ac.signal,
      intervalMs: 30_000,
    });

    await Promise.resolve();
    await Promise.resolve();
    ac.abort();

    await expect(promise).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Lifecycle guarantees shared by BOTH polling helpers. Each case runs once
 * per helper against a mocked transport under fake timers.
 */
/**
 * Design drafts are terminal for ANY status other than queued/generating, so
 * the generic states must map onto real in-progress statuses.
 */
const DESIGN_STATUS = {
  pending: "queued",
  running: "generating",
  succeeded: "ready",
  failed: "failed",
} as const;

function designDraft(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

/** Generic job states; each waiter maps them onto its own status vocabulary. */
type GenericStatus = "pending" | "running" | "succeeded" | "failed";

type Waiter = {
  name: string;
  /** The exact message a wait deadline of `ms` produces. */
  timeoutMessage: (ms: number) => string;
  /** The waiter's native status for a generic state. */
  status: (generic: GenericStatus) => string;
  job: (generic: GenericStatus) => Record<string, unknown>;
  start: (
    pw: PostwaveClient,
    opts: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number },
  ) => Promise<{ status: string }>;
};

const waiters: Waiter[] = [
  {
    name: "sequences.waitForJob",
    timeoutMessage: (ms) => `sequences.waitForJob(job_1): timed out after ${ms}ms`,
    status: (generic) => generic,
    job: (generic) => ({
      id: "job_1",
      tenant_id: "t",
      status: generic,
      created_at: "2026-05-20T00:00:00Z",
      updated_at: "2026-05-20T00:00:00Z",
    }),
    start: (pw, opts) => pw.sequences.waitForJob("job_1", opts),
  },
  {
    name: "voiceProfile.waitForIngestJob",
    timeoutMessage: (ms) => `voice.waitForIngestJob(job_1): timed out after ${ms}ms`,
    status: (generic) => generic,
    job: (generic) => ({
      id: "job_1",
      tenant_id: "t",
      source_id: "src_1",
      status: generic,
      item_count: 0,
      created_at: "2026-05-20T00:00:00Z",
      updated_at: "2026-05-20T00:00:00Z",
    }),
    start: (pw, opts) => pw.voiceProfile.waitForIngestJob("src_1", "job_1", opts),
  },
  {
    name: "campaignTemplates.waitForDesign",
    timeoutMessage: (ms) => `Campaign template design design_1 did not finish within ${ms}ms`,
    status: (generic) => DESIGN_STATUS[generic],
    job: (generic) => designDraft(DESIGN_STATUS[generic]),
    start: (pw, { intervalMs, ...rest }) =>
      pw.campaignTemplates.waitForDesign("design_1", { ...rest, pollIntervalMs: intervalMs }),
  },
];

describe.each(waiters)("$name lifecycle", (w) => {
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("deadline bounds an in-flight poll whose transport hangs", async () => {
    // The transport ignores its signal; the client per-attempt timeout (60s)
    // is far beyond the 5s wait deadline.
    const fetch = vi.fn<FetchFn>(() => new Promise<Response>(() => undefined));
    const pw = new PostwaveClient({ ...opts, fetch, timeoutMs: 60_000 });

    const outcome = w.start(pw, { timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ scope: "wait", timeoutMs: 5_000 });
    expect((err as Error).message).toBe(w.timeoutMessage(5_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deadline bounds a poll whose response body stalls", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const pw = new PostwaveClient({ ...opts, fetch, timeoutMs: 60_000 });

    const outcome = w.start(pw, { timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "wait" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller cancellation interrupts an in-flight poll and is not a timeout", async () => {
    const fetch = vi.fn<FetchFn>(() => new Promise<Response>(() => undefined));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const live = countAbortListeners(ac.signal);

    const outcome = w.start(pw, { signal: ac.signal, timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();

    const err = await outcome;
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect(err).not.toBeInstanceOf(TimeoutError);
    expect(live()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caller cancellation during the interval sleep stops further polls", async () => {
    const fetch = vi.fn<FetchFn>(async () => jsonResponse(w.job("running")));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();

    const outcome = w
      .start(pw, { signal: ac.signal, intervalMs: 1_000, timeoutMs: 5_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_500); // poll at 0s and 1s, now sleeping
    ac.abort();

    expect(await outcome).toBeInstanceOf(RequestAbortedError);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a signal aborted before the wait starts sends no request", async () => {
    const fetch = vi.fn<FetchFn>(async () => jsonResponse(w.job("running")));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    ac.abort();

    await expect(w.start(pw, { signal: ac.signal })).rejects.toBeInstanceOf(RequestAbortedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("deadline during the interval sleep times out without another poll", async () => {
    const fetch = vi.fn<FetchFn>(async () => jsonResponse(w.job("pending")));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = w.start(pw, { intervalMs: 2_000, timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);

    const err = await outcome;
    expect((err as Error).message).toBe(w.timeoutMessage(5_000));
    expect(err).toMatchObject({ scope: "wait" });
    expect(fetch).toHaveBeenCalledTimes(3); // t=0, 2s, 4s
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["succeeded", "failed"] as const)(
    "resolves with the %s job and releases timers and listeners",
    async (terminal) => {
      const fetch = vi
        .fn<FetchFn>()
        .mockResolvedValueOnce(jsonResponse(w.job("pending")))
        .mockResolvedValueOnce(jsonResponse(w.job("running")))
        .mockResolvedValueOnce(jsonResponse(w.job(terminal)));
      const pw = new PostwaveClient({ ...opts, fetch });
      const ac = new AbortController();
      const live = countAbortListeners(ac.signal);

      const outcome = w.start(pw, { signal: ac.signal, intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(outcome).resolves.toMatchObject({ status: w.status(terminal) });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(live()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("propagates poll errors unchanged and releases the deadline", async () => {
    const fetch = vi.fn<FetchFn>(async () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "gone" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const pw = new PostwaveClient({ ...opts, fetch });

    await expect(w.start(pw, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(NotFoundError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a client per-attempt timeout distinguishable from the wait deadline", async () => {
    const fetch = vi.fn<FetchFn>(() => new Promise<Response>(() => undefined));
    const pw = new PostwaveClient({ ...opts, fetch, timeoutMs: 1_000 });

    const outcome = w.start(pw, { timeoutMs: 60_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "attempt" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(waiters)("$name deadline is enforced by the clock", (w) => {
  // A blocked event loop lets the poll-interval (or client backoff) timer
  // fire before the overdue deadline timer. See blockEventLoop().
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not start another poll after the deadline passed while the loop was blocked", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(w.job("running")))
      .mockResolvedValueOnce(jsonResponse(w.job("succeeded")));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = w.start(pw, { timeoutMs: 1_000, intervalMs: 250 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2); // poll 1 -> running, interval armed
    blockEventLoop(1_000);
    await vi.advanceTimersByTimeAsync(250); // interval timer fires first (~1252ms)

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({ scope: "wait", timeoutMs: 1_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not return a terminal job from a poll that finished after the deadline", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      blockEventLoop(1_500);
      return jsonResponse(w.job("succeeded"));
    });
    const pw = new PostwaveClient({ ...opts, fetch });

    const err = await w.start(pw, { timeoutMs: 1_000 }).catch((e: unknown) => e);

    expect(err).toMatchObject({ name: "TimeoutError", scope: "wait", timeoutMs: 1_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a client retry inside a poll once the wait deadline has passed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // client backoff = 250ms
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(w.job("succeeded")));
    const pw = new PostwaveClient({ ...opts, fetch, retries: 1 });

    const outcome = w.start(pw, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2); // poll 1 -> 503, client backoff armed
    blockEventLoop(1_000);
    await vi.advanceTimersByTimeAsync(250); // client backoff timer fires first

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toBe(w.timeoutMessage(1_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("pollUntilTerminal enforces its own deadline", () => {
  // Unit level, with a plain poll function that knows nothing about SDK
  // scopes. The waiter must hold its guarantees by itself, not only through
  // the client's ancestor-deadline check.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const base = { label: "unit", intervalMs: 250, timeoutMs: 1_000 };

  it("does not start a poll once the deadline passed by the clock", async () => {
    const poll = vi.fn(async () => "running");
    const outcome = pollUntilTerminal({ ...base, poll, isTerminal: (v) => v === "done" }).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(2);
    blockEventLoop(1_000);
    await vi.advanceTimersByTimeAsync(250);

    expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "wait" });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not return a terminal value that arrived after the deadline", async () => {
    const poll = vi.fn(async () => {
      blockEventLoop(1_500);
      return "done";
    });
    const err = await pollUntilTerminal({ ...base, poll, isTerminal: (v) => v === "done" }).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ name: "TimeoutError", scope: "wait" });
    expect((err as Error).message).toBe("unit: timed out after 1000ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a terminal value that arrived in time", async () => {
    const poll = vi.fn(async () => "done");
    await expect(
      pollUntilTerminal({ ...base, poll, isTerminal: (v) => v === "done" }),
    ).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(waiters)("$name under wall-clock corrections and overlap", (w) => {
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };
  const HOUR = 3_600_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps waiting when the wall clock jumps forward an hour", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockImplementationOnce(async () => {
        adjustWallClock(HOUR);
        return jsonResponse(w.job("running"));
      })
      .mockResolvedValueOnce(jsonResponse(w.job("succeeded")));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = w.start(pw, { timeoutMs: 1_000, intervalMs: 250 });
    await vi.advanceTimersByTimeAsync(250);

    await expect(outcome).resolves.toMatchObject({ status: w.status("succeeded") });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still times out on schedule when the wall clock jumps backward", async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      adjustWallClock(-HOUR);
      return jsonResponse(w.job("running"));
    });
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = w.start(pw, { timeoutMs: 1_000, intervalMs: 250 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcome).toMatchObject({ name: "TimeoutError", scope: "wait", timeoutMs: 1_000 });
    expect(fetch).toHaveBeenCalledTimes(4); // 0, 250, 500, 750
    expect(vi.getTimerCount()).toBe(0);
  });

  it("overlapping waits on one signal: one deadline does not end the other", async () => {
    // "running" until 2s of (monotonic) time has passed, then "succeeded".
    const start = performance.now();
    const fetch = vi.fn<FetchFn>(async () =>
      jsonResponse(w.job(performance.now() - start >= 2_000 ? "succeeded" : "running")),
    );
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const short = w
      .start(pw, { signal: ac.signal, timeoutMs: 1_000, intervalMs: 500 })
      .catch((e: unknown) => e);
    const long = w.start(pw, { signal: ac.signal, timeoutMs: 10_000, intervalMs: 500 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await short).toMatchObject({ name: "TimeoutError", scope: "wait", timeoutMs: 1_000 });
    expect(ac.signal.aborted).toBe(false);
    expect(liveListeners()).toBe(1); // only the still-running wait

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(long).resolves.toMatchObject({ status: w.status("succeeded") });
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("overlapping waits on one signal: cancelling ends both", async () => {
    const fetch = vi.fn<FetchFn>(async () => jsonResponse(w.job("running")));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const a = w.start(pw, { signal: ac.signal, intervalMs: 500 }).catch((e: unknown) => e);
    const b = w.start(pw, { signal: ac.signal, intervalMs: 700 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();

    expect(await a).toBeInstanceOf(RequestAbortedError);
    expect(await b).toBeInstanceOf(RequestAbortedError);
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("campaignTemplates.waitForDesign specifics", () => {
  // Shared lifecycle guarantees are covered by the parameterized suites above.
  // These pin what is specific to this helper: its options, defaults,
  // floors, terminal rule and server retry hints, plus the two reported gaps.
  const opts = { apiKey: "k", tenantId: "t", retries: 0 };
  const draft = (status: string, extra: Record<string, unknown> = {}) =>
    jsonResponse(designDraft(status, extra));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reported gap 1: a 1000ms timeout ends a stalled poll", async () => {
    const fetch = vi.fn<FetchFn>(() => new Promise<Response>(() => undefined));
    const pw = new PostwaveClient({ ...opts, fetch, timeoutMs: 60_000 });

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs: 1_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({
      scope: "wait",
      timeoutMs: 1_000,
      message: "Campaign template design design_1 did not finish within 1000ms",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reported gap 2: a successful three-poll wait leaves no abort listeners", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(draft("queued"))
      .mockResolvedValueOnce(draft("generating"))
      .mockResolvedValueOnce(draft("ready"));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const liveListeners = countAbortListeners(ac.signal);

    const outcome = pw.campaignTemplates.waitForDesign("design_1", { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(outcome).resolves.toMatchObject({ status: "ready" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(liveListeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults: polls every 1000ms and times out after 120000ms", async () => {
    const fetch = vi.fn<FetchFn>(async () => draft("generating"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates.waitForDesign("design_1").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(3); // t = 0, 1s, 2s

    await vi.advanceTimersByTimeAsync(118_000);
    expect(await outcome).toMatchObject({
      name: "TimeoutError",
      timeoutMs: 120_000,
      message: "Campaign template design design_1 did not finish within 120000ms",
    });
    expect(fetch).toHaveBeenCalledTimes(120); // t = 0 .. 119s; none at the deadline
  });

  it("keeps the existing floors: timeoutMs >= 1000, pollIntervalMs >= 250", async () => {
    const fetch = vi.fn<FetchFn>(async () => draft("queued"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs: 10, pollIntervalMs: 10 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(4); // t = 0, 250, 500, 750
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatchObject({
      name: "TimeoutError",
      timeoutMs: 1_000,
      message: "Campaign template design design_1 did not finish within 1000ms",
    });
  });

  it("honours a server retry hint longer than the poll interval", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(draft("generating", { retry_after_seconds: 3 }))
      .mockResolvedValueOnce(draft("ready"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates.waitForDesign("design_1", { pollIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toMatchObject({ status: "ready" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never polls sooner than the interval for a shorter retry hint", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(draft("generating", { retry_after_seconds: 1 }))
      .mockResolvedValueOnce(draft("ready"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates.waitForDesign("design_1", { pollIntervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ status: "ready" });
  });

  it("a retry hint past the deadline ends the wait AT the deadline", async () => {
    // Previously the full 30s hint was slept and the wait ran 28s past its
    // 2s timeout. The deadline now bounds the delay.
    const fetch = vi.fn<FetchFn>(async () => draft("generating", { retry_after_seconds: 30 }));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs: 2_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toMatchObject({ name: "TimeoutError", timeoutMs: 2_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["a negative", -5],
    ["a non-numeric", "soon"],
    ["a null", null],
  ])("ignores %s retry hint and uses the poll interval", async (_label, hint) => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(draft("generating", { retry_after_seconds: hint }))
      .mockResolvedValueOnce(draft("ready"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates.waitForDesign("design_1", { pollIntervalMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toMatchObject({ status: "ready" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("still honours a numeric-string retry hint, as the previous coercion did", async () => {
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(draft("generating", { retry_after_seconds: "2" }))
      .mockResolvedValueOnce(draft("ready"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates.waitForDesign("design_1", { pollIntervalMs: 250 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toMatchObject({ status: "ready" });
  });

  it.each(["ready", "failed", "saved", "campaign_created", "archived", "some_future_status"])(
    "returns (does not throw) a draft in terminal status %s",
    async (status) => {
      const fetch = vi.fn<FetchFn>(async () => draft(status));
      const pw = new PostwaveClient({ ...opts, fetch });

      await expect(pw.campaignTemplates.waitForDesign("design_1")).resolves.toMatchObject({
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("a non-finite timeoutMs (%s) falls back to the 120000ms default", async (_label, timeoutMs) => {
    // Previously NaN/Infinity meant the wait could never time out.
    const fetch = vi.fn<FetchFn>(async () => draft("generating"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await outcome).toMatchObject({ name: "TimeoutError", timeoutMs: 120_000 });
  });

  it("a non-finite pollIntervalMs falls back to the 1000ms default", async () => {
    const fetch = vi.fn<FetchFn>(async () => draft("generating"));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { pollIntervalMs: Number.NaN, signal: ac.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetch).toHaveBeenCalledTimes(3); // t = 0, 1s, 2s: not a tight loop
    ac.abort();
    expect(await outcome).toBeInstanceOf(RequestAbortedError);
  });

  it("keeps timeouts above the timer limit from firing immediately (no 30-minute cap)", async () => {
    const fetch = vi.fn<FetchFn>(async () => draft("generating"));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs: 10 ** 12, signal: ac.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60 * 60_000); // an hour: longer than the other waiters' cap
    expect(fetch.mock.calls.length).toBeGreaterThan(3_000);
    ac.abort();
    expect(await outcome).toBeInstanceOf(RequestAbortedError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancellation during the delay is RequestAbortedError carrying the signal's reason", async () => {
    // Previously the raw `signal.reason` was rethrown here, while the same
    // abort during a poll surfaced as RequestAbortedError.
    const fetch = vi.fn<FetchFn>(async () => draft("generating"));
    const pw = new PostwaveClient({ ...opts, fetch });
    const ac = new AbortController();
    const reason = new Error("user left the page");

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { signal: ac.signal })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    ac.abort(reason);

    const err = await outcome;
    expect(err).toBeInstanceOf(RequestAbortedError);
    expect((err as RequestAbortedError).payload).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timeout is still an Error with the same message", async () => {
    const fetch = vi.fn<FetchFn>(async () => draft("generating"));
    const pw = new PostwaveClient({ ...opts, fetch });

    const outcome = pw.campaignTemplates
      .waitForDesign("design_1", { timeoutMs: 1_000 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);

    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Campaign template design design_1 did not finish within 1000ms",
    );
  });
});
