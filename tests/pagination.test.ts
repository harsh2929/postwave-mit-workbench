/**
 * Pagination: the shared behavior cases (also run dependency-free by
 * tests/offline/pagination.offline.ts), plus deterministic fake-timer checks
 * of the time budget's exact boundary, the monotonic clock, a blocked event
 * loop and timer release, which need vitest.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaginationError, PostwaveClient } from "../src/index.js";
import type { FetchFn } from "../src/index.js";
import { adjustWallClock, blockEventLoop } from "./lifecycle-helpers.js";
import { iterateItems, iteratePages } from "../src/lib/pagination.js";
import { handoffSpec, json, paginationCases } from "./pagination-cases.js";
import { concurrencyCases } from "./pagination-concurrency-cases.js";
import { retryCases } from "./pagination-retry-cases.js";

describe("pagination (shared cases)", () => {
  for (const c of paginationCases) it(c.name, c.run);
});

describe("pagination: concurrent traversals on one client (shared cases)", () => {
  for (const c of concurrencyCases) it(c.name, c.run);
});

describe("pagination: retry and recovery (shared cases)", () => {
  for (const c of retryCases) it(c.name, c.run);
});

describe("pagination time budget (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function client(fetch: FetchFn, retries = 0): PostwaveClient {
    return new PostwaveClient({ apiKey: "k", tenantId: "t", retries, fetch });
  }

  const pages = (url: string) => {
    const cursor = new URL(url).searchParams.get("cursor");
    return json(
      cursor === null
        ? { items: [{ id: "a" }, { id: "b" }], next_cursor: "c1" }
        : { items: [{ id: "c" }], next_cursor: null },
    );
  };

  it("holds no timer while the consumer has control, and none afterwards", async () => {
    vi.useFakeTimers();
    const it = client(async (url) => pages(url)).audit.queryAll(
      {},
      { timeBudgetMs: 60_000, signal: new AbortController().signal },
    );
    expect(vi.getTimerCount()).toBe(0);
    await it.next();
    expect(vi.getTimerCount()).toBe(0);
    await it.next();
    await it.next();
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires exactly at the budget during a stalled page request", async () => {
    vi.useFakeTimers();
    const it = client(() => new Promise<Response>(() => undefined)).subscribers.listPages(
      {},
      { timeBudgetMs: 1_000 },
    );
    let settled: unknown = "pending";
    it.next().then(
      () => (settled = "resolved"),
      (e: unknown) => (settled = e),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeInstanceOf(PaginationError);
    expect((settled as PaginationError).reason).toBe("time_budget");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts a Retry-After backoff inside the budget and releases the backoff timer", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () =>
      json({ error: { code: "busy", message: "busy" } }, 503, { "retry-after": "2" }),
    );
    const it = client(fetch, 3).audit.queryPages({}, { timeBudgetMs: 1_000 });
    const result = it.next().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const e = await result;
    expect(e).toBeInstanceOf(PaginationError);
    expect((e as PaginationError).reason).toBe("time_budget");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the budget at the first next(), however long after creation", async () => {
    vi.useFakeTimers();
    const it = client(async (url) => pages(url)).audit.queryAll({}, { timeBudgetMs: 1_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    blockEventLoop(60_000);
    const ids: string[] = [];
    for await (const row of it) ids.push(row.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("a blocked event loop past the budget stops delivery of buffered items by the clock", async () => {
    vi.useFakeTimers();
    const it = client(async (url) => pages(url)).audit.queryAll({}, { timeBudgetMs: 1_000 });
    await it.next();
    // The consumer's own CPU-bound work: no timer fires, the clock moves.
    blockEventLoop(1_001);
    await expect(it.next()).rejects.toMatchObject({ reason: "time_budget" });
    expect(it.progress).toMatchObject({ items: 1, stopReason: "time_budget", complete: false });
  });

  it("a page that completes after the budget passed by the clock is discarded", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (url: string) => {
      blockEventLoop(1_500); // the transport blocks the loop past the budget
      return pages(url);
    });
    const it = client(fetch).audit.queryPages({}, { timeBudgetMs: 1_000 });
    await expect(it.next()).rejects.toMatchObject({ reason: "time_budget", pages: 0 });
  });

  it("hand-off window: the budget boundary is exact and identical for pages and items", async () => {
    vi.useFakeTimers();
    for (const mode of ["pages", "items"] as const) {
      for (const [blockMs, rejected] of [[999, false], [1_000, true]] as const) {
        // The trapped page-2 microtask moves the monotonic clock by blockMs
        // after page 2 is accepted, measured from the first next() at t=0.
        const spec = handoffSpec(2, () => blockEventLoop(blockMs));
        const it =
          mode === "pages"
            ? iteratePages<unknown>(spec, { timeBudgetMs: 1_000 })
            : iterateItems<unknown>(spec, { timeBudgetMs: 1_000 });
        const out: unknown[] = [];
        const outcome = await (async () => {
          for await (const x of it) {
            out.push(x);
            if (out.length === (mode === "pages" ? 2 : 4)) break;
          }
        })().then(() => "delivered", (e: unknown) => e);
        const label = `${mode}, ${blockMs}ms`;
        if (rejected) {
          expect(outcome, label).toBeInstanceOf(PaginationError);
          expect((outcome as PaginationError).reason, label).toBe("time_budget");
          expect(out.length, label).toBe(mode === "pages" ? 1 : 2);
          expect(it.progress, label).toMatchObject({ pages: 1, stopReason: "time_budget" });
        } else {
          expect(outcome, label).toBe("delivered");
        }
        expect(vi.getTimerCount(), label).toBe(0);
      }
    }
  });

  it("a retried page's Retry-After backoff counts exactly toward the traversal budget", async () => {
    vi.useFakeTimers();
    for (const [budget, recovers] of [[1_000, false], [1_001, true]] as const) {
      let calls = 0;
      const fetch = vi.fn(async () =>
        ++calls === 1
          ? json({ error: { code: "busy", message: "busy" } }, 503, { "retry-after": "1" })
          : json({ items: [{ id: "a" }], next_cursor: null }),
      );
      const it = client(fetch, 3).audit.queryAll({}, { timeBudgetMs: budget });
      const first = it.next().then((r) => r, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      const label = `budget ${budget}`;
      if (recovers) {
        // The backoff ends at 1000 ms, inside the budget: the same page is
        // retried once and delivered.
        expect(await first, label).toEqual({ done: false, value: { id: "a" } });
        expect(fetch, label).toHaveBeenCalledTimes(2);
        await expect(it.next()).resolves.toEqual({ done: true, value: undefined });
        expect(it.progress, label).toMatchObject({ pages: 1, items: 1, complete: true });
      } else {
        // The budget ends exactly where the backoff would: no retry is sent.
        const e = await first;
        expect(e, label).toBeInstanceOf(PaginationError);
        expect((e as PaginationError).reason, label).toBe("time_budget");
        expect(fetch, label).toHaveBeenCalledTimes(1);
        expect(it.progress, label).toMatchObject({ pages: 0, items: 0, stopReason: "time_budget" });
      }
      expect(vi.getTimerCount(), label).toBe(0);
    }
  });

  it("wall-clock corrections do not move the budget", async () => {
    vi.useFakeTimers();
    const it = client(async (url) => pages(url)).audit.queryAll({}, { timeBudgetMs: 1_000 });
    await it.next();
    adjustWallClock(3_600_000);
    await it.next();
    adjustWallClock(-7_200_000);
    await expect(it.next()).resolves.toMatchObject({ done: false, value: { id: "c" } });
    await expect(it.next()).resolves.toEqual({ done: true, value: undefined });
    expect(it.progress.complete).toBe(true);
  });

  it("clamps a budget above the runtime timer limit instead of firing at once", async () => {
    vi.useFakeTimers();
    const it = client(() => new Promise<Response>(() => undefined)).audit.queryPages(
      {},
      { timeBudgetMs: Number.MAX_SAFE_INTEGER },
    );
    let settled = false;
    it.next().catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
  });
});
