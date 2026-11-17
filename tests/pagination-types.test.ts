/**
 * Public typing checks for the pagination API.
 *
 * The assertions live in `typeAssertions`, which is compiled by
 * `npm run typecheck` (tsc covers tests/**) but never called, so no request
 * is made. At runtime vitest only confirms the public exports exist.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import * as sdk from "../src/index.js";
import { PaginationError, PostwaveError } from "../src/index.js";
import type {
  AuditEntry,
  AuditQueryResponse,
  ItemIterationOptions,
  ListMember,
  ListMembersPage,
  ListSubscribersParams,
  PageIterationOptions,
  PaginatedIterator,
  PaginationFailureReason,
  PaginationMetadataConflict,
  PaginationProgress,
  PaginationStopReason,
  PostwaveClient,
  Subscriber,
  SubscriberPage,
  WebhookDelivery,
  WebhookDeliveryListParams,
  WebhookDeliveryPage,
  WebhookListPage,
  WebhookListParams,
  WebhookSubscription,
} from "../src/index.js";

export function typeAssertions(pw: PostwaveClient): void {
  // Page and item iterators are typed by the existing response contracts.
  expectTypeOf(pw.subscribers.listPages()).toEqualTypeOf<PaginatedIterator<SubscriberPage>>();
  expectTypeOf(pw.subscribers.listAll()).toEqualTypeOf<PaginatedIterator<Subscriber>>();
  expectTypeOf(pw.lists.membersPages(1)).toEqualTypeOf<PaginatedIterator<ListMembersPage>>();
  expectTypeOf(pw.lists.membersAll("l")).toEqualTypeOf<PaginatedIterator<ListMember>>();
  expectTypeOf(pw.webhooks.listPages()).toEqualTypeOf<PaginatedIterator<WebhookListPage>>();
  expectTypeOf(pw.webhooks.listAll()).toEqualTypeOf<PaginatedIterator<WebhookSubscription>>();
  expectTypeOf(pw.webhooks.deliveriesPages("w")).toEqualTypeOf<PaginatedIterator<WebhookDeliveryPage>>();
  expectTypeOf(pw.webhooks.deliveriesAll("w")).toEqualTypeOf<PaginatedIterator<WebhookDelivery>>();
  expectTypeOf(pw.audit.queryPages()).toEqualTypeOf<PaginatedIterator<AuditQueryResponse>>();
  expectTypeOf(pw.audit.queryAll()).toEqualTypeOf<PaginatedIterator<AuditEntry>>();

  // Async iterables with a read-only progress view.
  const it = pw.audit.queryAll();
  expectTypeOf(it).toMatchTypeOf<AsyncIterable<AuditEntry>>();
  expectTypeOf(it.next()).resolves.toEqualTypeOf<IteratorResult<AuditEntry, undefined>>();
  expectTypeOf(it.progress).toEqualTypeOf<PaginationProgress>();
  expectTypeOf(it.progress.stopReason).toEqualTypeOf<PaginationStopReason | undefined>();
  // @ts-expect-error progress is read-only
  it.progress = it.progress;
  // @ts-expect-error progress fields are read-only
  it.progress.items = 1;

  // Single-page signatures are unchanged.
  expectTypeOf(pw.subscribers.list).parameter(0).toEqualTypeOf<ListSubscribersParams | undefined>();
  expectTypeOf(pw.subscribers.list()).resolves.toEqualTypeOf<SubscriberPage>();
  expectTypeOf(pw.lists.members(1)).resolves.toEqualTypeOf<ListMembersPage>();
  expectTypeOf(pw.webhooks.list).parameter(0).toEqualTypeOf<WebhookListParams | undefined>();
  expectTypeOf(pw.webhooks.list()).resolves.toEqualTypeOf<WebhookListPage>();
  expectTypeOf(pw.webhooks.deliveriesList).parameter(1).toEqualTypeOf<WebhookDeliveryListParams | undefined>();
  expectTypeOf(pw.webhooks.deliveries("w")).resolves.toEqualTypeOf<WebhookDelivery[]>();
  expectTypeOf(pw.audit.query()).resolves.toEqualTypeOf<AuditQueryResponse>();
  // The new contract field is optional, so existing page literals still compile.
  const legacy: SubscriberPage = { items: [], total: 0, page: 1, per_page: 50 };
  expectTypeOf(legacy.next_cursor).toEqualTypeOf<string | undefined>();

  // maxItems is an item-iterator option only.
  expectTypeOf<ItemIterationOptions>().toMatchTypeOf<PageIterationOptions>();
  pw.audit.queryAll({}, { maxItems: 10, maxPages: 5, timeBudgetMs: 1_000 });
  // @ts-expect-error maxItems is not a page-iterator option
  pw.audit.queryPages({}, { maxItems: 10 });
  // @ts-expect-error list_id is not a subscribers.list filter (use lists.membersAll)
  pw.subscribers.listAll({ list_id: 3 });

  // PaginationError is a PostwaveError with a typed reason.
  expectTypeOf<PaginationError>().toMatchTypeOf<PostwaveError>();
  expectTypeOf<PaginationError["reason"]>().toEqualTypeOf<PaginationFailureReason>();
  expectTypeOf<PaginationFailureReason>().toEqualTypeOf<
    "max_pages" | "time_budget" | "malformed_page" | "repeated_continuation"
  >();
  expectTypeOf<PaginationFailureReason>().toMatchTypeOf<PaginationStopReason>();

  // Conservative completion: an explicit normal-end reason and named conflicts.
  expectTypeOf<"metadata_conflict">().toMatchTypeOf<PaginationStopReason>();
  expectTypeOf<PaginationMetadataConflict>().toEqualTypeOf<
    | "total_changed"
    | "per_page_changed"
    | "empty_before_total"
    | "short_page_before_total"
    | "rows_beyond_total"
  >();
  expectTypeOf(it.progress.conflicts).toEqualTypeOf<readonly PaginationMetadataConflict[] | undefined>();
  // @ts-expect-error the conflict list is read-only
  it.progress.conflicts?.push("total_changed");
}

describe("pagination public exports", () => {
  it("exports PaginationError and nothing internal", () => {
    expect(new PaginationError({
      reason: "max_pages", operation: "x", message: "m", pages: 0, items: 0,
    })).toBeInstanceOf(PostwaveError);
    for (const internal of [
      "iteratePages", "iterateItems", "PaginationRun", "DEFAULT_MAX_PAGES",
      "CONTINUATION_HISTORY_LIMIT", "checkPageSize", "snapshotParams",
    ]) {
      expect(internal in sdk, internal).toBe(false);
    }
  });
});
