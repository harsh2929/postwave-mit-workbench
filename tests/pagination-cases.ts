/**
 * Pagination behavior cases shared by two runners:
 *
 *   - vitest:       tests/pagination.test.ts (part of `npm test` / `verify`)
 *   - node:test:    tests/offline/pagination.offline.ts
 *                   (`npm run --offline test:pagination:offline`, no deps)
 *
 * This module imports nothing but Node built-ins and the SDK source, so the
 * same cases run where `npm ci` cannot. Every transport is a local mock.
 * Time-based cases use real timers with wide margins. They assert lower
 * bounds that a fast machine cannot beat, and upper bounds far beyond any
 * scheduler jitter. Exact timer counts live in the vitest-only file.
 */
import assert from "node:assert/strict";

import {
  PaginationError,
  PostwaveClient,
  RequestAbortedError,
  ServerError,
} from "../src/index.js";
import type { FetchFn, PostwaveClientOptions } from "../src/index.js";
import {
  iterateItems,
  iteratePages,
  type PaginationSpec,
} from "../src/lib/pagination.js";
import { fixtureEmail } from "./fixture-data.js";

export interface PaginationCase {
  name: string;
  run: () => Promise<void>;
}

/* ------------------------------------------------------------------ helpers */

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Handler = (url: URL, call: number, init?: RequestInit) => Response | Promise<Response>;

export function harness(
  handler: Handler,
  options: Partial<PostwaveClientOptions> = {},
): { pw: PostwaveClient; calls: URL[] } {
  const calls: URL[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(input);
    calls.push(url);
    return handler(url, calls.length, init);
  };
  const pw = new PostwaveClient({
    apiKey: "k",
    tenantId: "t",
    retries: 0,
    fetch,
    ...options,
  });
  return { pw, calls };
}

export async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Count live "abort" listeners on one signal, without any test framework. */
export function countAbortListeners(signal: AbortSignal): () => number {
  type Fn = (type: string, listener: unknown, options?: unknown) => void;
  const live = new Set<unknown>();
  const target = signal as unknown as { addEventListener: Fn; removeEventListener: Fn };
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

const sub = (i: number) => ({
  id: `sub_${i}`,
  email: fixtureEmail(`reader${i}`),
  status: "enabled",
});

/**
 * An offset server for `/api/v1/subscribers` or list members: `total` rows,
 * honoring ?page and ?per_page like the contract describes.
 */
function offsetPage(url: URL, total: number, defaultPerPage = 2, extra: object = {}): Response {
  const page = Number(url.searchParams.get("page") ?? 1);
  const perPage = Number(url.searchParams.get("per_page") ?? defaultPerPage);
  const from = (page - 1) * perPage;
  const items = [];
  for (let i = from; i < Math.min(from + perPage, total); i++) items.push(sub(i));
  return json({ ...extra, items, total, page, per_page: perPage });
}

/**
 * A cursor server: page 0 answers a request without a cursor, page i answers
 * cursor `c<i>`. Each page's `next` is `c<i+1>`, or null on the last page.
 */
function cursorPage(
  url: URL,
  itemsKey: string,
  sizes: number[],
  lastCursor: unknown = null,
): Response {
  const cursor = url.searchParams.get("cursor");
  const index = cursor === null ? 0 : Number(cursor.slice(1));
  const size = sizes[index] ?? 0;
  const items = Array.from({ length: size }, (_, k) => ({ id: `row_${index}_${k}` }));
  const next = index + 1 < sizes.length ? `c${index + 1}` : lastCursor;
  return json({ [itemsKey]: items, next_cursor: next });
}

async function rejectsWith(
  promise: Promise<unknown>,
  check: (e: unknown) => boolean,
  label: string,
): Promise<unknown> {
  let caught: unknown;
  await assert.rejects(promise, (e: unknown) => {
    caught = e;
    return check(e);
  }, label);
  return caught;
}

/**
 * Run `fn` with the SDK's monotonic clock under test control.
 *
 * The SDK measures budgets with `performance.now()`, read on every call.
 * This layers an offset over it, so `advance(ms)` moves the clock forward
 * instantly, as a blocked event loop or a paused VM would, but
 * deterministically. Tests that need work to SUCCEED inside a budget use a
 * budget far beyond any real scheduling delay (60 s) and cross it with
 * `advance`, so a slow or briefly frozen machine cannot make them fail.
 * Cases that only assert FAILURE after a real budget keep short real
 * budgets: a pause can only add time there. Framework-free (both runners),
 * and always restored.
 */
export async function withClockOffset<T>(fn: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
  const perf = globalThis.performance;
  const own = Object.getOwnPropertyDescriptor(perf, "now");
  const realNow = perf.now.bind(perf);
  let offset = 0;
  Object.defineProperty(perf, "now", { value: () => realNow() + offset, configurable: true, writable: true });
  try {
    return await fn((ms) => {
      offset += ms;
    });
  } finally {
    if (own) Object.defineProperty(perf, "now", own);
    else delete (perf as { now?: unknown }).now;
  }
}

/** A budget no real scheduling delay reaches; tests cross it with advance(). */
export const LONG_BUDGET_MS = 60_000;

/**
 * A cursor collection whose page `trapPage` (1-based) runs `inWindow` in the
 * hand-off window: AFTER the engine has run its last pre-acceptance check and
 * accepted the page, and BEFORE the iterator can yield it.
 *
 * The engine reads `next_cursor` while accepting the page. That getter queues
 * `inWindow` as a microtask. It runs once acceptance has finished
 * synchronously, and before the generator can resume from awaiting the
 * fetch, which needs at least one more microtask. So it lands in the window
 * however many awaits the engine has, with no timing dependence.
 */
export function handoffSpec(
  trapPage: number,
  inWindow: () => void,
  emptyTrapPage = false,
): PaginationSpec {
  return {
    operation: "test.handoff",
    itemsKey: "items",
    cursorKey: "next_cursor",
    start: {},
    fetch: async (continuation) => {
      const n = continuation.cursor === undefined ? 1 : Number(continuation.cursor.slice(1));
      const items = emptyTrapPage && n === trapPage ? [] : [{ id: `p${n}a` }, { id: `p${n}b` }];
      const page: Record<string, unknown> = { items };
      Object.defineProperty(page, "next_cursor", {
        enumerable: true,
        get() {
          if (n === trapPage) queueMicrotask(inWindow);
          return n < 3 ? `c${n + 1}` : null;
        },
      });
      return page;
    },
  };
}

const isPagination = (reason: string) => (e: unknown) =>
  e instanceof PaginationError && e.reason === reason && e.code === `pagination_${reason}`;

/* -------------------------------------------------------------------- cases */

export const paginationCases: PaginationCase[] = [
  /* ---- contracts, routes and stable filters ---- */
  {
    name: "subscribers.listAll walks offset pages with unchanged filters and stops at total",
    async run() {
      const { pw, calls } = harness((url) => offsetPage(url, 5));
      const params = { q: "acme", status: "enabled", sort: "email", order: "asc" as const, per_page: 2 };
      const it = pw.subscribers.listAll(params);
      const ids = (await drain(it)).map((s) => s.id);
      assert.deepEqual(ids, ["sub_0", "sub_1", "sub_2", "sub_3", "sub_4"]);
      // 3 pages, no extra request after page*per_page >= total.
      assert.equal(calls.length, 3);
      calls.forEach((url, i) => {
        assert.equal(url.pathname, "/api/v1/subscribers");
        assert.equal(url.searchParams.get("q"), "acme");
        assert.equal(url.searchParams.get("status"), "enabled");
        assert.equal(url.searchParams.get("sort"), "email");
        assert.equal(url.searchParams.get("order"), "asc");
        assert.equal(url.searchParams.get("per_page"), "2");
        assert.equal(url.searchParams.get("page"), String(i + 1));
        assert.equal(url.searchParams.get("cursor"), null);
      });
      assert.deepEqual(it.progress, {
        pages: 3, items: 5, done: true, complete: true, stopReason: "end",
      });
    },
  },
  {
    name: "subscribers switch to the keyset cursor once offered and follow only it",
    async run() {
      const { pw, calls } = harness((url) => {
        const cursor = url.searchParams.get("cursor");
        if (cursor === null) {
          return json({ items: [sub(0), sub(1)], total: 99, page: 1, per_page: 2, next_cursor: "k1" });
        }
        if (cursor === "k1") {
          return json({ items: [sub(2), sub(3)], total: 99, page: 1, per_page: 2, next_cursor: "k2" });
        }
        // Cursor absent on the last page: the end, whatever `total` says.
        return json({ items: [sub(4)], total: 99, page: 1, per_page: 2 });
      });
      const ids = (await drain(pw.subscribers.listAll({ q: "acme", per_page: 2 }))).map((s) => s.id);
      assert.deepEqual(ids, ["sub_0", "sub_1", "sub_2", "sub_3", "sub_4"]);
      assert.equal(calls.length, 3);
      assert.equal(calls[0]!.searchParams.get("page"), "1");
      for (const [i, url] of calls.slice(1).entries()) {
        assert.equal(url.searchParams.get("cursor"), `k${i + 1}`);
        assert.equal(url.searchParams.get("page"), null, "no page once in cursor mode");
        assert.equal(url.searchParams.get("q"), "acme");
        assert.equal(url.searchParams.get("per_page"), "2");
      }
    },
  },
  {
    name: "subscribers resume from a caller cursor, which wins over page",
    async run() {
      const { pw, calls } = harness(() =>
        json({ items: [sub(7)], total: 8, page: 1, per_page: 50 }),
      );
      await drain(pw.subscribers.listAll({ cursor: "resume-here", page: 4 }));
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.searchParams.get("cursor"), "resume-here");
      assert.equal(calls[0]!.searchParams.get("page"), null);
    },
  },
  {
    name: "lists.membersPages yields typed contract pages and ends at page*per_page >= total",
    async run() {
      const { pw, calls } = harness((url) => offsetPage(url, 3, 2, { list_id: "list-uuid" }));
      const pages = await drain(pw.lists.membersPages(42, { q: "", status: "enabled", per_page: 2 }));
      assert.equal(pages.length, 2);
      assert.equal(pages[0]!.list_id, "list-uuid");
      assert.deepEqual(pages.map((p) => p.items.length), [2, 1]);
      assert.equal(calls.length, 2);
      for (const url of calls) {
        assert.equal(url.pathname, "/api/v1/lists/42/subscribers");
        assert.equal(url.searchParams.get("q"), null, "empty q is not sent, as in members()");
        assert.equal(url.searchParams.get("status"), "enabled");
      }
    },
  },
  {
    name: "offset iteration ends on an empty page even if total still claims more",
    async run() {
      const { pw, calls } = harness((url) => {
        const page = Number(url.searchParams.get("page"));
        return json({
          list_id: "l",
          items: page === 1 ? [sub(0), sub(1)] : [],
          total: 10, // stale: rows were deleted concurrently
          page,
          per_page: 2,
        });
      });
      const it = pw.lists.membersAll("l", { per_page: 2 });
      assert.equal((await drain(it)).length, 2);
      assert.equal(calls.length, 2);
      // The stale total conflicts with the empty page: iteration still ends
      // there, but completeness is not claimed.
      assert.equal(it.progress.complete, false);
      assert.equal(it.progress.stopReason, "metadata_conflict");
      assert.deepEqual(it.progress.conflicts, ["empty_before_total"]);
    },
  },
  {
    name: "webhooks, deliveries and audit follow next_cursor with their own item keys",
    async run() {
      const { pw, calls } = harness((url) => {
        if (url.pathname.endsWith("/deliveries")) return cursorPage(url, "deliveries", [2, 1]);
        if (url.pathname === "/api/v1/outbound-webhooks") return cursorPage(url, "webhooks", [1, 2], "");
        return cursorPage(url, "items", [2, 2]);
      });
      const hooks = await drain(pw.webhooks.listAll({ query: "prod", limit: 2 }));
      const deliveries = await drain(pw.webhooks.deliveriesAll("wh/1", { limit: 2 }));
      const audit = await drain(pw.audit.queryAll({ action: "subscriber.delete", since: "2026-01-01T00:00:00Z" }));
      assert.equal(hooks.length, 3); // ends on an empty-string cursor
      assert.equal(deliveries.length, 3); // ends on null
      assert.equal(audit.length, 4);
      const hookCalls = calls.filter((u) => u.pathname === "/api/v1/outbound-webhooks");
      assert.deepEqual(hookCalls.map((u) => u.searchParams.get("cursor")), [null, "c1"]);
      assert.ok(hookCalls.every((u) => u.searchParams.get("query") === "prod" && u.searchParams.get("limit") === "2"));
      const deliveryCalls = calls.filter((u) => u.pathname.endsWith("/deliveries"));
      assert.ok(deliveryCalls.every((u) => u.pathname === "/api/v1/outbound-webhooks/wh%2F1/deliveries"));
      const auditCalls = calls.filter((u) => u.pathname === "/api/v1/audit");
      assert.ok(auditCalls.every((u) => u.searchParams.get("action") === "subscriber.delete"));
      assert.deepEqual(auditCalls.map((u) => u.searchParams.get("cursor")), [null, "c1"]);
    },
  },
  {
    name: "page iterators yield each server page unchanged",
    async run() {
      const { pw } = harness((url) => cursorPage(url, "items", [2, 1]));
      const pages = await drain(pw.audit.queryPages());
      assert.deepEqual(pages, [
        { items: [{ id: "row_0_0" }, { id: "row_0_1" }], next_cursor: "c1" },
        { items: [{ id: "row_1_0" }], next_cursor: null },
      ]);
    },
  },
  {
    name: "filters are snapshotted: mutating the caller's params changes nothing",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [1, 1, 1]));
      const params: { action?: string; actor_type?: string } = { action: "a1" };
      const it = pw.audit.queryAll(params);
      await it.next();
      params.action = "changed";
      params.actor_type = "added";
      await drain(it);
      assert.equal(calls.length, 3);
      for (const url of calls) {
        assert.equal(url.searchParams.get("action"), "a1");
        assert.equal(url.searchParams.get("actor_type"), null);
      }
    },
  },
  /* ---- laziness and bounded work ---- */
  {
    name: "lazy: no request on creation, and the next page only on demand",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "webhooks", [2, 2]));
      const it = pw.webhooks.listAll();
      await sleep(5);
      assert.equal(calls.length, 0, "creating an iterator sends nothing");
      await it.next();
      assert.equal(calls.length, 1);
      await it.next(); // last item of page 1
      assert.equal(calls.length, 1, "no prefetch of page 2");
      await it.next();
      assert.equal(calls.length, 2);
      await it.return();
    },
  },
  {
    name: "concurrent next() calls are served in order without duplicate requests",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [2, 2]));
      const it = pw.audit.queryAll();
      const results = await Promise.all([it.next(), it.next(), it.next(), it.next(), it.next()]);
      assert.deepEqual(
        results.map((r) => (r.done ? "done" : (r.value as { id: string }).id)),
        ["row_0_0", "row_0_1", "row_1_0", "row_1_1", "done"],
      );
      assert.equal(calls.length, 2);
    },
  },
  {
    name: "break stops iteration: no further request, progress says consumer_stopped",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [3, 3]));
      const it = pw.audit.queryAll();
      for await (const row of it) {
        if (row.id === "row_0_1") break;
      }
      assert.equal(calls.length, 1);
      assert.deepEqual(it.progress, {
        pages: 1, items: 2, done: true, complete: false, stopReason: "consumer_stopped",
      });
      assert.deepEqual(await it.next(), { done: true, value: undefined });
    },
  },
  {
    name: "return() before the first next() sends nothing",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [1]));
      const it = pw.audit.queryPages();
      await it.return();
      assert.deepEqual(await it.next(), { done: true, value: undefined });
      assert.equal(calls.length, 0);
      assert.equal(it.progress.stopReason, "consumer_stopped");
    },
  },
  /* ---- empty pages ---- */
  {
    name: "an empty cursor page with a continuation is followed; one without ends",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "deliveries", [0, 2, 0]));
      const pages = pw.webhooks.deliveriesPages("wh_1");
      assert.deepEqual((await drain(pages)).map((p) => p.deliveries.length), [0, 2, 0]);
      const items = pw.webhooks.deliveriesAll("wh_1");
      assert.equal((await drain(items)).length, 2);
      assert.equal(calls.length, 6);
      assert.equal(items.progress.complete, true);
    },
  },
  {
    name: "an empty first page completes with zero items",
    async run() {
      const { pw } = harness((url) => offsetPage(url, 0));
      const it = pw.subscribers.listAll();
      assert.deepEqual(await drain(it), []);
      assert.deepEqual(it.progress, { pages: 1, items: 0, done: true, complete: true, stopReason: "end" });
    },
  },
  /* ---- malformed pages ---- */
  {
    name: "malformed pages reject with PaginationError and deliver none of their items",
    async run() {
      const bad: Array<[string, unknown, string]> = [
        ["array body", [sub(1)], "not a JSON object"],
        ["items missing", { total: 1, page: 1, per_page: 2 }, "`items` is not an array"],
        ["null item", { items: [sub(0), null], total: 2, page: 1, per_page: 2 }, "non-object entry"],
        ["cursor not string", { items: [sub(0)], total: 1, page: 1, per_page: 2, next_cursor: 7 }, "`next_cursor` is not a string"],
        ["total missing", { items: [sub(0)], page: 1, per_page: 2 }, "`total`"],
        ["page too large", { items: [sub(0)], total: 9, page: 3, per_page: 2 }, "does not match the requested page"],
        ["over-full page", { items: [sub(0), sub(1), sub(2)], total: 9, page: 1, per_page: 2 }, "more entries than `per_page`"],
      ];
      for (const [label, page, detail] of bad) {
        const { pw } = harness(() => json(page));
        const it = pw.subscribers.listAll();
        const e = (await rejectsWith(it.next(), isPagination("malformed_page"), label)) as PaginationError;
        assert.ok(e.message.includes(detail), `${label}: ${e.message}`);
        assert.equal(e.items, 0);
        assert.equal(it.progress.stopReason, "malformed_page");
        assert.equal(it.progress.complete, false);
        assert.deepEqual(await it.next(), { done: true, value: undefined });
      }
    },
  },
  {
    name: "an empty 200 body or 204 is a malformed page, after earlier pages were delivered",
    async run() {
      for (const status of [200, 204]) {
        const { pw } = harness((url) =>
          url.searchParams.get("cursor") === null
            ? json({ webhooks: [{ id: "w1" }], next_cursor: "c1" })
            : new Response(null, { status }),
        );
        const it = pw.webhooks.listAll();
        assert.equal((await it.next()).value?.id, "w1");
        const e = (await rejectsWith(it.next(), isPagination("malformed_page"), `status ${status}`)) as PaginationError;
        assert.equal(e.pages, 1);
        assert.equal(e.items, 1);
      }
    },
  },
  /* ---- repeated continuation ---- */
  {
    name: "a repeated cursor (immediate, cycle, or the resume cursor) is rejected",
    async run() {
      const scenarios: Array<[string, (cursor: string | null) => string | null, string | undefined, number]> = [
        ["same cursor again", (c) => (c === null ? "A" : "A"), undefined, 1],
        ["A -> B -> A cycle", (c) => (c === null ? "A" : c === "A" ? "B" : "A"), undefined, 2],
        ["returns the resume cursor", () => "start", "start", 0],
      ];
      for (const [label, next, start, goodPages] of scenarios) {
        const { pw, calls } = harness((url) => {
          const cursor = url.searchParams.get("cursor");
          return json({ items: [{ id: `row_${calls.length}` }], next_cursor: next(cursor) });
        });
        const it = pw.audit.queryAll(start ? { cursor: start } : {});
        const e = (await rejectsWith(drain(it), isPagination("repeated_continuation"), label)) as PaginationError;
        // The page carrying the repeated continuation is rejected whole.
        assert.equal(e.items, goodPages, label);
        assert.equal(calls.length, goodPages + 1, label);
      }
    },
  },
  {
    name: "an offset server that ignores ?page is caught as a repeated continuation",
    async run() {
      const { pw, calls } = harness(() =>
        json({ list_id: "l", items: [sub(0), sub(1)], total: 10, page: 1, per_page: 2 }),
      );
      const it = pw.lists.membersAll("l", { per_page: 2 });
      await rejectsWith(drain(it), isPagination("repeated_continuation"), "stuck offset");
      assert.equal(calls.length, 2);
      assert.equal(it.progress.items, 2);
    },
  },
  /* ---- limits ---- */
  {
    name: "maxPages stops an unfinished export explicitly, only when more is demanded",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [2, 2, 2, 2]));
      const it = pw.audit.queryAll({}, { maxPages: 2 });
      const got: string[] = [];
      const e = (await rejectsWith(
        (async () => { for await (const row of it) got.push(row.id); })(),
        isPagination("max_pages"),
        "guard",
      )) as PaginationError;
      assert.equal(got.length, 4, "both allowed pages are delivered in full");
      assert.equal(calls.length, 2, "no request beyond the guard");
      assert.equal(e.limit, 2);
      assert.equal(e.pages, 2);
      assert.equal(e.items, 4);
      assert.match(e.message, /incomplete/);
      assert.deepEqual(it.progress, { pages: 2, items: 4, done: true, complete: false, stopReason: "max_pages" });
    },
  },
  {
    name: "a collection that ends exactly at maxPages completes normally",
    async run() {
      const { pw } = harness((url) => cursorPage(url, "items", [2, 2]));
      const it = pw.audit.queryPages({}, { maxPages: 2 });
      assert.equal((await drain(it)).length, 2);
      assert.equal(it.progress.complete, true);
    },
  },
  {
    name: "the default page guard is finite (1000)",
    async run() {
      let n = 0;
      // Past 1000 requests the mock fails, so a missing guard shows up as a
      // ServerError instead of an endless loop.
      const { pw, calls } = harness(() =>
        ++n > 1000
          ? json({ error: { code: "guard_missing", message: "no guard" } }, 500)
          : json({ items: [], next_cursor: `fresh-${n}` }),
      );
      const e = (await rejectsWith(drain(pw.audit.queryAll()), isPagination("max_pages"), "default")) as PaginationError;
      assert.equal(e.limit, 1000);
      assert.equal(calls.length, 1000);
    },
  },
  {
    name: "maxItems ends normally mid-page and reports an incomplete result",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [3, 3]));
      const it = pw.audit.queryAll({}, { maxItems: 2 });
      assert.equal((await drain(it)).length, 2);
      assert.equal(calls.length, 1);
      assert.deepEqual(it.progress, { pages: 1, items: 2, done: true, complete: false, stopReason: "max_items" });
    },
  },
  {
    name: "maxItems at a page boundary does not request the next page",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [3, 3]));
      const it = pw.audit.queryAll({}, { maxItems: 3 });
      assert.equal((await drain(it)).length, 3);
      assert.equal(calls.length, 1);
      assert.equal(it.progress.stopReason, "max_items");
      assert.equal(it.progress.complete, false, "more data was reported");
    },
  },
  {
    name: "maxItems that coincides with the end reports a complete result",
    async run() {
      const { pw } = harness((url) => cursorPage(url, "items", [2, 1]));
      const it = pw.audit.queryAll({}, { maxItems: 3 });
      assert.equal((await drain(it)).length, 3);
      assert.deepEqual(it.progress, { pages: 2, items: 3, done: true, complete: true, stopReason: "end" });
    },
  },
  {
    name: "invalid options and parameters throw synchronously and send nothing",
    async run() {
      const { pw, calls } = harness(() => json({}));
      const bad: Array<[string, () => unknown]> = [
        ["maxPages Infinity", () => pw.audit.queryAll({}, { maxPages: Infinity })],
        ["maxPages 0", () => pw.audit.queryAll({}, { maxPages: 0 })],
        ["maxPages fractional", () => pw.audit.queryAll({}, { maxPages: 1.5 })],
        ["maxPages NaN", () => pw.audit.queryPages({}, { maxPages: NaN })],
        ["maxItems 0", () => pw.audit.queryAll({}, { maxItems: 0 })],
        ["maxItems on pages", () => pw.audit.queryPages({}, { maxItems: 1 } as never)],
        ["timeBudgetMs negative", () => pw.audit.queryAll({}, { timeBudgetMs: -1 })],
        ["timeBudgetMs NaN", () => pw.audit.queryAll({}, { timeBudgetMs: NaN })],
        ["timeBudgetMs Infinity", () => pw.audit.queryAll({}, { timeBudgetMs: Infinity })],
        ["signal not a signal", () => pw.audit.queryAll({}, { signal: {} as AbortSignal })],
        ["per_page over contract max", () => pw.subscribers.listAll({ per_page: 201 })],
        ["per_page 0", () => pw.lists.membersAll("l", { per_page: 0 })],
        ["page 0", () => pw.subscribers.listPages({ page: 0 })],
        ["empty cursor", () => pw.webhooks.listAll({ cursor: "" })],
        ["limit 0", () => pw.webhooks.deliveriesAll("wh", { limit: 0 })],
        ["empty list id", () => pw.lists.membersAll("  ")],
        ["empty webhook id", () => pw.webhooks.deliveriesPages(" ")],
      ];
      for (const [label, make] of bad) assert.throws(make, Error, label);
      assert.equal(calls.length, 0);
    },
  },
  /* ---- request failures ---- */
  {
    name: "a failed page request propagates its own typed error unchanged",
    async run() {
      const { pw } = harness((url) =>
        url.searchParams.get("cursor") === null
          ? json({ items: [{ id: "r1" }], next_cursor: "c1" })
          : json({ error: { code: "boom", message: "upstream" } }, 500),
      );
      const it = pw.audit.queryAll();
      await it.next();
      await rejectsWith(it.next(), (e) => e instanceof ServerError && !(e instanceof PaginationError), "5xx");
      assert.deepEqual(it.progress, { pages: 1, items: 1, done: true, complete: false, stopReason: "request_failed" });
    },
  },
  /* ---- cancellation ---- */
  {
    name: "an already-aborted signal rejects the first next() without a request",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [1]));
      const ac = new AbortController();
      const reason = new Error("stop");
      ac.abort(reason);
      const it = pw.audit.queryAll({}, { signal: ac.signal });
      const e = await rejectsWith(it.next(), (x) => x instanceof RequestAbortedError, "pre-aborted");
      assert.equal((e as RequestAbortedError).payload, reason);
      assert.equal(calls.length, 0);
      assert.equal(it.progress.stopReason, "cancelled");
    },
  },
  {
    name: "abort during a stalled page request rejects promptly (transport ignores its signal)",
    async run() {
      const { pw } = harness(() => new Promise<Response>(() => undefined));
      const ac = new AbortController();
      const it = pw.subscribers.listPages({}, { signal: ac.signal });
      const started = performance.now();
      setTimeout(() => ac.abort("user"), 30);
      await rejectsWith(it.next(), (e) => e instanceof RequestAbortedError && e.payload === "user", "stall");
      assert.ok(performance.now() - started < 5_000);
    },
  },
  {
    name: "abort while the consumer is paused: buffered items are not delivered",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [3]));
      const ac = new AbortController();
      const it = pw.audit.queryAll({}, { signal: ac.signal });
      assert.equal((await it.next()).done, false);
      ac.abort();
      await rejectsWith(it.next(), (e) => e instanceof RequestAbortedError, "paused");
      assert.deepEqual(await it.next(), { done: true, value: undefined });
      assert.equal(calls.length, 1);
      assert.equal(it.progress.items, 1);
    },
  },
  {
    name: "no listener or resource stays on the caller's signal between pages or after",
    async run() {
      const { pw } = harness((url) => cursorPage(url, "items", [2, 2]));
      const ac = new AbortController();
      const live = countAbortListeners(ac.signal);
      const it = pw.audit.queryAll({}, { signal: ac.signal, timeBudgetMs: 60_000 });
      await it.next();
      assert.equal(live(), 0, "nothing armed while the consumer holds control");
      await drain(it);
      assert.equal(live(), 0);
      // A later abort changes nothing for a finished iteration.
      ac.abort();
      assert.equal(it.progress.stopReason, "end");
    },
  },
  /* ---- time budget ---- */
  {
    name: "the time budget starts at the first next(), not at creation",
    async run() {
      const { pw } = harness((url) => cursorPage(url, "items", [1, 1]));
      await withClockOffset(async (advance) => {
        const it = pw.audit.queryAll({}, { timeBudgetMs: LONG_BUDGET_MS });
        advance(2 * LONG_BUDGET_MS); // two whole budgets pass before iteration begins
        assert.equal((await drain(it)).length, 2);
        assert.equal(it.progress.complete, true);
      });
    },
  },
  {
    name: "consumer pauses count against the budget, even with items buffered",
    async run() {
      const { pw, calls } = harness((url) => cursorPage(url, "items", [3]));
      await withClockOffset(async (advance) => {
        const it = pw.audit.queryAll({}, { timeBudgetMs: LONG_BUDGET_MS });
        assert.equal((await it.next()).done, false);
        advance(LONG_BUDGET_MS); // the consumer's own work takes the whole budget
        const e = (await rejectsWith(it.next(), isPagination("time_budget"), "pause")) as PaginationError;
        assert.equal(e.limit, LONG_BUDGET_MS);
        assert.equal(e.items, 1);
        assert.equal(calls.length, 1);
        assert.deepEqual(it.progress, { pages: 1, items: 1, done: true, complete: false, stopReason: "time_budget" });
      });
    },
  },
  {
    name: "the budget bounds a stalled page request",
    async run() {
      const { pw } = harness(() => new Promise<Response>(() => undefined));
      const it = pw.webhooks.listPages({}, { timeBudgetMs: 80 });
      const started = performance.now();
      await rejectsWith(it.next(), isPagination("time_budget"), "stall");
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 75, `not before the budget (${elapsed}ms)`);
      assert.ok(elapsed < 5_000, `promptly at the budget (${elapsed}ms)`);
    },
  },
  {
    name: "retry backoff waits count against the budget",
    async run() {
      const { pw, calls } = harness(
        () => json({ error: { code: "busy", message: "busy" } }, 503, { "retry-after": "5" }),
        { retries: 3 },
      );
      const it = pw.audit.queryAll({}, { timeBudgetMs: 150 });
      const started = performance.now();
      await rejectsWith(it.next(), isPagination("time_budget"), "backoff");
      assert.ok(performance.now() - started < 4_000, "did not sit out the 5 s Retry-After");
      assert.equal(calls.length, 1);
    },
  },
  /* ---- diagnostics ---- */
  {
    name: "pagination diagnostics carry no cursor, filter, id or row values",
    async run() {
      const secretCursor = "CURSOR-ENCODES-" + fixtureEmail("last-seen");
      const query = fixtureEmail("filter-term");
      const { pw } = harness((url) =>
        url.searchParams.get("cursor") === null
          ? json({ list_id: "l", items: [sub(0)], total: 3, page: 1, per_page: 1, next_cursor: secretCursor })
          : json({ items: [sub(1)], total: 3, page: 1, per_page: 1, next_cursor: 12 }),
      );
      const errors: PaginationError[] = [];
      try {
        await drain(pw.subscribers.listAll({ q: query, per_page: 1 }));
      } catch (e) {
        errors.push(e as PaginationError);
      }
      const { pw: pw2 } = harness(() => json({ items: [], next_cursor: secretCursor }));
      try {
        await drain(pw2.audit.queryAll({ actor_label: query, cursor: secretCursor }));
      } catch (e) {
        errors.push(e as PaginationError);
      }
      assert.equal(errors.length, 2);
      for (const e of errors) {
        assert.ok(e instanceof PaginationError);
        assert.equal(e.payload, undefined);
        const text = [e.message, String(e.stack), JSON.stringify({ ...e })].join("\n");
        for (const secret of [secretCursor, query, "sub_0", "sub_1", "reader0", "example.com"]) {
          assert.ok(!text.includes(secret), `diagnostic leaked ${secret.slice(0, 6)}...`);
        }
      }
    },
  },
  /* ---- the page hand-off window: one delivery rule for pages and items ---- */
  {
    name: "hand-off window: an abort after a page is accepted rejects page AND item iterators alike",
    async run() {
      for (const mode of ["pages", "items"] as const) {
        for (const trapPage of [1, 2]) {
          const label = `${mode}, page ${trapPage}`;
          const ac = new AbortController();
          const reason = new Error("stop");
          const spec = handoffSpec(trapPage, () => ac.abort(reason));
          const it =
            mode === "pages"
              ? iteratePages<{ items: unknown[] }>(spec, { signal: ac.signal })
              : iterateItems<{ id: string }>(spec, { signal: ac.signal });
          const delivered: unknown[] = [];
          const e = await rejectsWith(
            (async () => { for await (const x of it as AsyncIterable<unknown>) delivered.push(x); })(),
            (x) => x instanceof RequestAbortedError && x.payload === reason,
            label,
          );
          assert.ok(e instanceof RequestAbortedError);
          // Only what precedes the trapped page went out; the accepted page did not.
          const before = trapPage - 1;
          assert.equal(delivered.length, mode === "pages" ? before : 2 * before, label);
          assert.deepEqual(
            it.progress,
            { pages: before, items: 2 * before, done: true, complete: false, stopReason: "cancelled" },
            label,
          );
          assert.deepEqual(await it.next(), { done: true, value: undefined }, label);
        }
      }
    },
  },
  {
    name: "hand-off window: a budget that passes after a page is accepted rejects page AND item iterators alike",
    async run() {
      for (const mode of ["pages", "items"] as const) {
        for (const trapPage of [1, 2]) {
          const label = `${mode}, page ${trapPage}`;
          // The trapped microtask moves the clock exactly to the deadline, as
          // a blocked loop would; no timer can fire, so only the clock check
          // at delivery can notice.
          const delivered: unknown[] = [];
          const e = (await withClockOffset(async (advance) => {
            const spec = handoffSpec(trapPage, () => advance(LONG_BUDGET_MS));
            const options = { timeBudgetMs: LONG_BUDGET_MS };
            const it =
              mode === "pages"
                ? iteratePages<{ items: unknown[] }>(spec, options)
                : iterateItems<{ id: string }>(spec, options);
            const err = await rejectsWith(
              (async () => { for await (const x of it as AsyncIterable<unknown>) delivered.push(x); })(),
              isPagination("time_budget"),
              label,
            );
            assert.equal(it.progress.stopReason, "time_budget", label);
            return err;
          })) as PaginationError;
          const before = trapPage - 1;
          assert.equal(delivered.length, mode === "pages" ? before : 2 * before, label);
          assert.equal(e.pages, before, label);
          assert.equal(e.items, 2 * before, label);
        }
      }
    },
  },
  {
    name: "hand-off window: an empty page accepted before an abort is rejected identically by both iterators",
    async run() {
      for (const mode of ["pages", "items"] as const) {
        const ac = new AbortController();
        const spec = handoffSpec(2, () => ac.abort(), true);
        const it =
          mode === "pages"
            ? iteratePages<{ items: unknown[] }>(spec, { signal: ac.signal })
            : iterateItems<{ id: string }>(spec, { signal: ac.signal });
        await rejectsWith(drain(it as AsyncIterable<unknown>), (e) => e instanceof RequestAbortedError, mode);
        // Page 1 went out; the empty page 2 did not pass the gate in either mode.
        assert.deepEqual(
          it.progress,
          { pages: 1, items: 2, done: true, complete: false, stopReason: "cancelled" },
          mode,
        );
      }
    },
  },
  {
    name: "hand-off window control: with no abort and no budget, every page is delivered",
    async run() {
      let trapped = 0;
      const pages = await drain(iteratePages<{ items: unknown[] }>(handoffSpec(2, () => void trapped++)));
      const items = await drain(iterateItems<{ id: string }>(handoffSpec(2, () => void trapped++)));
      assert.equal(trapped, 2, "the trap ran in both runs");
      assert.equal(pages.length, 3);
      assert.deepEqual(items.map((x) => x.id), ["p1a", "p1b", "p2a", "p2b", "p3a", "p3b"]);
    },
  },
  /* ---- numbered-page metadata: conservative completion ---- */
  {
    name: "genuinely empty collections stay complete (subscribers and list members)",
    async run() {
      const { pw, calls } = harness((url) =>
        url.pathname.startsWith("/api/v1/lists/")
          ? json({ list_id: "l", items: [], total: 0, page: 1, per_page: 25 })
          : json({ items: [], total: 0, page: 1, per_page: 50 }),
      );
      for (const it of [pw.subscribers.listAll(), pw.lists.membersPages("l")] as const) {
        await drain(it as AsyncIterable<unknown>);
        assert.deepEqual(it.progress, { pages: 1, items: 0, done: true, complete: true, stopReason: "end" });
        assert.equal("conflicts" in it.progress, false);
      }
      assert.equal(calls.length, 2);
    },
  },
  {
    name: "a consistent multi-page offset walk is complete with no conflicts reported",
    async run() {
      const { pw } = harness((url) => offsetPage(url, 6, 2, { list_id: "l" }));
      const it = pw.lists.membersAll("l", { per_page: 2 });
      assert.equal((await drain(it)).length, 6);
      assert.deepEqual(it.progress, { pages: 3, items: 6, done: true, complete: true, stopReason: "end" });
    },
  },
  {
    name: "metadata conflicts withhold completion, each explicitly named, without extra requests",
    async run() {
      // [label, pages by number, expected conflicts, expected rows, expected requests]
      type P = { n: number; total: number; per_page?: number };
      const scenarios: Array<[string, P[], string[], number, number]> = [
        ["empty first page, total > 0", [{ n: 0, total: 4 }], ["empty_before_total"], 0, 1],
        ["total shrinks mid-walk", [{ n: 2, total: 6 }, { n: 2, total: 5 }, { n: 1, total: 5 }], ["total_changed"], 5, 3],
        ["total grows past a full last page", [{ n: 2, total: 3 }, { n: 2, total: 3 }], ["rows_beyond_total"], 4, 2],
        ["short page before total", [{ n: 1, total: 4 }, { n: 2, total: 4 }], ["short_page_before_total"], 3, 2],
        ["per_page changes", [{ n: 2, total: 5 }, { n: 3, total: 5, per_page: 3 }], ["per_page_changed", "rows_beyond_total"], 5, 2],
      ];
      for (const [label, pages, conflicts, rows, requests] of scenarios) {
        const { pw, calls } = harness((url) => {
          const pageNo = Number(url.searchParams.get("page"));
          const p = pages[pageNo - 1] ?? { n: 0, total: pages.at(-1)!.total };
          return json({
            list_id: "l",
            items: Array.from({ length: p.n }, (_, k) => sub(pageNo * 10 + k)),
            total: p.total,
            page: pageNo,
            per_page: p.per_page ?? 2,
          });
        });
        const it = pw.lists.membersAll("l", { per_page: 2 });
        assert.equal((await drain(it)).length, rows, label);
        assert.equal(calls.length, requests, label);
        assert.deepEqual(
          it.progress,
          { pages: requests, items: rows, done: true, complete: false, stopReason: "metadata_conflict", conflicts },
          label,
        );
      }
    },
  },
  {
    name: "page iterators report metadata conflicts the same way",
    async run() {
      const { pw } = harness((url) => {
        const page = Number(url.searchParams.get("page"));
        return json({ items: page === 1 ? [sub(0), sub(1)] : [], total: 9, page, per_page: 2 });
      });
      const it = pw.subscribers.listPages({ per_page: 2 });
      assert.equal((await drain(it)).length, 2);
      assert.equal(it.progress.stopReason, "metadata_conflict");
      assert.equal(it.progress.complete, false);
      assert.deepEqual(it.progress.conflicts, ["empty_before_total"]);
    },
  },
  {
    name: "maxItems at the end after a conflict reports metadata_conflict, not end",
    async run() {
      const { pw } = harness((url) => {
        const page = Number(url.searchParams.get("page"));
        return json({ list_id: "l", items: [sub(page)], total: 4, page, per_page: 2 });
      });
      const it = pw.lists.membersAll("l", { per_page: 2 }, { maxItems: 1 });
      assert.equal((await drain(it)).length, 1);
      assert.deepEqual(it.progress.conflicts, ["short_page_before_total"]);
      // The cap was hit with a next page still pending: max_items wins.
      assert.equal(it.progress.stopReason, "max_items");
      const { pw: pw2 } = harness(() => json({ list_id: "l", items: [sub(0)], total: 0, page: 1, per_page: 2 }));
      const it2 = pw2.lists.membersAll("l", {}, { maxItems: 1 });
      await drain(it2);
      assert.deepEqual(it2.progress, {
        pages: 1, items: 1, done: true, complete: false, stopReason: "metadata_conflict", conflicts: ["rows_beyond_total"],
      });
    },
  },
  {
    name: "conflicts from the offset phase survive a switch to the keyset cursor",
    async run() {
      const { pw } = harness((url) =>
        url.searchParams.get("cursor") === null
          ? json({ items: [sub(0)], total: 5, page: 1, per_page: 2, next_cursor: "k1" })
          : json({ items: [sub(1)], total: 3, page: 1, per_page: 2 }),
      );
      const it = pw.subscribers.listAll({ per_page: 2 });
      assert.equal((await drain(it)).length, 2);
      // The offset page was short of its total; the cursor page is not checked.
      assert.deepEqual(it.progress.conflicts, ["short_page_before_total"]);
      assert.equal(it.progress.stopReason, "metadata_conflict");
    },
  },
  {
    name: "cursor pages are not checked: a changing total there does not affect completion",
    async run() {
      const { pw } = harness((url) => {
        const cursor = url.searchParams.get("cursor");
        return cursor === "resume"
          ? json({ items: [sub(0)], total: 50, page: 1, per_page: 2, next_cursor: "k1" })
          : json({ items: [sub(1), sub(2)], total: 7, page: 1, per_page: 2 });
      });
      // Starting from a resume cursor, every page is a cursor page.
      const it = pw.subscribers.listAll({ cursor: "resume" });
      await drain(it);
      assert.deepEqual(it.progress, { pages: 2, items: 3, done: true, complete: true, stopReason: "end" });
    },
  },
  {
    name: "a resume page past the end is an empty, complete result, not a conflict",
    async run() {
      const { pw } = harness((url) => offsetPage(url, 4, 2, { list_id: "l" }));
      const it = pw.lists.membersAll("l", { page: 9, per_page: 2 });
      assert.deepEqual(await drain(it), []);
      assert.deepEqual(it.progress, { pages: 1, items: 0, done: true, complete: true, stopReason: "end" });
    },
  },
  {
    name: "a failure after a conflict keeps its own reason and still lists the conflict",
    async run() {
      const { pw } = harness((url) => {
        const page = Number(url.searchParams.get("page"));
        return json({ list_id: "l", items: [sub(page), sub(page + 1)], total: 10 - page, page, per_page: 2 });
      });
      const it = pw.lists.membersAll("l", { per_page: 2 }, { maxPages: 2 });
      await rejectsWith(drain(it), isPagination("max_pages"), "guard after conflict");
      assert.deepEqual(it.progress, {
        pages: 2, items: 4, done: true, complete: false, stopReason: "max_pages", conflicts: ["total_changed"],
      });
    },
  },
  /* ---- single-page APIs unchanged ---- */
  {
    name: "single-page methods keep their exact requests and results",
    async run() {
      const { pw, calls } = harness((url) => {
        if (url.pathname.endsWith("/deliveries")) return json({ deliveries: [{ id: "d1" }], next_cursor: "n" });
        if (url.pathname.startsWith("/api/v1/lists/")) return json({ list_id: "l", items: [], total: 0, page: 1, per_page: 25 });
        return json({ items: [], total: 0, page: 1, per_page: 50 });
      });
      await pw.subscribers.list();
      await pw.subscribers.list({ q: "x", cursor: "c" });
      await pw.lists.members(42);
      assert.deepEqual(await pw.webhooks.deliveries("wh"), [{ id: "d1" }]);
      await pw.audit.query({ since: "2026-01-01" });
      assert.deepEqual(calls.map((u) => u.pathname + u.search), [
        "/api/v1/subscribers",
        "/api/v1/subscribers?q=x&cursor=c",
        "/api/v1/lists/42/subscribers",
        "/api/v1/outbound-webhooks/wh/deliveries",
        "/api/v1/audit?since=2026-01-01",
      ]);
      assert.throws(() => pw.lists.members("  "), /List ID is required/);
    },
  },
];

