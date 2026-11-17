// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type { PostwaveClient } from "../client.js";
import {
  checkStartCursor,
  iterateItems,
  iteratePages,
  snapshotParams,
  type ItemIterationOptions,
  type PageIterationOptions,
  type PaginatedIterator,
  type PaginationSpec,
} from "../lib/pagination.js";

export interface AuditEntry {
  id: string;
  tenant_id: string;
  actor_type: string;
  actor_label: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

export interface AuditQueryParams {
  actor_type?: string;
  actor_label?: string;
  action?: string;
  resource_type?: string;
  since?: string;
  cursor?: string;
}

export interface AuditQueryResponse {
  items: AuditEntry[];
  next_cursor?: string | null;
}

export class AuditResource extends Resource {
  query(params: AuditQueryParams = {}): Promise<AuditQueryResponse> {
    return requestAuditPage(this.client, params);
  }

  /**
   * Iterate audit pages lazily, typed as `AuditQueryResponse`. Follows
   * `next_cursor` until it is absent, null or empty. The filters
   * (`actor_type`, `actor_label`, `action`, `resource_type`, `since`) are
   * fixed when the iterator is created; `cursor` resumes.
   * See "Pagination" in SDK-REFERENCE.md.
   */
  queryPages(
    params: AuditQueryParams = {},
    options: PageIterationOptions = {},
  ): PaginatedIterator<AuditQueryResponse> {
    return iteratePages<AuditQueryResponse>(
      auditSpec(this.client, params),
      options,
    );
  }

  /** Iterate audit entries one at a time. See {@link queryPages}. */
  queryAll(
    params: AuditQueryParams = {},
    options: ItemIterationOptions = {},
  ): PaginatedIterator<AuditEntry> {
    return iterateItems<AuditEntry>(auditSpec(this.client, params), options);
  }
}

/** The one definition of `GET /api/v1/audit`, for both paths. */
function requestAuditPage(
  client: PostwaveClient,
  params: AuditQueryParams,
  signal?: AbortSignal,
): Promise<AuditQueryResponse> {
  return client.request("GET", "/api/v1/audit", {
    query: params as Record<string, string | undefined>,
    ...(signal ? { signal } : {}),
  });
}

function auditSpec(
  client: PostwaveClient,
  params: AuditQueryParams,
): PaginationSpec {
  const operation = "audit.query";
  const { cursor, ...filters } = snapshotParams(operation, params);
  const start = checkStartCursor(operation, cursor);
  return {
    operation,
    itemsKey: "items",
    cursorKey: "next_cursor",
    start: start === undefined ? {} : { cursor: start },
    fetch: (continuation, signal) =>
      requestAuditPage(client, { ...filters, ...continuation }, signal),
  };
}
