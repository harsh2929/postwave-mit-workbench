/**
 * Shared pagination engine for the typed page and item iterators
 * (`subscribers.listPages/listAll`, `lists.membersPages/membersAll`,
 * `webhooks.listPages/listAll`, `webhooks.deliveriesPages/deliveriesAll`,
 * `audit.queryPages/queryAll`).
 *
 * Every collection is described by a small {@link PaginationSpec}: where the
 * items live in the page, which continuation styles the response contract
 * offers, where to start and how to fetch one page. Everything else lives
 * here, once: laziness, option validation, the page guard, the item limit,
 * the overall time budget, cancellation, contract checks on each page and
 * repeated-continuation detection.
 *
 * DESIGN RULES
 *
 * - Lazy and demand-driven. Nothing is requested when an iterator is created.
 *   The first page is requested by the first `next()`, and a further page
 *   only when the consumer asks for more than has been delivered. There is
 *   no prefetch.
 * - Bounded memory. At most one page is held, plus a bounded window of
 *   recently used cursors. Nothing accumulates across pages. In particular,
 *   items are not de-duplicated, because that would need unbounded state.
 * - One delivery gate for pages and items. `admit()` runs synchronously
 *   immediately before every `yield` of either iterator, and a request never
 *   starts without the same check. It tests the caller's signal and the time
 *   budget against the monotonic clock. Nothing is delivered after either has
 *   fired, including a page accepted just before, or items already buffered
 *   from a page. An iteration with nothing left to deliver ends normally.
 * - Completion is claimed conservatively. `complete: true` requires the
 *   server to report the end AND consistent numbered-page metadata. Any
 *   conflict (a changed or stale `total`, a changed `per_page`) ends the
 *   iteration as `metadata_conflict` instead. A genuinely empty collection
 *   is complete.
 * - No resources between calls. The budget is a monotonic deadline, not a
 *   timer. A timer and a listener on the caller's signal exist only while a
 *   page request is in flight, and both are released when it settles. An
 *   iterator the consumer abandons without `return()` holds nothing armed.
 * - A page is accepted or rejected whole. A page that breaks its contract,
 *   or whose continuation repeats one already used, fails the iteration
 *   before any of its items are delivered.
 * - No sensitive values in diagnostics. Errors name the operation, counts,
 *   limits and field names only.
 */

import {
  PaginationError,
  RequestAbortedError,
  type PaginationFailureReason,
} from "../errors.js";
import {
  AbortScope,
  LifecycleAbort,
  MAX_TIMER_DELAY_MS,
  monotonicNow,
} from "./lifecycle.js";

/** Default finite page guard when `maxPages` is not supplied. */
export const DEFAULT_MAX_PAGES = 1000;

/**
 * How many recently used cursors are remembered to detect a repeat. A cycle
 * longer than this is still stopped by the page guard. Bounded so memory does
 * not grow with the number of pages.
 */
export const CONTINUATION_HISTORY_LIMIT = 1024;

/** Options accepted by every page iterator (`*Pages()`). */
export interface PageIterationOptions {
  /**
   * Cancels the iteration at any point: before the first request, during a
   * page request (including its retries and backoff waits), or while the
   * consumer is paused between items. The pending or next `next()` rejects
   * with `RequestAbortedError` (payload: the abort reason).
   */
  signal?: AbortSignal;
  /**
   * Finite page guard: the most page requests this iteration may make.
   * Default 1000. Must be a positive integer. `Infinity` is rejected. When
   * the guard is reached and the server still reports more data, the
   * consumer's next demand for data rejects with `PaginationError`
   * (`reason: "max_pages"`). A collection that ends exactly at the guard
   * completes normally.
   */
  maxPages?: number;
  /**
   * Optional overall budget in ms for the whole iteration. It starts at the
   * first `next()` (not when the iterator is created) and covers every page
   * request, the client's retries and backoff waits, AND the time the
   * consumer spends between `next()` calls. Expiry rejects with
   * `PaginationError` (`reason: "time_budget"`). Values above 2^31-1 ms are
   * clamped to it.
   */
  timeBudgetMs?: number;
}

/** Options accepted by every item iterator (`*All()`). */
export interface ItemIterationOptions extends PageIterationOptions {
  /**
   * Optional item limit: deliver at most this many items, then end NORMALLY.
   * This is a cap the caller chose, so it does not throw. Check
   * `iterator.progress.complete` to learn whether the collection ended too.
   * Must be a positive integer. Only the pages needed to reach it are
   * requested.
   */
  maxItems?: number;
}

/**
 * A disagreement in numbered-page (offset) metadata seen during traversal.
 * Each means the collection changed under the iteration, or the server's
 * counts are stale, so rows may have been skipped or repeated:
 *
 * - `total_changed`: `total` differs from the previous numbered page's.
 * - `per_page_changed`: `per_page` differs from the previous numbered page's.
 * - `empty_before_total`: a page is empty although `total` says rows remain
 *   at its offset.
 * - `short_page_before_total`: a page holds fewer than `per_page` rows
 *   although `total` says more follow it.
 * - `rows_beyond_total`: pages so far hold more rows than `total`.
 *
 * Cursor pages are never checked: a keyset cursor, not `total`, decides
 * continuation there, so their `total` is informational.
 */
export type PaginationMetadataConflict =
  | "total_changed"
  | "per_page_changed"
  | "empty_before_total"
  | "short_page_before_total"
  | "rows_beyond_total";

/**
 * How an iteration ended.
 *
 * Normal endings (the iterator returns `done: true`):
 * - `end`: the server reported the end, everything was delivered and the
 *   page metadata was consistent. The only reason with `complete: true`.
 * - `metadata_conflict`: the server reported the end and everything it
 *   returned was delivered, but numbered-page metadata conflicted along the
 *   way (see `progress.conflicts`), so completeness cannot be confirmed.
 * - `max_items`: the `maxItems` cap was reached before the collection ended.
 * - `consumer_stopped`: the consumer called `return()` (e.g. `break`).
 *
 * Failures (the iterator rejects): the four {@link PaginationFailureReason}
 * values, plus `cancelled` (`RequestAbortedError`) and `request_failed` (any
 * other error from a page request, propagated unchanged).
 */
export type PaginationStopReason =
  | "end"
  | "metadata_conflict"
  | "max_items"
  | "consumer_stopped"
  | "cancelled"
  | "request_failed"
  | PaginationFailureReason;

/** Snapshot of an iterator's progress. Contains counts and kinds only. */
export interface PaginationProgress {
  /**
   * Pages that passed the delivery gate. For page iterators, pages delivered.
   * For item iterators, pages whose first item was delivered, plus empty
   * pages passed through. A page rejected at delivery is never counted.
   */
  readonly pages: number;
  /** Items delivered to the consumer so far (page iterators: items in delivered pages). */
  readonly items: number;
  /** The iteration has ended, normally or not. */
  readonly done: boolean;
  /**
   * True only when the server reported the end of the collection, every item
   * was delivered AND no numbered-page metadata conflicted. An export is
   * complete if and only if this is true.
   */
  readonly complete: boolean;
  /** Why the iteration ended; undefined while it is still running. */
  readonly stopReason: PaginationStopReason | undefined;
  /**
   * Present only once a conflict has been seen: each distinct
   * {@link PaginationMetadataConflict}, in the order first seen (at most 5).
   * Its presence rules out `complete: true`.
   */
  readonly conflicts?: readonly PaginationMetadataConflict[];
}

/**
 * A lazy, single-use async iterator over pages or items.
 *
 * Use it with `for await`. Leaving the loop (`break`, `return`, a thrown
 * error) stops the iteration and sends no further request. Like a generator,
 * it can be consumed only once. Concurrent `next()` calls are queued and
 * served in order.
 */
export interface PaginatedIterator<T> extends AsyncIterableIterator<T> {
  next(): Promise<IteratorResult<T, undefined>>;
  return(): Promise<IteratorResult<T, undefined>>;
  [Symbol.asyncIterator](): PaginatedIterator<T>;
  /** Current progress. Read it after the loop to learn how it ended. */
  readonly progress: PaginationProgress;
}

/** @internal Continuation for one page request. */
export interface Continuation {
  /** Offset page number (1-based). */
  page?: number;
  /** Opaque keyset cursor. */
  cursor?: string;
}

/** @internal Describes one paginated collection. */
export interface PaginationSpec {
  /** The single-page operation, used in diagnostics. Never a value. */
  operation: string;
  /** Response field holding the page's items. */
  itemsKey: string;
  /** Response field holding the next cursor, when the contract has one. */
  cursorKey?: string;
  /**
   * Whether the contract has offset pagination (`page`, `per_page`, `total`
   * required in the response). With a `cursorKey` as well, iteration starts
   * with offsets and switches to the cursor as soon as the server returns one.
   */
  offset?: boolean;
  /** The first request's continuation. */
  start: Continuation;
  /** Fetch one page. Must pass `signal` to the request. */
  fetch: (continuation: Continuation, signal: AbortSignal) => Promise<unknown>;
}

interface ResolvedOptions {
  signal: AbortSignal | undefined;
  maxPages: number;
  maxItems: number | undefined;
  timeBudgetMs: number | undefined;
}

interface AcceptedPage {
  raw: unknown;
  items: readonly unknown[];
}

/** @internal Iterate whole pages, typed as the collection's page contract. */
export function iteratePages<TPage>(
  spec: PaginationSpec,
  options: PageIterationOptions = {},
): PaginatedIterator<TPage> {
  if (
    options !== null &&
    typeof options === "object" &&
    (options as ItemIterationOptions).maxItems !== undefined
  ) {
    throw new Error(
      `${spec.operation}: maxItems applies to item iteration only; use the matching *All() iterator`,
    );
  }
  const run = new PaginationRun(spec, resolveOptions(spec.operation, options));
  return new PaginationIterator<TPage>(run, run.pages<TPage>());
}

/** @internal Iterate individual items across pages. */
export function iterateItems<TItem>(
  spec: PaginationSpec,
  options: ItemIterationOptions = {},
): PaginatedIterator<TItem> {
  const run = new PaginationRun(spec, resolveOptions(spec.operation, options));
  return new PaginationIterator<TItem>(run, run.items<TItem>());
}

/* ---------------------------------------------------------------------------
 * Parameter validation shared by the resources. Messages name the parameter,
 * never the value.
 * ------------------------------------------------------------------------- */

/** @internal A positive page-size parameter, optionally capped by the contract. */
export function checkPageSize(
  operation: string,
  name: string,
  value: unknown,
  max?: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (max !== undefined && value > max)
  ) {
    throw new Error(
      `${operation}: ${name} must be an integer from 1 to ${max ?? "2^53-1"}`,
    );
  }
}

/** @internal A 1-based starting page number. */
export function checkStartPage(operation: string, value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${operation}: page must be a positive integer`);
  }
  return value;
}

/** @internal A resume cursor: absent, or a non-empty string. */
export function checkStartCursor(
  operation: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") {
    throw new Error(`${operation}: cursor must be a non-empty string`);
  }
  return value;
}

/**
 * @internal Snapshot caller filters so mutating the caller's object during
 * iteration cannot change later page requests.
 */
export function snapshotParams<T extends object>(
  operation: string,
  params: T | undefined,
): T {
  if (params === undefined) return {} as T;
  if (params === null || typeof params !== "object") {
    throw new Error(`${operation}: params must be an object`);
  }
  return { ...params };
}

function resolveOptions(
  operation: string,
  options: ItemIterationOptions | undefined,
): ResolvedOptions {
  if (options === undefined) options = {};
  if (options === null || typeof options !== "object") {
    throw new Error(`${operation}: options must be an object`);
  }
  const positive = (name: string, value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${operation}: ${name} must be a positive integer`);
    }
    return value;
  };
  let timeBudgetMs: number | undefined;
  if (options.timeBudgetMs !== undefined) {
    const v = options.timeBudgetMs;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(
        `${operation}: timeBudgetMs must be a positive, finite number of milliseconds`,
      );
    }
    timeBudgetMs = Math.min(Math.ceil(v), MAX_TIMER_DELAY_MS);
  }
  const signal = options.signal;
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function")
  ) {
    throw new Error(`${operation}: signal must be an AbortSignal`);
  }
  return {
    signal,
    maxPages: positive("maxPages", options.maxPages) ?? DEFAULT_MAX_PAGES,
    maxItems: positive("maxItems", options.maxItems),
    timeBudgetMs,
  };
}

/* ---------------------------------------------------------------------------
 * The run: one iteration's state, shared by its page or item generator.
 * ------------------------------------------------------------------------- */

class PaginationRun {
  private readonly spec: PaginationSpec;
  private readonly opts: ResolvedOptions;
  /** Continuation for the next request; null once the server reported the end. */
  private continuation: Continuation | null;
  private readonly usedCursors = new Set<string>();
  private deadline: number | undefined;
  private requests = 0;
  /** See PaginationProgress.pages. */
  private pageCount = 0;
  private delivered = 0;
  /** Distinct metadata conflicts, first-seen order. Bounded by their kinds. */
  private readonly conflicts: PaginationMetadataConflict[] = [];
  /** `total` / `per_page` of the previous numbered (offset) page. */
  private lastTotal: number | undefined;
  private lastPerPage: number | undefined;
  private ended = false;
  private endedComplete = false;
  private reason: PaginationStopReason | undefined;

  constructor(spec: PaginationSpec, opts: ResolvedOptions) {
    this.spec = spec;
    this.opts = opts;
    this.continuation = { ...spec.start };
    if (spec.start.cursor !== undefined) this.remember(spec.start.cursor);
  }

  progress(): PaginationProgress {
    const snapshot: PaginationProgress = {
      pages: this.pageCount,
      items: this.delivered,
      done: this.ended,
      complete: this.endedComplete,
      stopReason: this.reason,
      ...(this.conflicts.length > 0
        ? { conflicts: Object.freeze([...this.conflicts]) }
        : {}),
    };
    return Object.freeze(snapshot);
  }

  /** Mark a consumer `return()` on an iteration that had not ended. */
  stopByConsumer(): void {
    this.finish("consumer_stopped", false);
  }

  async *pages<TPage>(): AsyncGenerator<TPage, undefined, undefined> {
    this.begin();
    try {
      for (;;) {
        if (this.continuation === null) {
          this.finishAtEnd();
          return undefined;
        }
        const page = await this.fetchNext();
        // The delivery gate, synchronously before the yield: the await above
        // is a hand-off window in which the caller may abort or the budget
        // may pass after the page was accepted.
        this.admit(page.items.length, true);
        yield page.raw as TPage;
      }
    } catch (e) {
      this.fail(e);
      throw e;
    } finally {
      this.finish("consumer_stopped", false);
    }
  }

  async *items<TItem>(): AsyncGenerator<TItem, undefined, undefined> {
    this.begin();
    // The single buffered page. Dropped as soon as it is used up.
    let buffer: readonly unknown[] | undefined;
    let index = 0;
    // Whether the buffered page has passed the delivery gate (at its first item).
    let pageAdmitted = false;
    try {
      for (;;) {
        const bufferEmpty = buffer === undefined || index >= buffer.length;
        if (bufferEmpty) buffer = undefined;
        if (
          this.opts.maxItems !== undefined &&
          this.delivered >= this.opts.maxItems
        ) {
          if (bufferEmpty && this.continuation === null) this.finishAtEnd();
          else this.finish("max_items", false);
          return undefined;
        }
        if (buffer !== undefined) {
          // The same delivery gate as page iterators, before the yield. The
          // page itself counts as delivered with its first item.
          this.admit(1, !pageAdmitted);
          pageAdmitted = true;
          yield buffer[index++] as TItem;
          continue;
        }
        if (this.continuation === null) {
          this.finishAtEnd();
          return undefined;
        }
        buffer = (await this.fetchNext()).items;
        index = 0;
        pageAdmitted = false;
        // An empty page has no item to carry it through the gate, so it
        // passes the gate on its own, exactly as a page iterator's would.
        if (buffer.length === 0) this.admit(0, true);
      }
    } catch (e) {
      this.fail(e);
      throw e;
    } finally {
      // A return() right after the capped item counts as the cap, not a break.
      if (
        !this.ended &&
        this.opts.maxItems !== undefined &&
        this.delivered >= this.opts.maxItems
      ) {
        const atEnd =
          (buffer === undefined || index >= buffer.length) &&
          this.continuation === null;
        if (atEnd) this.finishAtEnd();
        else this.finish("max_items", false);
      }
      this.finish("consumer_stopped", false);
      buffer = undefined;
    }
  }

  /**
   * THE delivery gate, shared by page and item iterators. Called
   * synchronously immediately before every `yield`, with no await in
   * between, so nothing is handed out once the caller has cancelled or the
   * budget has passed by the clock, however late that happened. Counts only
   * what actually goes out.
   */
  private admit(items: number, isPage: boolean): void {
    this.checkpoint();
    this.delivered += items;
    if (isPage) this.pageCount += 1;
  }

  /** The server reported the end: complete only without metadata conflicts. */
  private finishAtEnd(): void {
    if (this.conflicts.length > 0) this.finish("metadata_conflict", false);
    else this.finish("end", true);
  }

  private conflict(kind: PaginationMetadataConflict): void {
    if (!this.conflicts.includes(kind)) this.conflicts.push(kind);
  }

  /** The budget starts when iteration begins: the first `next()`. */
  private begin(): void {
    if (this.opts.timeBudgetMs !== undefined) {
      this.deadline = monotonicNow() + this.opts.timeBudgetMs;
    }
  }

  /** Throw if the caller cancelled or the budget has passed, by the clock. */
  private checkpoint(): void {
    const signal = this.opts.signal;
    if (signal?.aborted) {
      throw new RequestAbortedError({ payload: signal.reason });
    }
    if (this.deadline !== undefined && monotonicNow() >= this.deadline) {
      throw this.error("time_budget");
    }
  }

  private async fetchNext(): Promise<AcceptedPage> {
    this.checkpoint();
    if (this.requests >= this.opts.maxPages) throw this.error("max_pages");
    const continuation = this.continuation as Continuation;
    this.requests += 1;

    // Only now, for the duration of this request, arm a timer and a listener.
    const remaining =
      this.deadline === undefined
        ? undefined
        : Math.max(1, Math.ceil(this.deadline - monotonicNow()));
    const scope = new AbortScope({
      parent: this.opts.signal,
      timeoutMs: remaining,
      timeoutScope: "wait",
    });
    let raw: unknown;
    try {
      raw = await this.spec.fetch({ ...continuation }, scope.signal);
      // Settle gate: a page that arrives after cancellation or after the
      // budget passed (by the clock, even if the timer has not fired) is
      // discarded, never delivered.
      if (scope.sync()) throw this.scopeError(scope);
    } catch (e) {
      // Once our scope fired it alone decides the outcome, whatever the
      // interrupted request happened to throw.
      if (scope.sync()) throw this.scopeError(scope);
      throw e;
    } finally {
      scope.dispose();
    }
    this.checkpoint();

    return this.accept(raw, continuation);
  }

  /**
   * Validate one page against its contract and compute the next
   * continuation. Throws before anything from the page is delivered.
   */
  private accept(raw: unknown, request: Continuation): AcceptedPage {
    const { itemsKey, cursorKey, offset } = this.spec;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw this.malformed("the response is not a JSON object");
    }
    const body = raw as Record<string, unknown>;
    const items = body[itemsKey];
    if (!Array.isArray(items)) {
      throw this.malformed(`\`${itemsKey}\` is not an array`);
    }
    for (const item of items) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw this.malformed(`\`${itemsKey}\` contains a non-object entry`);
      }
    }

    let nextCursor: string | undefined;
    if (cursorKey !== undefined) {
      const value = body[cursorKey];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw this.malformed(`\`${cursorKey}\` is not a string`);
      }
      // An empty string is treated like null: the end of the collection.
      if (typeof value === "string" && value !== "") nextCursor = value;
    }

    let pageNo = 0;
    let perPage = 0;
    let total = 0;
    if (offset) {
      pageNo = integerField(body, "page", 1) ?? NaN;
      perPage = integerField(body, "per_page", 1) ?? NaN;
      total = integerField(body, "total", 0) ?? NaN;
      if (Number.isNaN(pageNo)) throw this.malformed("`page` is not a positive integer");
      if (Number.isNaN(perPage)) throw this.malformed("`per_page` is not a positive integer");
      if (Number.isNaN(total)) throw this.malformed("`total` is not a non-negative integer");
      if (items.length > perPage) {
        throw this.malformed(`\`${itemsKey}\` holds more entries than \`per_page\``);
      }
    }

    let next: Continuation | null;
    let numbered = false;
    if (request.cursor !== undefined || !offset) {
      // Cursor mode. The cursor alone decides whether more data exists.
      next = nextCursor === undefined ? null : { cursor: nextCursor };
    } else {
      // Offset mode. The server must echo the page it was asked for.
      const requested = request.page ?? 1;
      if (pageNo !== requested) {
        throw pageNo < requested
          ? this.error("repeated_continuation")
          : this.malformed("`page` does not match the requested page");
      }
      numbered = true;
      if (nextCursor !== undefined) {
        // The server offered a keyset cursor: cheaper, and stable under
        // concurrent writes. Switch to it for the rest of the iteration.
        next = { cursor: nextCursor };
      } else if (items.length === 0 || pageNo * perPage >= total) {
        next = null;
      } else {
        next = { page: requested + 1 };
      }
    }

    if (next?.cursor !== undefined) {
      if (this.usedCursors.has(next.cursor)) {
        throw this.error("repeated_continuation");
      }
      this.remember(next.cursor);
    }
    // Recorded only once every check has passed, so only accepted pages
    // contribute conflicts.
    if (numbered) this.checkOffsetMetadata(pageNo, perPage, total, items.length);
    this.continuation = next;
    return { raw, items };
  }

  /**
   * Record conflicts in one numbered page's metadata. Continuation rules are
   * unchanged (bounded, no extra requests); only the completion claim is
   * withheld. A genuinely empty collection (page 1, no rows, total 0)
   * conflicts with nothing.
   */
  private checkOffsetMetadata(
    pageNo: number,
    perPage: number,
    total: number,
    rows: number,
  ): void {
    if (this.lastTotal !== undefined && total !== this.lastTotal) {
      this.conflict("total_changed");
    }
    if (this.lastPerPage !== undefined && perPage !== this.lastPerPage) {
      this.conflict("per_page_changed");
    }
    this.lastTotal = total;
    this.lastPerPage = perPage;
    const offset = (pageNo - 1) * perPage;
    if (rows === 0 && offset < total) this.conflict("empty_before_total");
    if (rows > 0 && rows < perPage && offset + rows < total) {
      this.conflict("short_page_before_total");
    }
    if (rows > 0 && offset + rows > total) this.conflict("rows_beyond_total");
  }

  private remember(cursor: string): void {
    this.usedCursors.add(cursor);
    if (this.usedCursors.size > CONTINUATION_HISTORY_LIMIT) {
      const oldest = this.usedCursors.values().next().value;
      if (oldest !== undefined) this.usedCursors.delete(oldest);
    }
  }

  private scopeError(scope: AbortScope): Error {
    const reason: unknown = scope.signal.reason;
    if (reason instanceof LifecycleAbort && reason.kind === "timeout") {
      return this.error("time_budget");
    }
    return new RequestAbortedError({
      payload: reason instanceof LifecycleAbort ? reason.callerReason : reason,
    });
  }

  private malformed(detail: string): PaginationError {
    return this.error("malformed_page", detail);
  }

  private error(
    reason: PaginationFailureReason,
    detail?: string,
  ): PaginationError {
    const op = this.spec.operation;
    const pageIndex = this.requests;
    const delivered = `${this.delivered} item(s) from ${this.pageCount} page(s) were delivered`;
    let message: string;
    let limit: number | undefined;
    switch (reason) {
      case "max_pages":
        limit = this.opts.maxPages;
        message = `${op}: stopped at the page guard of ${limit} page(s) while the server still reported more data; ${delivered} and the result is incomplete`;
        break;
      case "time_budget":
        limit = this.opts.timeBudgetMs;
        message = `${op}: the pagination time budget of ${limit}ms expired before the collection ended; ${delivered} and the result is incomplete`;
        break;
      case "repeated_continuation":
        message = `${op}: page ${pageIndex} repeated continuation data already used by this iteration; the page was rejected, ${delivered} and the result is incomplete`;
        break;
      default:
        message = `${op}: page ${pageIndex} does not match the response contract (${detail}); the page was rejected, ${delivered} and the result is incomplete`;
    }
    return new PaginationError({
      reason,
      operation: op,
      message,
      pages: this.pageCount,
      items: this.delivered,
      limit,
    });
  }

  private fail(e: unknown): void {
    if (e instanceof PaginationError) this.finish(e.reason, false);
    else if (e instanceof RequestAbortedError) this.finish("cancelled", false);
    else this.finish("request_failed", false);
  }

  /** First call wins; later calls are no-ops. */
  private finish(reason: PaginationStopReason, complete: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.endedComplete = complete;
    this.reason = reason;
    // Nothing further will be requested; release continuation state.
    this.continuation = null;
    this.usedCursors.clear();
  }
}

function integerField(
  body: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined {
  const v = body[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min
    ? v
    : undefined;
}

/** Public iterator object: generator semantics plus a progress view. */
class PaginationIterator<T> implements PaginatedIterator<T> {
  readonly #run: PaginationRun;
  readonly #gen: AsyncGenerator<T, undefined, undefined>;

  constructor(run: PaginationRun, gen: AsyncGenerator<T, undefined, undefined>) {
    this.#run = run;
    this.#gen = gen;
  }

  get progress(): PaginationProgress {
    return this.#run.progress();
  }

  next(): Promise<IteratorResult<T, undefined>> {
    return this.#gen.next();
  }

  async return(): Promise<IteratorResult<T, undefined>> {
    const result = await this.#gen.return(undefined);
    // A generator returned before its first next() never runs its body.
    this.#run.stopByConsumer();
    return result;
  }

  [Symbol.asyncIterator](): PaginatedIterator<T> {
    return this;
  }
}
