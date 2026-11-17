/**
 * Retry and recovery under pagination, through the PUBLIC resource methods.
 * Shared by both runners (vitest: tests/pagination.test.ts; dependency-free:
 * tests/offline/pagination.offline.ts). Node built-ins and SDK source only.
 *
 * Retries live in the client: each page is one `request()`, which retries
 * 429, 5xx (not 501), transport failures, failed body reads and per-attempt
 * timeouts. These cases inject such failures into the first N ATTEMPTS at an
 * exact page URL on the catalog mock, then hold every traversal to its solo
 * no-failure baseline (see pagination-concurrency-cases.ts):
 *
 * - recovery: the same ids and progress as the baseline, and the same request
 *   sequence with ONLY the failing page's URL repeated back to back, once per
 *   attempt. That shows the same page was retried, with nothing skipped,
 *   re-read or duplicated;
 * - exhaustion: the last attempt's own error (never a PaginationError), and
 *   progress equal to the delivered prefix of the baseline, nothing more.
 *
 * Network errors, failed body reads and attempt timeouts back off
 * `250 * 2^attempt` ms plus jitter; `withNoJitter` pins the jitter to zero.
 * 503/429 carry `Retry-After: 0` unless a case needs a long backoff.
 */
import assert from "node:assert/strict";

import {
  AuditResource,
  ListsResource,
  NetworkError,
  PaginationError,
  PostwaveError,
  RateLimitError,
  RequestAbortedError,
  ServerError,
  SubscribersResource,
  TimeoutError,
  WebhooksResource,
} from "../src/index.js";
import type { PageIterationOptions } from "../src/index.js";
import {
  LONG_BUDGET_MS,
  withClockOffset,
  type PaginationCase,
} from "./pagination-cases.js";
import {
  FLEET,
  TRANSIENT_KINDS,
  assertUnaffected,
  baselines,
  catalogServer,
  deferred,
  errorName,
  outcome,
  start,
  type CatalogServer,
  type FleetMember,
  type Injection,
  type Outcome,
  type Runner,
  type TruncationRecord,
  type Transient,
} from "./pagination-concurrency-cases.js";

/* ----------------------------------------------------------------- helpers */

const byKey = (key: string) => FLEET.find((m) => m.key === key)!;
const AUDIT_ITEMS = byKey("audit:create"); // queryAll, 7 rows, 4 cursor pages
const HOOK_PAGES = byKey("hooks:staging"); // listPages, 6 rows, 3 cursor pages
const MEMBER_ITEMS = byKey("members:L1:enabled"); // membersAll, 5 rows, 3 offset pages
const HYBRID_ITEMS = byKey("subs:alpha"); // listAll, offset page 1 then cursor

/** Drop the client's 304 cache-bust parameter so a refetch reads as its page. */
const bare = (target: string) => target.replace(/([?&])_cb=[^&]*(&|$)/, (_m, a: string, b: string) => (b ? a : ""));

/** The requests one traversal sent, cache-bust parameter removed. */
function sentBy(server: CatalogServer, member: FleetMember): string[] {
  return server.requestsFor(member.key).map(bare);
}

/** Baseline requests with each injected page repeated once per extra attempt. */
function withRetries(requests: string[], inject: Map<string, Injection>): string[] {
  return requests.flatMap((t) => Array<string>(Math.min(inject.get(t)?.failures ?? 0, 99) + 1).fill(t));
}

/** Transient failures on the given pages (1-based) of a baseline's requests. */
function failPages(
  base: Outcome,
  pages: number[],
  injection: Omit<Injection, "failures"> & { failures?: number },
): Map<string, Injection> {
  return new Map(
    pages.map((n) => {
      const target = base.requests[n - 1];
      assert.ok(target, `baseline has a page ${n}`);
      return [target, { failures: 1, ...injection }];
    }),
  );
}

/** Pin backoff jitter so retry waits are exactly 250, 500, ... ms. */
async function withNoJitter<T>(fn: () => Promise<T>): Promise<T> {
  const real = Math.random;
  Math.random = () => 0;
  try {
    return await fn();
  } finally {
    Math.random = real;
  }
}

async function solo(
  member: FleetMember,
  server: Parameters<typeof catalogServer>[0],
  options: PageIterationOptions = {},
): Promise<{ r: Runner; server: CatalogServer }> {
  const s = catalogServer(server);
  const r = start(member, s.pw, options);
  await r.done;
  return { r, server: s };
}

/** Recovery: baseline ids and progress; requests = baseline + retried pages. */
function assertRecovered(
  r: Runner,
  server: CatalogServer,
  base: Outcome,
  inject: Map<string, Injection>,
  label: string,
): void {
  assert.equal(errorName(r.error), undefined, `${label}: no error`);
  assert.deepEqual(r.ids, base.ids, `${label}: ids (no skip, no duplicate)`);
  assert.deepEqual({ ...r.it.progress }, base.progress, `${label}: progress`);
  assert.deepEqual(sentBy(server, r.member), withRetries(base.requests, inject), `${label}: requests`);
}

/**
 * Exhaustion: the delivered prefix of the baseline, and nothing after. Every
 * catalog page holds 2 rows (per_page/limit 2, or the mock's default).
 */
function assertPartial(r: Runner, base: Outcome, pagesDone: number, label: string): void {
  const items = Math.min(base.ids.length, pagesDone * 2);
  assert.deepEqual(r.ids, base.ids.slice(0, items), `${label}: delivered prefix`);
  assert.deepEqual(
    { ...r.it.progress },
    { pages: pagesDone, items, done: true, complete: false, stopReason: "request_failed" },
    `${label}: progress`,
  );
}

/**
 * Proof that a truncated attempt really delivered data before failing:
 *  - the SDK's reader received every byte of the prefix (more than zero), in
 *    more than one chunk, and then its next read rejected;
 *  - the prefix holds at least one COMPLETE real row of that page;
 *  - each such row reached the consumer exactly once if the page later
 *    recovered (`recovered`), or never if the traversal failed there.
 * Returns the ids of the complete rows found in the prefix.
 */
function assertTruncationEvidence(
  record: TruncationRecord,
  delivered: string[],
  recovered: boolean,
  label: string,
): string[] {
  const bytes = new TextEncoder().encode(record.prefix).byteLength;
  assert.ok(bytes > 0, `${label}: a non-empty prefix was sent`);
  assert.ok(record.chunksRead.length >= 2, `${label}: the reader received ${record.chunksRead.length} chunk(s)`);
  assert.equal(record.chunksRead.reduce((a, b) => a + b, 0), bytes, `${label}: every prefix byte reached the reader`);
  assert.equal(record.failedAfterData, true, `${label}: the read after the data failed`);
  assert.throws(() => JSON.parse(record.prefix), SyntaxError, `${label}: the prefix alone is not a page`);
  const complete = [...record.prefix.matchAll(/\{"id":"([^"]+)"\}/g)].map((m) => m[1]!);
  assert.ok(complete.length >= 1, `${label}: the prefix holds a complete real row`);
  for (const id of complete) {
    const n = delivered.filter((x) => x === id).length;
    assert.equal(n, recovered ? 1 : 0, `${label}: row ${id} delivered ${n} time(s)`);
  }
  return complete;
}

/** The error each transient kind surfaces once the client stops retrying. */
const EXHAUSTED: Record<Transient, { check: (e: unknown) => boolean; attempts: number }> = {
  "503": { check: (e) => e instanceof ServerError && e.status === 503, attempts: 3 },
  "429": { check: (e) => e instanceof RateLimitError && e.status === 429, attempts: 3 },
  network: { check: (e) => e instanceof NetworkError && !(e instanceof TimeoutError), attempts: 3 },
  truncated: { check: (e) => e instanceof NetworkError && !(e instanceof TimeoutError), attempts: 3 },
  stall: { check: (e) => e instanceof TimeoutError && e.scope === "attempt", attempts: 3 },
  // A 304 is not a retryable failure: the client refetches once with a
  // cache-busting parameter (the second request), then maps the second 304.
  "304": {
    check: (e) =>
      e instanceof PostwaveError && e.status === 304 && !(e instanceof ServerError) && !(e instanceof NetworkError),
    attempts: 2,
  },
};

/** The ten public iterator methods, discovered from the resource prototypes. */
function publicIteratorMethods(): string[] {
  const resources: Array<[string, object]> = [
    ["subscribers", SubscribersResource.prototype],
    ["lists", ListsResource.prototype],
    ["webhooks", WebhooksResource.prototype],
    ["audit", AuditResource.prototype],
  ];
  return resources.flatMap(([name, proto]) =>
    Object.getOwnPropertyNames(proto)
      .filter((m) => /(Pages|All)$/.test(m))
      .map((m) => `${name}.${m}`),
  );
}

/* ------------------------------------------------------------------- cases */

export const retryCases: PaginationCase[] = [
  /* ---- recovery: the same page, no skip, no duplicate ---- */
  {
    name: "retry: a transient 503 on any page of any iterator retries that page with no skip or duplicate",
    async run() {
      const base = await baselines();
      for (const member of FLEET) {
        const b = base.get(member.name)!;
        // First and second page each fail twice: covers an offset page, the
        // hybrid's switch page and its first cursor page, and cursor pages.
        const inject = failPages(b, [1, 2], { kind: "503", failures: 2 });
        const { r, server } = await solo(member, { retries: 3, inject });
        assertRecovered(r, server, b, inject, member.name);
      }
    },
  },
  {
    name: "retry matrix: every failure kind recovers on pages 1 and 2 of all ten public iterators",
    async run() {
      const base = await baselines();
      const covered = new Set<string>();
      await withNoJitter(async () => {
        for (const kind of TRANSIENT_KINDS) {
          // Each iterator on its own client, in parallel: independent runs.
          await Promise.all(
            FLEET.map(async (member) => {
              const label = `${kind} on ${member.name}`;
              const b = base.get(member.name)!;
              const inject = failPages(b, [1, 2], { kind });
              const { r, server } = await solo(member, { retries: 3, timeoutMs: 400, inject });
              assertRecovered(r, server, b, inject, label);
              if (kind === "truncated") {
                assert.equal(server.truncations.length, 2, `${label}: one truncated attempt per page`);
                for (const t of server.truncations) assertTruncationEvidence(t, r.ids, true, label);
              }
              covered.add(`${member.name}|${kind}`);
            }),
          );
        }
      });
      assert.equal(covered.size, FLEET.length * TRANSIENT_KINDS.length, "every iterator x kind pair asserted");
    },
  },
  /* ---- exhaustion: the right error and exact partial progress ---- */
  {
    name: "retry matrix: every failure kind, exhausted on page 2 of all ten public iterators, gives its own error and exact partial progress",
    async run() {
      const base = await baselines();
      const covered = new Set<string>();
      await withNoJitter(async () => {
        for (const kind of TRANSIENT_KINDS) {
          const expected = EXHAUSTED[kind];
          await Promise.all(
            FLEET.map(async (member) => {
              const label = `${kind} exhausted on ${member.name}`;
              const b = base.get(member.name)!;
              const target = b.requests[1]!;
              const inject = new Map([[target, { kind, failures: 1_000 }]]);
              const { r, server } = await solo(member, { retries: 2, timeoutMs: 400, inject });
              assert.ok(expected.check(r.error), `${label}: got ${errorName(r.error)}`);
              assert.ok(!(r.error instanceof PaginationError), `${label}: not re-labelled`);
              assert.deepEqual(
                sentBy(server, member),
                [b.requests[0], ...Array<string>(expected.attempts).fill(target)],
                `${label}: attempts, and nothing after the failing page`,
              );
              assertPartial(r, b, 1, label);
              if (kind === "truncated") {
                assert.equal(server.truncations.length, 3, `${label}: every attempt truncated`);
                // The complete rows each truncated attempt carried never leak.
                for (const t of server.truncations) assertTruncationEvidence(t, r.ids, false, label);
              }
              assert.deepEqual(await r.it.next(), { done: true, value: undefined }, label);
              covered.add(`${member.name}|${kind}`);
            }),
          );
        }
      });
      assert.equal(covered.size, FLEET.length * TRANSIENT_KINDS.length, "every iterator x kind pair asserted");
    },
  },
  {
    name: "retry: exhaustion on first and last pages (cursor, offset, hybrid switch page) keeps exact partial progress",
    async run() {
      const members = [AUDIT_ITEMS, HOOK_PAGES, MEMBER_ITEMS, HYBRID_ITEMS];
      const base = await baselines(members);
      // [traversal, failing page (1-based), failure kind, expected error]. The
      // page-2 position for every iterator and kind is the matrix above.
      const scenarios: Array<[FleetMember, number, Transient, (e: unknown) => boolean]> = [
        [AUDIT_ITEMS, 3, "503", EXHAUSTED["503"].check],
        [AUDIT_ITEMS, 4, "stall", EXHAUSTED.stall.check],
        [HOOK_PAGES, 3, "network", EXHAUSTED.network.check],
        [HOOK_PAGES, 1, "truncated", EXHAUSTED.truncated.check],
        // offset (numbered) pages: the continuation must not move past a failure
        [MEMBER_ITEMS, 3, "network", EXHAUSTED.network.check],
        [MEMBER_ITEMS, 1, "429", EXHAUSTED["429"].check],
        // the hybrid's offset first page (the page that offers the cursor)
        [HYBRID_ITEMS, 1, "503", EXHAUSTED["503"].check],
        [HYBRID_ITEMS, 3, "truncated", EXHAUSTED.truncated.check],
      ];
      await withNoJitter(() =>
        // Independent clients, run in parallel.
        Promise.all(scenarios.map(async ([member, page, kind, check]) => {
          const label = `${kind} at page ${page} of ${member.name}`;
          const b = base.get(member.name)!;
          const target = b.requests[page - 1]!; // this page never recovers
          const inject = new Map([[target, { kind, failures: 1_000 }]]);
          const { r, server } = await solo(member, { retries: 2, timeoutMs: 400, inject });
          assert.ok(check(r.error), `${label}: ${errorName(r.error)}`);
          assert.ok(!(r.error instanceof PaginationError), `${label}: not re-labelled`);
          // retries: 2 -> exactly 3 attempts at the failing page, nothing after it.
          assert.deepEqual(
            sentBy(server, member),
            [...b.requests.slice(0, page - 1), target, target, target],
            label,
          );
          assertPartial(r, b, page - 1, label);
          assert.deepEqual(await r.it.next(), { done: true, value: undefined }, label);
        })),
      );
    },
  },
  {
    name: "retry/truncation: data genuinely reaches the reader before the drop; recovery delivers each complete row once",
    async run() {
      // per_page 4 so each prefix carries SEVERAL complete rows. Item and page
      // iteration, offset pages and the hybrid's offset-then-cursor pages.
      const cases: Array<[string, (s: CatalogServer) => AsyncIterable<unknown>, (v: unknown) => string[]]> = [
        ["lists.membersAll (offset)", (sv) => sv.pw.lists.membersAll("L1", { status: "enabled", per_page: 4 }), (v) => [(v as { id: string }).id]],
        ["lists.membersPages (offset)", (sv) => sv.pw.lists.membersPages("L1", { status: "enabled", per_page: 4 }), (v) => (v as { items: Array<{ id: string }> }).items.map((x) => x.id)],
        ["subscribers.listAll (hybrid)", (sv) => sv.pw.subscribers.listAll({ q: "alpha", per_page: 4 }), (v) => [(v as { id: string }).id]],
        ["subscribers.listPages (hybrid)", (sv) => sv.pw.subscribers.listPages({ q: "alpha", per_page: 4 }), (v) => (v as { items: Array<{ id: string }> }).items.map((x) => x.id)],
      ];
      await withNoJitter(() =>
        // Independent clients, run in parallel.
        Promise.all(cases.map(async ([label, make, ids]) => {
          // Baseline: no failures.
          const clean = catalogServer();
          const want: string[] = [];
          for await (const v of make(clean)) want.push(...ids(v));
          const targets = clean.log.map((x) => x.target);
          assert.equal(targets.length, 2, `${label}: two pages`);
          // Every page truncated twice before it is answered.
          const inject = new Map(targets.map((t) => [t, { kind: "truncated" as const, failures: 2 }]));
          const server = catalogServer({ retries: 3, inject });
          const got: string[] = [];
          for await (const v of make(server)) got.push(...ids(v));
          assert.deepEqual(got, want, `${label}: exactly the complete rows, in order`);
          assert.equal(new Set(got).size, got.length, `${label}: no duplicates`);
          assert.equal(server.truncations.length, 4, `${label}: 2 pages x 2 truncated attempts`);
          const salvageable = server.truncations.flatMap((t) => assertTruncationEvidence(t, got, true, label));
          assert.ok(salvageable.length >= 4, `${label}: prefixes carried ${salvageable.length} complete rows`);
          assert.deepEqual(server.log.map((x) => x.target), targets.flatMap((t) => [t, t, t]), `${label}: same page re-requested`);
        })),
      );
      // Concurrent: one traversal's pages truncated on a shared client; the
      // other nine reproduce their baselines exactly.
      const base = await baselines();
      const victim = HYBRID_ITEMS;
      const b = base.get(victim.name)!;
      const inject = failPages(b, b.requests.map((_, i) => i + 1), { kind: "truncated" });
      await withNoJitter(async () => {
        const server = catalogServer({ retries: 3, inject });
        const runners = FLEET.map((m) => start(m, server.pw));
        await Promise.all(runners.map((r) => r.done));
        for (const r of runners) {
          if (r.member !== victim) assertUnaffected(r, server, base, "beside a truncated traversal");
          else {
            assertRecovered(r, server, b, inject, "truncated in a fleet");
            for (const t of server.truncations) assertTruncationEvidence(t, r.ids, true, "truncated in a fleet");
          }
        }
      });
    },
  },
  {
    name: "retry coverage guard: the matrices span every public iterator method and every failure kind",
    async run() {
      const methods = publicIteratorMethods().sort();
      assert.deepEqual(methods, [
        "audit.queryAll", "audit.queryPages",
        "lists.membersAll", "lists.membersPages",
        "subscribers.listAll", "subscribers.listPages",
        "webhooks.deliveriesAll", "webhooks.deliveriesPages",
        "webhooks.listAll", "webhooks.listPages",
      ]);
      // The fleet exercises each public iterator method exactly once.
      const fleetMethods = FLEET.map((m) => m.name.split(" ")[0]!).sort();
      assert.deepEqual(fleetMethods, methods, "FLEET covers every public iterator method once");
      assert.deepEqual([...TRANSIENT_KINDS].sort(), ["304", "429", "503", "network", "stall", "truncated"]);
      assert.deepEqual(Object.keys(EXHAUSTED).sort(), [...TRANSIENT_KINDS].sort());
    },
  },
  {
    name: "retry: after exhaustion, resuming from the last delivered page yields the rest with no gap or duplicate",
    async run() {
      const base = await baselines([HOOK_PAGES, MEMBER_ITEMS]);
      // Cursor collection, page iterator: resume from the last page's next_cursor.
      {
        const b = base.get(HOOK_PAGES.name)!;
        const inject = new Map([[b.requests[2]!, { kind: "503" as const, failures: 3 }]]);
        const server = catalogServer({ retries: 2, inject }); // 3 attempts: all fail
        const first = server.pw.webhooks.listPages({ query: "staging", limit: 2 });
        const got: string[] = [];
        let resumeCursor: string | null | undefined;
        await assert.rejects(
          (async () => {
            for await (const page of first) {
              got.push(...page.webhooks.map((w) => w.id));
              resumeCursor = page.next_cursor;
            }
          })(),
          (e: unknown) => e instanceof ServerError,
        );
        assert.equal(first.progress.stopReason, "request_failed");
        // The page recovers on its 4th attempt, i.e. the resumed iterator's first.
        const resumed = server.pw.webhooks.listAll({ query: "staging", limit: 2, cursor: resumeCursor! });
        for await (const w of resumed) got.push(w.id);
        assert.deepEqual(got, b.ids, "stitched export equals the baseline");
        assert.equal(resumed.progress.complete, true);
      }
      // Offset collection, item iterator: resume from the next page number.
      {
        const b = base.get(MEMBER_ITEMS.name)!;
        const inject = new Map([[b.requests[1]!, { kind: "503" as const, failures: 3 }]]);
        const server = catalogServer({ retries: 2, inject });
        const first = server.pw.lists.membersAll("L1", { status: "enabled", per_page: 2 });
        const got: string[] = [];
        await assert.rejects(
          (async () => {
            for await (const m of first) got.push(m.id);
          })(),
          (e: unknown) => e instanceof ServerError,
        );
        const resumeAt = first.progress.pages + 1;
        const resumed = server.pw.lists.membersAll("L1", { status: "enabled", per_page: 2, page: resumeAt });
        for await (const m of resumed) got.push(m.id);
        assert.deepEqual(got, b.ids);
        assert.equal(resumed.progress.complete, true);
      }
    },
  },
  /* ---- page limits count pages, not attempts ---- */
  {
    name: "retry: maxPages and maxItems count pages and items, never retry attempts",
    async run() {
      const base = await baselines([AUDIT_ITEMS, HOOK_PAGES]);
      const audit = base.get(AUDIT_ITEMS.name)!; // 4 pages
      const hooks = base.get(HOOK_PAGES.name)!; // 3 pages
      // (a) every page needs 3 attempts; the guard of 3 still allows 3 pages.
      {
        const inject = failPages(audit, [1, 2, 3, 4], { kind: "503", failures: 2 });
        const { r, server } = await solo(AUDIT_ITEMS, { retries: 3, inject }, { maxPages: 3 });
        assert.ok(r.error instanceof PaginationError && r.error.reason === "max_pages");
        assert.equal(r.error.limit, 3);
        assert.equal(r.error.pages, 3);
        assert.deepEqual(r.ids, audit.ids.slice(0, 6));
        assert.equal(server.log.length, 9, "9 attempts for 3 pages");
        assert.ok(!sentBy(server, AUDIT_ITEMS).includes(audit.requests[3]!), "page 4 never requested");
      }
      // (b) a collection of exactly maxPages pages completes despite retries.
      {
        const inject = failPages(hooks, [1, 2, 3], { kind: "503" });
        const { r, server } = await solo(HOOK_PAGES, { retries: 3, inject }, { maxPages: 3 });
        assertRecovered(r, server, hooks, inject, "exact guard");
        assert.equal(server.log.length, 6);
      }
      // (c) a page that exhausts its retries at the guard is request_failed.
      {
        const inject = new Map([[hooks.requests[2]!, { kind: "503" as const, failures: 1_000 }]]);
        const { r } = await solo(HOOK_PAGES, { retries: 1, inject }, { maxPages: 3 });
        assert.ok(r.error instanceof ServerError);
        assert.equal(r.it.progress.pages, 2);
      }
      // (d) maxItems is unaffected by retried pages.
      {
        const inject = failPages(audit, [1, 2], { kind: "503", failures: 2 });
        const s = catalogServer({ retries: 3, inject });
        const it = s.pw.audit.queryAll({ action: "create" }, { maxItems: 3 });
        const got: string[] = [];
        for await (const row of it) got.push(row.id);
        assert.deepEqual(got, audit.ids.slice(0, 3));
        assert.equal(it.progress.stopReason, "max_items");
        assert.equal(s.log.length, 6, "2 pages x 3 attempts, no third page");
      }
    },
  },
  /* ---- retries do not leak between concurrent traversals ---- */
  {
    name: "retry/concurrency: every traversal retrying at once still reproduces its own baseline",
    async run() {
      const base = await baselines();
      const inject = new Map<string, Injection>();
      for (const b of base.values()) for (const t of b.requests) inject.set(t, { kind: "503", failures: 1 });
      const server = catalogServer({ retries: 3, inject });
      const runners = FLEET.map((m) => start(m, server.pw));
      await Promise.all(runners.map((r) => r.done));
      for (const r of runners) assertRecovered(r, server, base.get(r.member.name)!, inject, `all retrying: ${r.member.name}`);
    },
  },
  {
    name: "retry/concurrency: one traversal retrying every page leaves all others exactly at baseline",
    async run() {
      const base = await baselines();
      for (const victim of FLEET) {
        const b = base.get(victim.name)!;
        const inject = failPages(b, b.requests.map((_, i) => i + 1), { kind: "503", failures: 2 });
        const server = catalogServer({ retries: 3, inject });
        const runners = FLEET.map((m) => start(m, server.pw));
        await Promise.all(runners.map((r) => r.done));
        for (const r of runners) {
          if (r.member === victim) assertRecovered(r, server, b, inject, `victim ${victim.name}`);
          else assertUnaffected(r, server, base, `beside retrying ${victim.name}`);
        }
      }
    },
  },
  {
    name: "retry/concurrency: one traversal exhausting its retries fails alone, with exact partial progress",
    async run() {
      const base = await baselines();
      const victim = AUDIT_ITEMS;
      const b = base.get(victim.name)!;
      const inject = new Map([[b.requests[1]!, { kind: "503" as const, failures: 1_000 }]]);
      const server = catalogServer({ retries: 3, inject });
      const runners = FLEET.map((m) => start(m, server.pw));
      await Promise.all(runners.map((r) => r.done));
      for (const r of runners) {
        if (r.member !== victim) {
          assertUnaffected(r, server, base, "beside an exhausted traversal");
          continue;
        }
        assert.ok(r.error instanceof ServerError);
        assert.deepEqual(sentBy(server, victim), [b.requests[0], ...Array(4).fill(b.requests[1])]);
        assertPartial(r, b, 1, "exhausted in a fleet");
      }
    },
  },
  {
    name: "retry/concurrency: the others finish while one traversal sits in a long Retry-After backoff",
    async run() {
      const base = await baselines();
      const victim = HOOK_PAGES;
      const b = base.get(victim.name)!;
      const inject = failPages(b, [2], { kind: "503", retryAfter: "1" });
      const server = catalogServer({ retries: 3, inject });
      const runners = FLEET.map((m) => start(m, server.pw));
      const v = runners.find((r) => r.member === victim)!;
      await Promise.all(runners.filter((r) => r !== v).map((r) => r.done));
      // Every other traversal is done; the victim has not retried yet.
      assert.equal(sentBy(server, victim).filter((t) => t === b.requests[1]).length, 1, "still backing off");
      await v.done;
      for (const r of runners) {
        if (r === v) assertRecovered(r, server, b, inject, "after backoff");
        else assertUnaffected(r, server, base, "during another's backoff");
      }
    },
  },
  /* ---- cancellation is unchanged by retries ---- */
  {
    name: "retry/cancel: an abort during a retry backoff ends only that traversal, at once, with no further attempt",
    async run() {
      const base = await baselines();
      const victim = MEMBER_ITEMS;
      const b = base.get(victim.name)!;
      const ac = new AbortController();
      const reason = new Error("cancel during backoff");
      const inject = failPages(b, [2], {
        kind: "503",
        failures: 1_000,
        retryAfter: "30", // a 30 s backoff the abort must cut short
        onAttempt: () => setTimeout(() => ac.abort(reason), 20),
      });
      const server = catalogServer({ retries: 3, inject });
      const started = performance.now();
      const runners = FLEET.map((m) => start(m, server.pw, m === victim ? { signal: ac.signal } : {}));
      await Promise.all(runners.map((r) => r.done));
      const v = runners.find((r) => r.member === victim)!;
      assert.ok(performance.now() - started < 10_000, "did not wait out the backoff");
      assert.ok(v.error instanceof RequestAbortedError && v.error.payload === reason);
      assert.deepEqual(sentBy(server, victim), [b.requests[0], b.requests[1]], "one attempt, no retry");
      assert.deepEqual({ ...v.it.progress }, { pages: 1, items: 2, done: true, complete: false, stopReason: "cancelled" });
      for (const r of runners) if (r !== v) assertUnaffected(r, server, base, "beside a cancelled backoff");
    },
  },
  {
    name: "retry/cancel: an abort while a failing attempt is answered sends no retry attempt",
    async run() {
      const base = await baselines([AUDIT_ITEMS]);
      const b = base.get(AUDIT_ITEMS.name)!;
      const ac = new AbortController();
      const inject = failPages(b, [3], { kind: "503", failures: 1_000, onAttempt: () => ac.abort("now") });
      const { r, server } = await solo(AUDIT_ITEMS, { retries: 3, inject }, { signal: ac.signal });
      assert.ok(r.error instanceof RequestAbortedError && r.error.payload === "now");
      assert.deepEqual(sentBy(server, AUDIT_ITEMS), b.requests.slice(0, 3));
      assert.deepEqual({ ...r.it.progress }, { pages: 2, items: 4, done: true, complete: false, stopReason: "cancelled" });
    },
  },
  /* ---- budgets are unchanged by retries ---- */
  {
    name: "retry/budget: once the traversal budget has passed, no retry attempt starts",
    async run() {
      const base = await baselines();
      const victim = AUDIT_ITEMS;
      const b = base.get(victim.name)!;
      await withClockOffset(async (advance) => {
        // The failing attempt at page 2 takes the whole budget (clock jump);
        // the retry, due at once (Retry-After: 0), must not be sent.
        const inject = failPages(b, [2], { kind: "503", failures: 1_000, onAttempt: () => advance(LONG_BUDGET_MS) });
        const server = catalogServer({ retries: 3, inject });
        const runners = FLEET.map((m) =>
          start(m, server.pw, { timeBudgetMs: m === victim ? LONG_BUDGET_MS : 10 * LONG_BUDGET_MS }),
        );
        await Promise.all(runners.map((r) => r.done));
        const v = runners.find((r) => r.member === victim)!;
        assert.ok(v.error instanceof PaginationError && v.error.reason === "time_budget");
        assert.deepEqual(sentBy(server, victim), [b.requests[0], b.requests[1]], "no retry after the budget");
        assert.deepEqual({ ...v.it.progress }, { pages: 1, items: 2, done: true, complete: false, stopReason: "time_budget" });
        for (const r of runners) if (r !== v) assertUnaffected(r, server, base, "beside an expired budget");
      });
    },
  },
  {
    name: "retry/budget: a traversal budget ends a long backoff promptly (real timer), others unaffected",
    async run() {
      const base = await baselines();
      const victim = HOOK_PAGES;
      const b = base.get(victim.name)!;
      // Page 1 fails with a 5 s backoff: nothing must succeed inside the
      // short real budget, so a slow machine cannot make this fail.
      const inject = failPages(b, [1], { kind: "503", failures: 1_000, retryAfter: "5" });
      const server = catalogServer({ retries: 3, inject });
      const started = performance.now();
      const runners = FLEET.map((m) => start(m, server.pw, m === victim ? { timeBudgetMs: 150 } : {}));
      await Promise.all(runners.map((r) => r.done));
      const v = runners.find((r) => r.member === victim)!;
      assert.ok(v.error instanceof PaginationError && v.error.reason === "time_budget");
      assert.ok(performance.now() - started < 4_000, "did not sit out the 5 s backoff");
      assert.deepEqual(sentBy(server, victim), [b.requests[0]]);
      for (const r of runners) if (r !== v) assertUnaffected(r, server, base, "beside a budget-cut backoff");
    },
  },
  {
    name: "retry/budget: the client's per-request budget still fails fast when a backoff cannot fit",
    async run() {
      const base = await baselines([AUDIT_ITEMS]);
      const b = base.get(AUDIT_ITEMS.name)!;
      // totalTimeoutMs applies to each page request. A 5 s Retry-After cannot
      // fit in 2 s, so the client throws the 503 at once (existing behavior):
      // request_failed, not the traversal's time_budget.
      const inject = failPages(b, [2], { kind: "503", failures: 1_000, retryAfter: "5" });
      const started = performance.now();
      const { r, server } = await solo(AUDIT_ITEMS, { retries: 3, totalTimeoutMs: 2_000, inject }, { timeBudgetMs: LONG_BUDGET_MS });
      assert.ok(r.error instanceof ServerError && r.error.status === 503);
      assert.ok(performance.now() - started < 1_900, "thrown at once, not after waiting");
      assert.deepEqual(sentBy(server, AUDIT_ITEMS), [b.requests[0], b.requests[1]]);
      assertPartial(r, b, 1, "per-request budget");
    },
  },
  {
    name: "retry/budget: retries that fit inside the traversal budget complete normally",
    async run() {
      const base = await baselines([MEMBER_ITEMS]);
      const b = base.get(MEMBER_ITEMS.name)!;
      const inject = failPages(b, [1, 2, 3], { kind: "429", failures: 2 });
      const { r, server } = await solo(MEMBER_ITEMS, { retries: 3, inject }, { timeBudgetMs: LONG_BUDGET_MS });
      assertRecovered(r, server, b, inject, "within budget");
    },
  },
];

export { AUDIT_ITEMS, HOOK_PAGES };
