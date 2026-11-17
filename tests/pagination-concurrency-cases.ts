/**
 * Concurrent traversals on ONE client, through the PUBLIC resource methods.
 * Shared by both runners (vitest: tests/pagination.test.ts; dependency-free:
 * tests/offline/pagination.offline.ts). Node built-ins and SDK source only.
 *
 * METHOD: baseline equivalence. Each traversal is first run alone on a fresh
 * client, and its exact outcome is recorded: delivered ids, error, progress,
 * and the exact sequence of request URLs it caused (filters, page numbers,
 * cursors). Then traversals run concurrently on one client, each in its own
 * independent async loop. The mock delays every response by a deterministic
 * per-URL amount, so requests overlap and complete out of order. After one
 * traversal is cancelled, timed out, stopped or failed, every OTHER traversal
 * must produce exactly its baseline. The transport signal of every one of its
 * wire requests must also never have been aborted.
 *
 * The mock routes each request by the filters it actually carries, and
 * answers 409 to any cursor minted for a different collection. So a traversal
 * that picked up another's filters or continuation fails loudly instead of
 * silently returning different data.
 */
import assert from "node:assert/strict";

import {
  PaginationError,
  PostwaveClient,
  RequestAbortedError,
  ServerError,
} from "../src/index.js";
import type {
  FetchFn,
  PageIterationOptions,
  PaginatedIterator,
  PaginationProgress,
} from "../src/index.js";
import {
  countAbortListeners,
  json,
  LONG_BUDGET_MS,
  sleep,
  withClockOffset,
  type PaginationCase,
} from "./pagination-cases.js";

/* ------------------------------------------------------------ mock catalog */

type Mode = "cursor" | "offset" | "hybrid";
interface Collection {
  rows: number;
  mode: Mode;
  itemsKey: string;
}

/** Every collection the fleet uses, keyed by the route + filters that select it. */
const CATALOG: Record<string, Collection> = {
  "subs:alpha": { rows: 5, mode: "hybrid", itemsKey: "items" },
  "subs:beta": { rows: 4, mode: "offset", itemsKey: "items" },
  "members:L1:enabled": { rows: 5, mode: "offset", itemsKey: "items" },
  "members:L2:": { rows: 3, mode: "offset", itemsKey: "items" },
  "hooks:prod": { rows: 5, mode: "cursor", itemsKey: "webhooks" },
  "hooks:staging": { rows: 6, mode: "cursor", itemsKey: "webhooks" },
  "deliveries:wh_1": { rows: 3, mode: "cursor", itemsKey: "deliveries" },
  "deliveries:wh_2": { rows: 5, mode: "cursor", itemsKey: "deliveries" },
  "audit:create": { rows: 7, mode: "cursor", itemsKey: "items" },
  "audit:delete": { rows: 4, mode: "cursor", itemsKey: "items" },
};
for (let i = 0; i < 25; i++) CATALOG[`audit:bulk${i}`] = { rows: 3, mode: "cursor", itemsKey: "items" };

function routeKey(url: URL): string | undefined {
  const q = url.searchParams;
  const p = url.pathname;
  if (p === "/api/v1/subscribers") return `subs:${q.get("q") ?? ""}`;
  let m = /^\/api\/v1\/lists\/([^/]+)\/subscribers$/.exec(p);
  if (m) return `members:${m[1]}:${q.get("status") ?? ""}`;
  if (p === "/api/v1/outbound-webhooks") return `hooks:${q.get("query") ?? ""}`;
  m = /^\/api\/v1\/outbound-webhooks\/([^/]+)\/deliveries$/.exec(p);
  if (m) return `deliveries:${m[1]}`;
  if (p === "/api/v1/audit") return `audit:${q.get("action") ?? ""}`;
  return undefined;
}

/**
 * The page a target selects: a pure function of the URL, so a solo baseline,
 * a concurrent run and a truncated attempt all see the same bytes.
 */
function pageBody(url: URL, key: string, col: Collection, repeatCursor: boolean): { status: number; body: unknown } {
  const size = Number(url.searchParams.get("per_page") ?? url.searchParams.get("limit") ?? 2);
  const cursor = url.searchParams.get("cursor");
  let offset: number;
  if (cursor !== null) {
    // A cursor minted for another collection is a cross-traversal leak.
    const prefix = `cur:${key}:`;
    if (!cursor.startsWith(prefix)) {
      return { status: 409, body: { error: { code: "foreign_cursor", message: "cursor from another collection" } } };
    }
    offset = Number(cursor.slice(prefix.length));
  } else {
    offset = (Number(url.searchParams.get("page") ?? 1) - 1) * size;
  }
  const items = [];
  for (let i = offset; i < Math.min(offset + size, col.rows); i++) items.push({ id: `${key}#${i}` });
  const more = offset + size < col.rows;
  let nextCursor: string | null = more ? `cur:${key}:${offset + size}` : null;
  if (repeatCursor && cursor !== null) nextCursor = cursor;

  if (col.mode === "cursor") return { status: 200, body: { [col.itemsKey]: items, next_cursor: nextCursor } };
  const body: Record<string, unknown> = {
    items,
    total: col.rows,
    page: cursor === null ? offset / size + 1 : 1,
    per_page: size,
  };
  if (key.startsWith("members:")) body.list_id = key.split(":")[1];
  if (col.mode === "hybrid" && nextCursor !== null) body.next_cursor = nextCursor;
  return { status: 200, body };
}

/**
 * A 200 whose body delivers a genuine prefix of the real page JSON, then
 * fails. The cut falls inside the items array, after at least one complete
 * real row, so the prefix is invalid JSON that nevertheless holds whole rows.
 * A client that salvaged rows from it would deliver them twice once the
 * retry succeeds.
 *
 * The stream is PULL-driven with a high-water mark of one chunk. The first
 * chunk is produced when the reader first asks, the second only after the
 * first was taken, and the failure only when the reader asks for more after
 * that. An instrumented reader records every chunk the consumer (the SDK)
 * actually received, and the rejection that followed. That is the evidence
 * that data reached the reader before the connection failed. (Enqueueing and
 * then erroring in `start()` would discard the queued bytes unread: the Streams
 * spec clears the queue on error.)
 */
function truncatedResponse(text: string, record: TruncationRecord): Response {
  const firstRowEnd = text.indexOf("}") + 1;
  const itemsEnd = text.indexOf("]");
  assert.ok(firstRowEnd > 0 && itemsEnd >= firstRowEnd, "page has at least one row");
  const cut = firstRowEnd + Math.floor((itemsEnd - firstRowEnd) / 2);
  record.prefix = text.slice(0, cut);
  const bytes = new TextEncoder().encode(record.prefix);
  const half = Math.ceil(bytes.length / 2);
  const chunks = [bytes.slice(0, half), bytes.slice(half)];
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const next = chunks.shift();
        if (next) c.enqueue(next);
        else c.error(new TypeError("terminated: connection reset mid-body"));
      },
    },
    { highWaterMark: 1 },
  );
  const getReader = stream.getReader.bind(stream);
  Object.defineProperty(stream, "getReader", {
    value: (...args: []) => {
      const reader = getReader(...args);
      const read = reader.read.bind(reader);
      Object.defineProperty(reader, "read", {
        value: async () => {
          try {
            const r = await read();
            if (!r.done) record.chunksRead.push(r.value.byteLength);
            return r;
          } catch (e) {
            record.failedAfterData = record.chunksRead.length > 0;
            throw e;
          }
        },
      });
      return reader;
    },
  });
  const response = new Response(null, { status: 200, headers: { "content-type": "application/json" } });
  // Hand the SDK this exact stream, so the instrumented reader is the one it reads.
  Object.defineProperty(response, "body", { value: stream });
  return response;
}

type Fault = "stall" | "malformed" | "fail" | "repeat";

/**
 * A transient failure injected into the first `failures` ATTEMPTS at one
 * exact request target (path + query). Later attempts at that target are
 * answered normally, so a client retry of the same page recovers.
 */
export type Transient =
  | "503" // ServerError, Retry-After: 0
  | "429" // RateLimitError, Retry-After: 0
  | "network" // the transport rejects (fetch failed)
  | "truncated" // 200 headers, then the body stream errors mid-JSON
  | "stall" // never answers: only the client's per-attempt timeout ends it
  | "304"; // platform-cache revalidation: the client refetches with _cb

/**
 * Every {@link Transient} kind. The `satisfies` clause makes this a compile
 * error if a kind is added to the union but not listed here, so the retry
 * matrices cannot silently fall behind the failure modes the mock supports.
 */
const TRANSIENT_FLAGS = {
  "503": true,
  "429": true,
  network: true,
  truncated: true,
  stall: true,
  "304": true,
} as const satisfies Record<Transient, true>;
export const TRANSIENT_KINDS = Object.keys(TRANSIENT_FLAGS) as Transient[];

export interface Injection {
  kind: Transient;
  /** How many attempts at this target fail before it is answered normally. */
  failures: number;
  /** Runs when a failing attempt arrives, before it is answered. */
  onAttempt?: (attempt: number, signal: AbortSignal | undefined) => void;
  /** Retry-After seconds for 503/429 (default "0": retry at once). */
  retryAfter?: string;
}

export interface LoggedRequest {
  key: string;
  /** Path + query exactly as sent. */
  target: string;
  /** The signal the SDK handed to the transport for this request. */
  signal: AbortSignal | undefined;
  /** Whether that signal was already aborted when the response was produced. */
  abortedAtResponse?: boolean;
}

/**
 * Evidence from one truncated attempt, recorded by an instrumented reader on
 * the response body the SDK consumed.
 */
export interface TruncationRecord {
  /** The page target (path + query) this attempt was for. */
  target: string;
  /** The exact prefix of the real page JSON that was sent before the drop. */
  prefix: string;
  /** Byte length of each chunk the SDK's reader actually received. */
  chunksRead: number[];
  /** The reader's next read rejected: the connection failed mid-body. */
  failedAfterData: boolean;
}

export interface CatalogServer {
  pw: PostwaveClient;
  log: LoggedRequest[];
  requestsFor(key: string): string[];
  /** One record per truncated attempt, in arrival order. */
  truncations: TruncationRecord[];
}

/**
 * A stateless catalog server: every response depends only on the URL, so a
 * solo baseline and a concurrent run see identical data. `faults` injects a
 * failure at a collection's n-th request (1-based).
 */
export function catalogServer(
  opts: {
    faults?: Record<string, { at: number; kind: Fault }>;
    onStall?: (key: string, signal: AbortSignal | undefined) => void;
    /** Client retries (default 0, as every concurrency case was written for). */
    retries?: number;
    /** Client per-attempt timeout. */
    timeoutMs?: number;
    /** Client-wide per-request budget. */
    totalTimeoutMs?: number;
    /** Transient failures by exact target (path + query, `_cb` ignored). */
    inject?: Map<string, Injection>;
  } = {},
): CatalogServer {
  const log: LoggedRequest[] = [];
  const truncations: TruncationRecord[] = [];
  const perKey = new Map<string, number>();
  const perTarget = new Map<string, number>();
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(input);
    const key = routeKey(url);
    const entry: LoggedRequest = {
      key: key ?? "?",
      target: url.pathname + url.search,
      signal: init?.signal ?? undefined,
    };
    log.push(entry);
    const n = (perKey.get(entry.key) ?? 0) + 1;
    perKey.set(entry.key, n);
    // Deterministic 0-3 ms delay per URL: overlapping, out-of-order replies.
    let h = 0;
    for (const ch of entry.target) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    await sleep(h % 4);

    const respond = (r: Response): Response => {
      entry.abortedAtResponse = entry.signal?.aborted ?? false;
      return r;
    };
    const col = key === undefined ? undefined : CATALOG[key];
    // Transient failures: keyed by the target WITHOUT the client's 304
    // cache-bust parameter, so a cache-bust refetch counts as the same page.
    const bare = new URL(url);
    bare.searchParams.delete("_cb");
    const targetKey = bare.pathname + bare.search;
    const injection = opts.inject?.get(targetKey);
    if (injection) {
      const attempt = (perTarget.get(targetKey) ?? 0) + 1;
      perTarget.set(targetKey, attempt);
      if (attempt <= injection.failures) {
        injection.onAttempt?.(attempt, entry.signal);
        const ra = { "retry-after": injection.retryAfter ?? "0" };
        switch (injection.kind) {
          case "503":
            return respond(json({ error: { code: "unavailable", message: "try again" } }, 503, ra));
          case "429":
            return respond(json({ error: { code: "rate_limited", message: "slow down" } }, 429, ra));
          case "network":
            throw new TypeError("fetch failed");
          case "stall":
            return new Promise<Response>(() => undefined);
          case "304":
            return respond(new Response(null, { status: 304 }));
          case "truncated": {
            // The REAL page this attempt would have returned, cut short.
            const page = key && col ? pageBody(url, key, col, false) : undefined;
            if (!page || page.status !== 200) break;
            const record: TruncationRecord = { target: targetKey, prefix: "", chunksRead: [], failedAfterData: false };
            truncations.push(record);
            return respond(truncatedResponse(JSON.stringify(page.body), record));
          }
        }
      }
    }
    if (!key || !col) return respond(json({ error: { code: "unknown_collection", message: "no route" } }, 404));
    const fault = opts.faults?.[key];
    if (fault && fault.at === n) {
      if (fault.kind === "stall") {
        opts.onStall?.(key, entry.signal);
        return new Promise<Response>(() => undefined); // ignores its signal
      }
      if (fault.kind === "fail") return respond(json({ error: { code: "boom", message: "injected" } }, 500));
      if (fault.kind === "malformed") return respond(json({ [col.itemsKey]: "not-an-array" }));
    }

    const page = pageBody(url, key, col, fault?.kind === "repeat" && fault.at === n);
    return respond(json(page.body, page.status));
  };
  const pw = new PostwaveClient({
    apiKey: "k",
    tenantId: "t",
    retries: opts.retries ?? 0,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.totalTimeoutMs !== undefined ? { totalTimeoutMs: opts.totalTimeoutMs } : {}),
    fetch,
  });
  return {
    pw,
    log,
    truncations,
    requestsFor: (key) => log.filter((r) => r.key === key).map((r) => r.target),
  };
}

/* ------------------------------------------------------------------- fleet */

export interface FleetMember {
  name: string;
  key: string;
  make: (pw: PostwaveClient, options: PageIterationOptions) => PaginatedIterator<unknown>;
  /** Ids carried by one yielded value (an item, or a page's items). */
  ids: (value: unknown) => string[];
}

const itemId = (v: unknown) => [(v as { id: string }).id];
const pageIds = (itemsKey: string) => (v: unknown) =>
  ((v as Record<string, Array<{ id: string }>>)[itemsKey] ?? []).map((x) => x.id);

/** All ten public iterator methods, each on its own collection. */
export const FLEET: FleetMember[] = [
  { name: "subscribers.listAll (offset->cursor)", key: "subs:alpha", ids: itemId,
    make: (pw, o) => pw.subscribers.listAll({ q: "alpha", per_page: 2 }, o) },
  { name: "subscribers.listPages (offset)", key: "subs:beta", ids: pageIds("items"),
    make: (pw, o) => pw.subscribers.listPages({ q: "beta", per_page: 2 }, o) },
  { name: "lists.membersAll", key: "members:L1:enabled", ids: itemId,
    make: (pw, o) => pw.lists.membersAll("L1", { status: "enabled", per_page: 2 }, o) },
  { name: "lists.membersPages", key: "members:L2:", ids: pageIds("items"),
    make: (pw, o) => pw.lists.membersPages("L2", { per_page: 2 }, o) },
  { name: "webhooks.listAll", key: "hooks:prod", ids: itemId,
    make: (pw, o) => pw.webhooks.listAll({ query: "prod", limit: 2 }, o) },
  { name: "webhooks.listPages", key: "hooks:staging", ids: pageIds("webhooks"),
    make: (pw, o) => pw.webhooks.listPages({ query: "staging", limit: 2 }, o) },
  { name: "webhooks.deliveriesAll", key: "deliveries:wh_1", ids: itemId,
    make: (pw, o) => pw.webhooks.deliveriesAll("wh_1", { limit: 2 }, o) },
  { name: "webhooks.deliveriesPages", key: "deliveries:wh_2", ids: pageIds("deliveries"),
    make: (pw, o) => pw.webhooks.deliveriesPages("wh_2", { limit: 2 }, o) },
  { name: "audit.queryAll", key: "audit:create", ids: itemId,
    make: (pw, o) => pw.audit.queryAll({ action: "create" }, o) },
  { name: "audit.queryPages", key: "audit:delete", ids: pageIds("items"),
    make: (pw, o) => pw.audit.queryPages({ action: "delete" }, o) },
];

export interface Outcome {
  ids: string[];
  error: string | undefined;
  progress: PaginationProgress;
  requests: string[];
}

export interface Runner {
  member: FleetMember;
  it: PaginatedIterator<unknown>;
  ids: string[];
  deliveries: number;
  error: unknown;
  stopped: boolean;
  /** Resolves when this traversal's loop has ended. */
  done: Promise<void>;
}

type AfterDeliver = (r: Runner) => void | Promise<void>;

/** Start one traversal in its own independent loop. */
export function start(
  member: FleetMember,
  pw: PostwaveClient,
  options: PageIterationOptions = {},
  afterDeliver?: AfterDeliver,
): Runner {
  const r = {
    member,
    it: member.make(pw, options),
    ids: [] as string[],
    deliveries: 0,
    error: undefined as unknown,
    stopped: false,
  } as Runner;
  r.done = (async () => {
    try {
      for (;;) {
        const res = await r.it.next();
        if (res.done) return;
        r.ids.push(...member.ids(res.value));
        r.deliveries += 1;
        await afterDeliver?.(r);
        if (r.stopped) return;
      }
    } catch (e) {
      r.error = e;
    }
  })();
  return r;
}

/** Stop a traversal the way `break` does. */
export async function stop(r: Runner): Promise<void> {
  r.stopped = true;
  await r.it.return();
}

export function errorName(e: unknown): string | undefined {
  if (e === undefined) return undefined;
  return e instanceof PaginationError ? `PaginationError:${e.reason}` : (e as Error).name;
}

export function outcome(r: Runner, server: CatalogServer): Outcome {
  return {
    ids: r.ids,
    error: errorName(r.error),
    progress: { ...r.it.progress },
    requests: server.requestsFor(r.member.key),
  };
}

/** Every member run alone on a fresh client: the reference outcomes. */
export async function baselines(members: FleetMember[] = FLEET): Promise<Map<string, Outcome>> {
  const out = new Map<string, Outcome>();
  for (const m of members) {
    const server = catalogServer();
    const r = start(m, server.pw);
    await r.done;
    const o = outcome(r, server);
    assert.equal(o.error, undefined, `baseline ${m.name} must succeed`);
    assert.equal(o.progress.complete, true, `baseline ${m.name} must complete`);
    out.set(m.name, o);
  }
  return out;
}

/** Assert a traversal was untouched: baseline outcome, no aborted wire request. */
export function assertUnaffected(r: Runner, server: CatalogServer, base: Map<string, Outcome>, label: string): void {
  assert.deepEqual(outcome(r, server), base.get(r.member.name), `${label}: ${r.member.name}`);
  for (const req of server.log.filter((x) => x.key === r.member.key)) {
    assert.equal(req.abortedAtResponse, false, `${label}: ${r.member.name} had a wire request aborted`);
    assert.equal(req.signal?.aborted, false, `${label}: ${r.member.name} transport signal aborted later`);
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/* ------------------------------------------------------------------- cases */

export const concurrencyCases: PaginationCase[] = [
  {
    name: "concurrency: all ten public iterators on one client each reproduce their solo run exactly",
    async run() {
      const base = await baselines();
      const server = catalogServer();
      const runners = FLEET.map((m) => start(m, server.pw));
      await Promise.all(runners.map((r) => r.done));
      for (const r of runners) assertUnaffected(r, server, base, "concurrent");
      // The requests really did overlap: some traversal's request was sent
      // while another's was still unanswered.
      const keys = server.log.map((x) => x.key);
      assert.ok(new Set(keys.slice(0, FLEET.length)).size === FLEET.length, "first requests interleaved");
      // Sanity: the baselines cover every continuation style.
      const alpha = base.get(FLEET[0]!.name)!.requests;
      assert.ok(alpha[0]!.includes("page=1") && alpha.slice(1).every((t) => t.includes("cursor=")), "hybrid switch");
    },
  },
  {
    name: "concurrency: cancelling any one traversal's own signal leaves every other one unaffected",
    async run() {
      const base = await baselines();
      for (const victim of FLEET) {
        const server = catalogServer();
        const ac = new AbortController();
        const reason = new Error(`cancel ${victim.name}`);
        let requestsAtAbort = -1;
        const runners = FLEET.map((m) =>
          m === victim
            ? start(m, server.pw, { signal: ac.signal }, (r) => {
                if (r.deliveries === 1) {
                  requestsAtAbort = server.requestsFor(m.key).length;
                  ac.abort(reason);
                }
              })
            : start(m, server.pw),
        );
        await Promise.all(runners.map((r) => r.done));
        const v = runners[FLEET.indexOf(victim)]!;
        assert.ok(v.error instanceof RequestAbortedError, `${victim.name} rejected`);
        assert.equal((v.error as RequestAbortedError).payload, reason);
        assert.equal(v.it.progress.stopReason, "cancelled");
        assert.equal(v.deliveries, 1, `${victim.name}: nothing delivered after its abort`);
        assert.equal(server.requestsFor(victim.key).length, requestsAtAbort, `${victim.name}: no request after abort`);
        for (const r of runners) if (r !== v) assertUnaffected(r, server, base, `cancel ${victim.name}`);
      }
    },
  },
  {
    name: "concurrency: cancelling a traversal mid-request lets the others finish while its request hangs",
    async run() {
      const base = await baselines();
      const victim = FLEET[0]!; // hybrid subscribers, stalled on its first cursor page
      const stalled = deferred();
      let stalledSignal: AbortSignal | undefined;
      const server = catalogServer({
        faults: { [victim.key]: { at: 2, kind: "stall" } },
        onStall: (_k, signal) => {
          stalledSignal = signal;
          stalled.resolve();
        },
      });
      const ac = new AbortController();
      const runners = FLEET.map((m) => start(m, server.pw, m === victim ? { signal: ac.signal } : {}));
      const others = runners.slice(1);
      await stalled.promise;
      // Every other traversal runs to completion while the victim's request hangs.
      await Promise.all(others.map((r) => r.done));
      for (const r of others) assertUnaffected(r, server, base, "mid-request cancel");
      ac.abort("late");
      await runners[0]!.done;
      assert.ok(runners[0]!.error instanceof RequestAbortedError);
      assert.equal(stalledSignal?.aborted, true, "the victim's own wire request was aborted");
      assert.equal(runners[0]!.it.progress.items, 2);
    },
  },
  {
    name: "concurrency: one traversal's time budget (stalled request or paused consumer) affects no other",
    async run() {
      const base = await baselines();
      // (a) stalled request: a real timer must end it, so this budget is
      // short and real. It only has to FAIL, which a slow machine cannot
      // prevent. The stall is on its first request, so no success is needed
      // inside the budget.
      {
        const victim = FLEET[4]!; // webhooks.listAll
        const server = catalogServer({ faults: { [victim.key]: { at: 1, kind: "stall" } } });
        const runners = FLEET.map((m) => start(m, server.pw, m === victim ? { timeBudgetMs: 150 } : {}));
        await Promise.all(runners.map((r) => r.done));
        const v = runners[4]!;
        assert.ok(v.error instanceof PaginationError && v.error.reason === "time_budget");
        assert.equal(v.it.progress.items, 0);
        for (const r of runners) if (r !== v) assertUnaffected(r, server, base, "budget/stall");
      }
      // (b) paused consumer: only the paused traversal's budget runs out. The
      // clock is advanced past the victim's budget while the victim's loop is
      // paused. Every other traversal has a budget ten times longer, still far
      // from expiry.
      await withClockOffset(async (advance) => {
        const victim = FLEET[8]!; // audit.queryAll
        const server = catalogServer();
        const runners = FLEET.map((m) =>
          m === victim
            ? start(m, server.pw, { timeBudgetMs: LONG_BUDGET_MS }, (r) => {
                if (r.deliveries === 1) advance(LONG_BUDGET_MS);
              })
            : start(m, server.pw, { timeBudgetMs: 10 * LONG_BUDGET_MS }),
        );
        await Promise.all(runners.map((r) => r.done));
        const v = runners[8]!;
        assert.ok(v.error instanceof PaginationError && v.error.reason === "time_budget");
        assert.equal(v.deliveries, 1);
        // The others had budgets too: each is its own, and none was touched.
        for (const r of runners) if (r !== v) assertUnaffected(r, server, base, "budget/pause");
      });
    },
  },
  {
    name: "concurrency: stopping any one traversal (break/return) leaves every other one unaffected",
    async run() {
      const base = await baselines();
      for (const victim of FLEET) {
        const server = catalogServer();
        let requestsAtStop = -1;
        const runners = FLEET.map((m) =>
          m === victim
            ? start(m, server.pw, {}, async (r) => {
                requestsAtStop = server.requestsFor(m.key).length;
                await stop(r);
              })
            : start(m, server.pw),
        );
        await Promise.all(runners.map((r) => r.done));
        const v = runners[FLEET.indexOf(victim)]!;
        assert.equal(v.error, undefined);
        assert.equal(v.it.progress.stopReason, "consumer_stopped");
        assert.equal(server.requestsFor(victim.key).length, requestsAtStop, `${victim.name}: no request after stop`);
        for (const r of runners) if (r !== v) assertUnaffected(r, server, base, `stop ${victim.name}`);
      }
    },
  },
  {
    name: "concurrency: a failing traversal (malformed, 5xx, repeated cursor, page guard) disturbs no other",
    async run() {
      const base = await baselines();
      const scenarios: Array<[number, Fault | "max_pages", (e: unknown) => boolean]> = [
        [1, "malformed", (e) => e instanceof PaginationError && e.reason === "malformed_page"],
        [2, "fail", (e) => e instanceof ServerError],
        [6, "repeat", (e) => e instanceof PaginationError && e.reason === "repeated_continuation"],
        [9, "max_pages", (e) => e instanceof PaginationError && e.reason === "max_pages"],
      ];
      for (const [index, kind, check] of scenarios) {
        const victim = FLEET[index]!;
        const server = catalogServer(
          kind === "max_pages" ? {} : { faults: { [victim.key]: { at: 2, kind } } },
        );
        const runners = FLEET.map((m) =>
          start(m, server.pw, m === victim && kind === "max_pages" ? { maxPages: 1 } : {}),
        );
        await Promise.all(runners.map((r) => r.done));
        const v = runners[index]!;
        assert.ok(check(v.error), `${victim.name}: ${kind}`);
        for (const r of runners) if (r !== v) assertUnaffected(r, server, base, `${kind} in ${victim.name}`);
      }
    },
  },
  {
    name: "concurrency: two traversals of the same collection and filters keep separate cursors and progress",
    async run() {
      const member = FLEET[8]!; // audit.queryAll, 7 rows over 4 cursor pages
      const solo = (await baselines([member])).get(member.name)!;
      const server = catalogServer();
      const ac = new AbortController();
      // Same public method, same filters, same client: only the run differs.
      const a = start(member, server.pw);
      const b = start(member, server.pw, { signal: ac.signal }, (r) => {
        if (r.deliveries === 3) ac.abort();
      });
      await Promise.all([a.done, b.done]);
      // A saw every cursor B also used, yet neither flagged a repeat.
      assert.equal(a.error, undefined);
      assert.deepEqual(a.ids, solo.ids);
      assert.deepEqual({ ...a.it.progress }, solo.progress);
      assert.ok(b.error instanceof RequestAbortedError);
      assert.equal(b.deliveries, 3);
      // Requests: A's full solo sequence plus B's prefix, each cursor used by
      // each traversal at most once.
      const sent = server.requestsFor(member.key);
      for (const target of solo.requests) {
        const n = sent.filter((t) => t === target).length;
        assert.ok(n >= 1 && n <= 2, `${target} sent ${n} times`);
      }
      assert.equal(sent.length, solo.requests.length + 2, "B stopped after its second page");
    },
  },
  {
    name: "concurrency: the client stays fully usable after cancelled, timed-out and stopped traversals",
    async run() {
      const base = await baselines();
      const server = catalogServer({ faults: { [FLEET[1]!.key]: { at: 1, kind: "stall" } } });
      const ac = new AbortController();
      const troubled = [
        start(FLEET[0]!, server.pw, { signal: ac.signal }, () => ac.abort()),
        start(FLEET[1]!, server.pw, { timeBudgetMs: 50 }),
        start(FLEET[2]!, server.pw, {}, (r) => stop(r)),
      ];
      await Promise.all(troubled.map((r) => r.done));
      // Fresh traversals on the SAME client afterwards.
      const fresh = FLEET.slice(3).map((m) => start(m, server.pw));
      await Promise.all(fresh.map((r) => r.done));
      for (const r of fresh) assertUnaffected(r, server, base, "after trouble");
      assert.equal((await server.pw.audit.query({ action: "delete" })).items.length, 2, "single-page call");
    },
  },
  /* ---- a shared caller signal ---- */
  {
    name: "shared signal: one abort cancels every traversal using it, whatever its state, and nothing else",
    async run() {
      const base = await baselines();
      const S = new AbortController();
      const liveOnS = countAbortListeners(S.signal);
      const reason = new Error("shared stop");
      // Finished: hybrid subscribers. Paused with an item still buffered:
      // membersAll (2 per page, paused after the first). In flight:
      // webhooks.listAll. Never started: webhooks.listPages.
      const finM = FLEET[0]!;
      const pausedM = FLEET[2]!;
      const inflightM = FLEET[4]!;
      const idleM = FLEET[5]!;
      const outsiders = FLEET.filter((m) => ![finM, pausedM, inflightM, idleM].includes(m));
      const stalled = deferred();
      let stalledSignal: AbortSignal | undefined;
      const server = catalogServer({
        faults: { [inflightM.key]: { at: 2, kind: "stall" } },
        onStall: (_k, signal) => {
          stalledSignal = signal;
          stalled.resolve();
        },
      });
      // 1. A traversal on S that finishes before the abort.
      const fin = start(finM, server.pw, { signal: S.signal });
      await fin.done;
      // 2. One paused between items (items still buffered), 3. one with a
      // request in flight, 4. one created but never started; plus traversals
      // with no signal or their own signal.
      const paused = deferred();
      const resume = deferred();
      const p = start(pausedM, server.pw, { signal: S.signal }, async (r) => {
        if (r.deliveries === 1) {
          paused.resolve();
          await resume.promise;
        }
      });
      const f = start(inflightM, server.pw, { signal: S.signal });
      const idle = idleM.make(server.pw, { signal: S.signal });
      const own = new AbortController();
      const others = outsiders.map((m, i) => start(m, server.pw, i % 2 ? { signal: own.signal } : {}));
      await Promise.all([paused.promise, stalled.promise]);

      S.abort(reason);
      resume.resolve();
      await Promise.all([p.done, f.done, ...others.map((r) => r.done)]);

      for (const r of [p, f]) {
        assert.ok(r.error instanceof RequestAbortedError, r.member.name);
        assert.equal((r.error as RequestAbortedError).payload, reason, r.member.name);
        assert.equal(r.it.progress.stopReason, "cancelled");
      }
      assert.equal(p.deliveries, 1, "the paused traversal delivered nothing more");
      assert.equal(stalledSignal?.aborted, true, "the in-flight wire request was aborted");
      const idleResult = await idle.next().then(() => undefined, (e: unknown) => e);
      assert.ok(idleResult instanceof RequestAbortedError && idleResult.payload === reason);
      assert.deepEqual(server.requestsFor(idleM.key), [], "the idle traversal sent nothing");
      // The finished traversal's outcome is unchanged by the later abort.
      assert.deepEqual(outcome(fin, server), base.get(finM.name));
      for (const r of others) assertUnaffected(r, server, base, "outside the shared signal");
      assert.equal(own.signal.aborted, false);
      assert.equal(liveOnS(), 0, "no listener left on the shared signal");
    },
  },
  {
    name: "shared signal: traversals that stop, time out or fail never abort it or the others sharing it",
    async run() {
      const base = await baselines();
      const S = new AbortController();
      const liveOnS = countAbortListeners(S.signal);
      const [stopM, timeM, failM, ...survivorsM] = FLEET;
      const server = catalogServer({
        faults: {
          [timeM!.key]: { at: 1, kind: "stall" }, // fails by its real budget; needs no success first
          [failM!.key]: { at: 2, kind: "malformed" },
        },
      });
      const stopper = start(stopM!, server.pw, { signal: S.signal }, (r) => stop(r));
      const timer = start(timeM!, server.pw, { signal: S.signal, timeBudgetMs: 100 });
      const failer = start(failM!, server.pw, { signal: S.signal });
      const survivors = survivorsM.map((m) => start(m, server.pw, { signal: S.signal }));
      await Promise.all([stopper, timer, failer, ...survivors].map((r) => r.done));
      assert.equal(stopper.it.progress.stopReason, "consumer_stopped");
      assert.ok(timer.error instanceof PaginationError && timer.error.reason === "time_budget");
      assert.ok(failer.error instanceof PaginationError && failer.error.reason === "malformed_page");
      assert.equal(S.signal.aborted, false, "the SDK never aborts a caller's signal");
      for (const r of survivors) assertUnaffected(r, server, base, "sharing S");
      assert.equal(liveOnS(), 0, "no listener left on the shared signal");
    },
  },
  {
    name: "shared signal: 25 traversals in flight on one signal all cancel, with no listener leak or warning",
    async run() {
      const warnings: string[] = [];
      const onWarning = (w: Error) => warnings.push(w.name);
      process.on("warning", onWarning);
      try {
        const keys = Array.from({ length: 25 }, (_, i) => `audit:bulk${i}`);
        const stalledAll = deferred();
        let stalls = 0;
        const server = catalogServer({
          faults: Object.fromEntries(keys.map((k) => [k, { at: 1, kind: "stall" as const }])),
          onStall: () => {
            if (++stalls === keys.length) stalledAll.resolve();
          },
        });
        const S = new AbortController();
        const live = countAbortListeners(S.signal);
        const its = keys.map((_, i) => server.pw.audit.queryAll({ action: `bulk${i}` }, { signal: S.signal }));
        const pending = its.map((it) => it.next().then(() => undefined, (e: unknown) => e));
        await stalledAll.promise;
        assert.equal(live(), 25, "one listener per traversal with a request in flight");
        const reason = new Error("stop all");
        S.abort(reason);
        const results = await Promise.all(pending);
        for (const e of results) {
          assert.ok(e instanceof RequestAbortedError && e.payload === reason);
        }
        assert.ok(server.log.every((x) => x.signal?.aborted === true), "every wire request aborted");
        assert.equal(live(), 0);
        await sleep(10);
        assert.deepEqual(warnings.filter((n) => n === "MaxListenersExceededWarning"), []);
      } finally {
        process.off("warning", onWarning);
      }
    },
  },
  {
    name: "shared signal: already aborted, every traversal on it rejects without any request",
    async run() {
      const server = catalogServer();
      const S = new AbortController();
      S.abort("before");
      const its = FLEET.map((m) => m.make(server.pw, { signal: S.signal }));
      for (const it of its) {
        const e = await it.next().then(() => undefined, (x: unknown) => x);
        assert.ok(e instanceof RequestAbortedError && e.payload === "before");
      }
      assert.equal(server.log.length, 0);
    },
  },
];
