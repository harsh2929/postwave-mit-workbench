// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type { PostwaveClient } from "../client.js";
import {
  checkPageSize,
  checkStartCursor,
  iterateItems,
  iteratePages,
  snapshotParams,
  type ItemIterationOptions,
  type PageIterationOptions,
  type PaginatedIterator,
  type PaginationSpec,
} from "../lib/pagination.js";
import type {
  WebhookEventType,
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookSubscriptionUpdate,
} from "../types.js";
import { verifySignature as _verifySignature } from "../webhook.js";

/** Query params for `GET /api/v1/outbound-webhooks`. */
export interface WebhookListParams {
  query?: string;
  /** Page size. */
  limit?: number;
  /** Opaque cursor from a previous page's `next_cursor`. */
  cursor?: string;
}

/** Query params for `GET /api/v1/outbound-webhooks/{id}/deliveries`. */
export interface WebhookDeliveryListParams {
  /** Page size. */
  limit?: number;
  /** Opaque cursor from a previous page's `next_cursor`. */
  cursor?: string;
}

export interface WebhookListPage {
  webhooks: WebhookSubscription[];
  next_cursor?: string | null;
}

export interface WebhookCreateResponse {
  webhook: WebhookSubscription;
  /** HMAC signing secret. Returned exactly once at create/rotation time. */
  signing_secret?: string;
  /** Asymmetric private key. Returned exactly once at create/rotation time. */
  private_key_pem?: string;
  public_key_pem?: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: WebhookEventType | "webhook.test";
  attempt_count: number;
  next_attempt_at?: string | null;
  status: "pending" | "delivered" | "failed" | "exhausted";
  last_status_code?: number | null;
  last_response_body_truncated?: string;
  last_error?: string;
  created_at: string;
  delivered_at?: string | null;
}

export interface WebhookDeliveryPage {
  deliveries: WebhookDelivery[];
  next_cursor?: string | null;
}

export interface WebhookTestResult {
  webhook_id: string;
  status_code: number;
  signed: boolean;
  signature?: string;
  key_ids?: string;
  response?: string;
  error?: string;
  filtered?: boolean;
  redaction_applied?: boolean;
}

export interface WebhookReplayResponse {
  delivery_id: string;
  replayed_from: string;
  status: "pending";
  replayed_at: string;
}

export class WebhooksResource extends Resource {
  /** Canonical outbound-webhooks collection. */
  list(params: WebhookListParams = {}): Promise<WebhookListPage> {
    return requestWebhookPage(this.client, params);
  }

  /**
   * Iterate outbound-webhook pages lazily, typed as `WebhookListPage`.
   * Follows `next_cursor` until it is absent, null or empty. `query` and
   * `limit` are fixed when the iterator is created; `cursor` resumes.
   * See "Pagination" in SDK-REFERENCE.md.
   */
  listPages(
    params: WebhookListParams = {},
    options: PageIterationOptions = {},
  ): PaginatedIterator<WebhookListPage> {
    return iteratePages<WebhookListPage>(webhookListSpec(this.client, params), options);
  }

  /** Iterate outbound webhooks one at a time. See {@link listPages}. */
  listAll(
    params: WebhookListParams = {},
    options: ItemIterationOptions = {},
  ): PaginatedIterator<WebhookSubscription> {
    return iterateItems<WebhookSubscription>(webhookListSpec(this.client, params), options);
  }

  /**
   * Create an outbound destination. Persist the one-shot signing material in
   * the response before discarding it. Receiver-auth credential values are
   * write-only and are never returned by later reads.
   */
  create(input: WebhookSubscriptionInput): Promise<WebhookCreateResponse> {
    return this.client.request("POST", "/api/v1/outbound-webhooks", { body: input });
  }

  update(id: string, patch: WebhookSubscriptionUpdate): Promise<WebhookSubscription> {
    return this.client.request("PATCH", `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`, {
      body: patch,
    });
  }

  delete(id: string, options: { soft?: boolean } = {}): Promise<{ ok?: boolean } | void> {
    return this.client.request("DELETE", `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`, {
      query: options.soft ? { soft: 1 } : undefined,
    });
  }

  /** Sends the canonical `webhook.test` envelope. */
  test(id: string): Promise<WebhookTestResult> {
    return this.client.request("POST", `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/test`);
  }

  deliveriesList(
    id: string,
    params: WebhookDeliveryListParams = {},
  ): Promise<WebhookDeliveryPage> {
    return requestDeliveryPage(this.client, id, params);
  }

  /**
   * Iterate one webhook's delivery pages lazily, typed as
   * `WebhookDeliveryPage`. Follows `next_cursor` until it is absent, null or
   * empty. The webhook id and `limit` are fixed when the iterator is
   * created; `cursor` resumes. An empty id throws immediately.
   * See "Pagination" in SDK-REFERENCE.md.
   */
  deliveriesPages(
    id: string,
    params: WebhookDeliveryListParams = {},
    options: PageIterationOptions = {},
  ): PaginatedIterator<WebhookDeliveryPage> {
    return iteratePages<WebhookDeliveryPage>(deliverySpec(this.client, id, params), options);
  }

  /** Iterate one webhook's deliveries one at a time. See {@link deliveriesPages}. */
  deliveriesAll(
    id: string,
    params: WebhookDeliveryListParams = {},
    options: ItemIterationOptions = {},
  ): PaginatedIterator<WebhookDelivery> {
    return iterateItems<WebhookDelivery>(deliverySpec(this.client, id, params), options);
  }

  async deliveries(id: string): Promise<WebhookDelivery[]> {
    return (await this.deliveriesList(id)).deliveries;
  }

  /**
   * Creates a new pending child delivery and leaves the original immutable.
   * Reuse idempotencyKey when retrying this logical replay across processes.
   */
  replay(deliveryId: string, idempotencyKey?: string): Promise<WebhookReplayResponse> {
    return this.client.request(
      "POST",
      `/api/v1/outbound-webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      { ...(idempotencyKey ? { idempotencyKey } : {}) },
    );
  }

  rotateSecret(id: string, graceMinutes = 1440): Promise<WebhookCreateResponse> {
    return this.client.request(
      "POST",
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/rotate-secret`,
      { query: { grace_minutes: graceMinutes } },
    );
  }

  verifySignature(
    rawBody: string | Uint8Array,
    header: string | null | undefined,
    secret: string,
    options?: { now?: Date | number; toleranceSeconds?: number },
  ): Promise<boolean> {
    return _verifySignature(rawBody, header, secret, options);
  }
}

/** The one definition of `GET /api/v1/outbound-webhooks`, for both paths. */
function requestWebhookPage(
  client: PostwaveClient,
  params: WebhookListParams,
  signal?: AbortSignal,
): Promise<WebhookListPage> {
  return client.request("GET", "/api/v1/outbound-webhooks", {
    query: params as Record<string, string | number | undefined>,
    ...(signal ? { signal } : {}),
  });
}

/** The one definition of the deliveries route, for both paths. */
function requestDeliveryPage(
  client: PostwaveClient,
  id: string,
  params: WebhookDeliveryListParams,
  signal?: AbortSignal,
): Promise<WebhookDeliveryPage> {
  return client.request(
    "GET",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/deliveries`,
    { query: params as Record<string, number | string | undefined>, ...(signal ? { signal } : {}) },
  );
}

function webhookListSpec(client: PostwaveClient, params: WebhookListParams): PaginationSpec {
  const operation = "webhooks.list";
  const { cursor, ...filters } = snapshotParams(operation, params);
  checkPageSize(operation, "limit", filters.limit);
  const start = checkStartCursor(operation, cursor);
  return {
    operation,
    itemsKey: "webhooks",
    cursorKey: "next_cursor",
    start: start === undefined ? {} : { cursor: start },
    fetch: (continuation, signal) =>
      requestWebhookPage(client, { ...filters, ...continuation }, signal),
  };
}

function deliverySpec(
  client: PostwaveClient,
  id: string,
  params: WebhookDeliveryListParams,
): PaginationSpec {
  const operation = "webhooks.deliveriesList";
  if (typeof id !== "string" || !id.trim()) throw new Error("Webhook ID is required");
  const { cursor, ...filters } = snapshotParams(operation, params);
  checkPageSize(operation, "limit", filters.limit);
  const start = checkStartCursor(operation, cursor);
  return {
    operation,
    itemsKey: "deliveries",
    cursorKey: "next_cursor",
    start: start === undefined ? {} : { cursor: start },
    fetch: (continuation, signal) =>
      requestDeliveryPage(client, id, { ...filters, ...continuation }, signal),
  };
}
