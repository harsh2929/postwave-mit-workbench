// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import type { Campaign } from "./campaigns.js";
import { MAX_TIMER_DELAY_MS } from "../lib/lifecycle.js";
import { pollUntilTerminal } from "../lib/polling.js";

/** Visual campaign templates are concrete, editable HTML/MJML designs. */
export type CampaignTemplateGoal =
  | "welcome"
  | "newsletter"
  | "announcement"
  | "promotional"
  | "re_engagement"
  | "transactional"
  | "automation";

export type CampaignTemplateOwnershipSource =
  | "all"
  | "platform"
  | "mine"
  | "team";

/** Ownership source or an external provider slug such as `reallygoodemails`. */
export type CampaignTemplateSource =
  | CampaignTemplateOwnershipSource
  | (string & {});

export type CampaignTemplateKind = "editable" | "reference";
export type CampaignTemplateReviewStatus = "pending" | "approved" | "rejected";
export type CampaignTemplateRecommendedAction =
  | "campaign_template_adapt"
  | "campaign_create_from_template"
  | "campaign_template_update"
  | "campaign_template_archive"
  | "campaign_template_restore"
  | "request_review"
  | "request_access"
  | "none";

export interface CampaignTemplateCapabilities {
  can_preview: boolean;
  can_favorite: boolean;
  can_adapt: boolean;
  can_use_directly: boolean;
  can_edit_directly: boolean;
  can_create_campaign: boolean;
  can_clone: boolean;
  /** Compatibility alias for recoverable archival; no hard delete occurs. */
  can_delete: boolean;
  can_archive: boolean;
  can_restore: boolean;
  has_source_html: boolean;
  has_source_mjml: boolean;
  has_desktop_preview: boolean;
  has_mobile_preview: boolean;
  preview_kind?: "html" | "screenshot" | "metadata";
}

export interface CampaignTemplateWarning {
  code: string;
  message: string;
  recommended_action?: string;
}

export interface CampaignTemplateVariable {
  key?: string;
  name?: string;
  label?: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  example?: unknown;
  [key: string]: unknown;
}

/** Sanitized immutable preview image hosted on Moosewave's asset CDN. */
export interface CampaignTemplatePreviewAsset {
  variant: "desktop" | "mobile" | "card";
  url: string;
  mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
  size_bytes: number;
  status: "ready" | "source_missing";
}

/**
 * A visual template as returned by the campaign-template API. Unlike the
 * voice/sequence Template type, this object contains email-safe design source.
 */
export interface CampaignTemplate {
  id: string;
  tenant_id?: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  goal?: CampaignTemplateGoal | string;
  subject: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables: CampaignTemplateVariable[];
  tags: string[];
  style?: string;
  layout?: string;
  industry?: string;
  template_kind?: CampaignTemplateKind;
  thumbnail_url?: string;
  preview_url?: string;
  source_provider?: string;
  source_external_id?: string;
  source_url?: string;
  source_brand?: string;
  source_captured_at?: string | null;
  source_license_status?: string;
  source_metadata?: Record<string, unknown>;
  design_metadata?: Record<string, unknown>;
  review_status?: CampaignTemplateReviewStatus;
  quality_score?: number;
  content_hash?: string;
  imported_at?: string | null;
  reference_template_ids?: string[];
  generation_metadata?: Record<string, unknown>;
  /** Immutable governance receipt currently authorizing this reference. */
  reference_review_decision_id?: string;
  reference_reviewed_at?: string;
  /** Sanitized Moosewave-hosted previews; provider URLs are never proxied. */
  preview_assets: CampaignTemplatePreviewAsset[];
  /** Monotonic editable-template revision used by optimistic concurrency. */
  version: number;
  /** Exact strong entity tag to echo in `If-Match` on lifecycle mutations. */
  etag: string;
  /** Present only while this recoverable template is archived. */
  archived_at?: string | null;
  capabilities: CampaignTemplateCapabilities;
  recommended_action: CampaignTemplateRecommendedAction | string;
  warnings: CampaignTemplateWarning[];
  is_featured?: boolean;
  is_favorited?: boolean;
  usage_count?: number;
  last_used_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** Compact search row; source bodies are intentionally fetched via get(). */
export type CampaignTemplateSummary = Omit<
  CampaignTemplate,
  "body_html" | "body_mjml" | "variables"
> & {
  variables?: CampaignTemplateVariable[];
};

export interface CampaignTemplateSearchParams {
  /** Full-text query over template name, subject, description, and tags. */
  q?: string;
  goal?: CampaignTemplateGoal;
  category?: string;
  source?: CampaignTemplateSource;
  provider?: string;
  style?: string;
  layout?: string;
  industry?: string;
  kind?: CampaignTemplateKind;
  tags?: string[];
  featured?: boolean;
  /** When true, return only the calling user's favorites. False means no filter. */
  favorited?: boolean;
  archived?: "active" | "archived" | "all";
  sort?: "recommended" | "name" | "most_used";
  /** Opaque continuation token returned by a prior search. */
  cursor?: string;
  /** Deprecated offset page; prefer cursor for stable continuation. */
  page?: number;
  per_page?: number;
}

export interface CampaignTemplateSearchResponse {
  items: CampaignTemplateSummary[];
  total: number;
  page: number;
  per_page: number;
  has_more?: boolean;
  next_cursor?: string;
  facets?: CampaignTemplateCatalogFacets;
}

export interface CampaignTemplateRecentView {
  template: CampaignTemplateSummary;
  view_count: number;
  first_viewed_at: string;
  last_viewed_at: string;
}

export interface CampaignTemplateCollection {
  id: string;
  name: string;
  description: string;
  template_ids: string[];
  items?: CampaignTemplateSummary[];
  item_count: number;
  created_at: string;
  updated_at: string;
  /** Monotonic personal-collection revision used by optimistic concurrency. */
  version: number;
  /** Exact strong entity tag required by update, reorder, and delete. */
  etag: string;
}

export interface CampaignTemplateSavedSearchFilters {
  q?: string;
  goal?: CampaignTemplateGoal;
  category?: string;
  source?: CampaignTemplateSource;
  provider?: string;
  style?: string;
  layout?: string;
  industry?: string;
  kind?: CampaignTemplateKind;
  tags?: string[];
  featured?: boolean;
  favorited?: boolean;
  archived?: "active" | "archived" | "all";
  sort?: "recommended" | "name" | "most_used";
}

export interface CampaignTemplateSavedSearch {
  id: string;
  name: string;
  filters: CampaignTemplateSavedSearchFilters;
  /**
   * Persisted taxonomy values absent from the complete authoritative visible
   * catalog. Remove or replace them through updateSavedSearch with this
   * entity's exact current etag; the server never silently broadens the query.
   */
  obsolete_filters: CampaignTemplateSavedSearchObsoleteFilter[];
  created_at: string;
  updated_at: string;
  /** Monotonic saved-search revision used by optimistic concurrency. */
  version: number;
  /** Exact strong entity tag required by update and delete. */
  etag: string;
}

export interface CampaignTemplateSavedSearchObsoleteFilter {
  field:
    | "goal"
    | "category"
    | "source"
    | "provider"
    | "industry"
    | "style"
    | "layout"
    | "kind"
    | "tags"
    | "archived"
    | "sort";
  /** Exact persisted value to remove or replace. */
  value: string;
}

export interface CampaignTemplateCompareItem {
  requested_identifier: string;
  matched_by: "id" | "slug";
  template: CampaignTemplateSummary;
}

export interface CampaignTemplateCompareResponse {
  /** Available templates in their relative requested order. */
  items: CampaignTemplateCompareItem[];
  /**
   * Exact requested IDs/slugs that are missing, inaccessible, rejected, or
   * archived, in their original request order.
   */
  unavailable_identifiers: string[];
}

export interface CampaignTemplateFacetValue {
  value: string;
  count: number;
}

export interface CampaignTemplateCatalogFacets {
  goals: CampaignTemplateFacetValue[];
  categories: CampaignTemplateFacetValue[];
  providers: CampaignTemplateFacetValue[];
  industries: CampaignTemplateFacetValue[];
  styles: CampaignTemplateFacetValue[];
  layouts: CampaignTemplateFacetValue[];
  tags: CampaignTemplateFacetValue[];
}

export interface CreateCampaignTemplateInput {
  /** Lowercase alphanumeric and dashes; max 80 characters. */
  slug: string;
  name: string;
  description?: string;
  category?: string;
  goal?: CampaignTemplateGoal;
  subject: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables?: CampaignTemplateVariable[];
  tags?: string[];
  style?: string;
  layout?: string;
  industry?: string;
  thumbnail_url?: string;
  design_metadata?: Record<string, unknown>;
}

export interface UpdateCampaignTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  goal?: CampaignTemplateGoal;
  subject?: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables?: CampaignTemplateVariable[];
  tags?: string[];
  industry?: string;
  style?: string;
  layout?: string;
  thumbnail_url?: string;
  design_metadata?: Record<string, unknown>;
}

export interface CloneCampaignTemplateInput {
  name?: string;
  slug?: string;
}

export type CampaignTemplateRevisionTransition =
  | "baseline"
  | "create"
  | "update"
  | "archive"
  | "restore"
  | (string & {});

/** Compact immutable history row; fetch the selected snapshot separately. */
export interface CampaignTemplateRevisionSummary {
  version: number;
  etag: string;
  transition: CampaignTemplateRevisionTransition;
  name: string;
  subject: string;
  archived_at?: string | null;
  snapshot_time: string;
}

export interface CampaignTemplateRevisionPage {
  items: CampaignTemplateRevisionSummary[];
  page: number;
  per_page: number;
  total: number;
}

export interface CampaignTemplateRevision {
  version: number;
  etag: string;
  transition: CampaignTemplateRevisionTransition;
  snapshot_time: string;
  snapshot: CampaignTemplate;
}

export interface CampaignTemplateRevisionListParams {
  page?: number;
  per_page?: number;
}

export interface AdaptCampaignTemplateInput {
  /** Natural-language changes to make to the selected design. */
  instructions?: string;
  /** Optional voice direction for generated copy. */
  tone?: string;
  /** How closely to retain the reference's broad visual structure. */
  fidelity?: "close" | "balanced" | "inspired";
  /** Override the generated or source subject. */
  subject?: string;
  /** Structured newsletter copy, links, sections, and image choices. */
  content?: Record<string, unknown>;
  /** Workspace or one-off brand tokens such as colors, logo, and typography. */
  brand?: Record<string, unknown>;
  /** Values for the source template's declared variables. */
  variables?: Record<string, unknown>;
  /** Up to two additional designs to use as visual references. */
  reference_template_ids?: string[];
  name?: string;
  preview_text?: string;
  audience?: string;
  industry?: string;
  style?: string;
  layout?: string;
  sections?: string[];
  cta?: string;
}

export interface GenerateCampaignTemplateInput {
  /** Description of the newsletter and the desired visual direction. */
  brief: string;
  kind?: "newsletter" | "promo" | "announcement";
  tone?: string;
  fidelity?: "close" | "balanced" | "inspired";
  name?: string;
  goal?: CampaignTemplateGoal;
  category?: string;
  subject?: string;
  preview_text?: string;
  audience?: string;
  style?: string;
  layout?: string;
  industry?: string;
  brand?: Record<string, unknown>;
  content?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  sections?: string[];
  cta?: string;
  /** One to three internal templates whose design language should guide generation. */
  reference_template_ids?: string[];
}

export type CampaignTemplateDesignMode = "adapt" | "generate";
export type CampaignTemplateDesignStatus =
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "saved"
  | "campaign_created"
  | "archived";

export interface CreateCampaignTemplateDesignInput extends Omit<
  GenerateCampaignTemplateInput,
  "brief"
> {
  mode: CampaignTemplateDesignMode;
  source_template_id?: string;
  brief?: string;
  instructions?: string;
}

export interface CampaignTemplateDesignOutput {
  name: string;
  subject: string;
  preview_text?: string;
  body_html: string;
  body_mjml?: string;
  variables?: Record<string, unknown>;
  unresolved_variables: string[];
  reference_template_ids: string[];
  warnings: string[];
}

export interface CampaignTemplateDesignValidationCheck {
  code: string;
  status: "pass" | "warn" | "fail";
  message: string;
  repaired?: boolean;
}

export interface CampaignTemplateDesignValidation {
  status: "pass" | "warn" | "fail";
  checks: CampaignTemplateDesignValidationCheck[];
}

export interface CampaignTemplateDesignRevision {
  id: string;
  draft_id: string;
  revision: number;
  operation: "initial" | "refine" | "repair";
  base_revision?: number;
  output: CampaignTemplateDesignOutput;
  output_hash: string;
  validation: CampaignTemplateDesignValidation;
  warnings: CampaignTemplateWarning[];
  created_at: string;
}

export interface CampaignTemplateDesignCapabilities {
  can_refine: boolean;
  can_retry: boolean;
  can_save: boolean;
  can_create_campaign: boolean;
  can_archive: boolean;
}

export type CampaignTemplateDesignRecoveryStatus = Exclude<
  CampaignTemplateDesignStatus,
  "archived"
>;

export type CampaignTemplateDesignRecommendedAction =
  | "none"
  | "poll_campaign_template_design"
  | "review_campaign_template_design"
  | "retry_campaign_template_design"
  | "use_saved_campaign_template"
  | "open_campaign_draft"
  | "get_campaign_template_design";

/**
 * Compact recovery row for a design owned by the exact authenticated actor.
 * Generated output and the original request are intentionally available only
 * through {@link CampaignTemplatesResource.getDesign}.
 */
export interface CampaignTemplateDesignSummary {
  id: string;
  mode: CampaignTemplateDesignMode;
  status: CampaignTemplateDesignRecoveryStatus;
  source_template_id?: string;
  current_revision: number;
  attempt_count: number;
  last_error_code?: string;
  last_error_message?: string;
  saved_template_id?: string;
  saved_revision?: number;
  created_campaign_id?: string;
  campaign_revision?: number;
  capabilities: CampaignTemplateDesignCapabilities;
  recommended_action: CampaignTemplateDesignRecommendedAction;
  retry_after_seconds?: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignTemplateDesignPage {
  items: CampaignTemplateDesignSummary[];
  next_cursor?: string;
}

export interface CampaignTemplateDesignListParams {
  /** Server page size. Defaults to 20; valid values are 1 through 50. */
  limit?: number;
  /** Opaque, actor-bound continuation cursor returned by the previous page. */
  cursor?: string;
}

export interface CampaignTemplateDesignDraft {
  id: string;
  mode: CampaignTemplateDesignMode;
  status: CampaignTemplateDesignStatus;
  source_template_id?: string;
  reference_template_ids: string[];
  current_revision: number;
  revision?: CampaignTemplateDesignRevision;
  attempt_count: number;
  last_error_code?: string;
  last_error_message?: string;
  saved_template_id?: string;
  saved_revision?: number;
  created_campaign_id?: string;
  campaign_revision?: number;
  capabilities: CampaignTemplateDesignCapabilities;
  recommended_action: CampaignTemplateDesignRecommendedAction;
  retry_after_seconds?: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  request: CreateCampaignTemplateDesignInput;
}

export interface RefineCampaignTemplateDesignInput {
  instructions: string;
  base_revision: number;
}

export interface CommitCampaignTemplateDesignInput {
  revision: number;
  output_hash: string;
}

export interface SaveCampaignTemplateDesignInput extends CommitCampaignTemplateDesignInput {
  slug: string;
  name?: string;
  subject?: string;
  preview_text?: string;
}

export interface CreateCampaignFromDesignInput extends CommitCampaignTemplateDesignInput {
  name?: string;
  subject?: string;
  preview_text?: string;
  variables?: Record<string, unknown>;
  segment_id?: string;
  list_id?: number | string;
}

export interface CampaignTemplateDesignMutationOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface WaitForCampaignTemplateDesignOptions {
  /**
   * Cancel the wait at any point, including mid-poll and during the delay.
   * Rejects with `RequestAbortedError` (the abort reason is its `payload`);
   * an already-aborted signal sends no request.
   */
  signal?: AbortSignal;
  /**
   * Wait deadline in ms. Default 120000, minimum 1000. It bounds the whole
   * wait: in-flight polls, their body reads and the delays between polls.
   * Expiry rejects with `TimeoutError` (`scope: "wait"`). Non-finite values
   * fall back to the default.
   *
   * The SDK imposes no maximum of its own. Unlike the 30-minute cap on
   * `sequences.waitForJob()`/`voiceProfile.waitForIngestJob()`, there is no
   * application-level cap here. The runtime timer limit still applies: values
   * above 2^31-1 ms (about 24.8 days) are clamped to it.
   */
  timeoutMs?: number;
  /**
   * Minimum delay between polls in ms. Default 1000, minimum 250. The actual
   * delay is `max(pollIntervalMs, retry_after_seconds * 1000)`, so a longer
   * server hint on the draft (given in seconds) is honoured instead.
   * Non-finite values fall back to the default. The delay is clamped to the
   * runtime timer limit (2^31-1 ms), and the wait deadline cuts it short
   * anyway.
   */
  pollIntervalMs?: number;
}

export interface CreateCampaignFromTemplateInput {
  /** The template's UUID or its slug (for example `welcome-negative-promise`). */
  template_id: string;
  name?: string;
  subject?: string;
  preview_text?: string;
  variables?: Record<string, unknown>;
  content?: Record<string, unknown>;
  brand?: Record<string, unknown>;
  segment_id?: string;
  /** Positive Listmonk list ID, as a number or decimal digit string. */
  list_id?: number | string;
}

/**
 * The draft campaign, plus the merge tags in it that nothing filled: content
 * variables with no value, workspace tokens the workspace has no setting for
 * (`reply_to_email` before a default reply-to address is saved), and
 * subscriber tags with no fallback in the subject or preview text. Fill each
 * before sending; empty when the draft is complete.
 */
export type CampaignFromTemplateResult = Campaign & {
  unresolved_variables: string[];
};

/**
 * Concrete newsletter/campaign designs. This resource is deliberately
 * separate from `client.templates`, which remains the voice-sequence library.
 */
export class CampaignTemplatesResource extends Resource {
  list(params: CampaignTemplateSearchParams = {}): Promise<CampaignTemplate[]> {
    return this.client.request("GET", "/api/v1/campaign-templates", {
      query: searchQuery(params),
    });
  }

  search(
    params: CampaignTemplateSearchParams = {},
  ): Promise<CampaignTemplateSearchResponse> {
    return this.client.request("GET", "/api/v1/campaign-templates/search", {
      query: searchQuery(params),
    });
  }

  get(id: string): Promise<CampaignTemplate> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
    );
  }

  favorite(id: string): Promise<{ ok: boolean; favorited: true }> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/favorite`,
      { body: {} },
    );
  }

  unfavorite(id: string): Promise<{ ok: boolean; favorited: false }> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/unfavorite`,
      { body: {} },
    );
  }

  compare(identifiers: string[]): Promise<CampaignTemplateCompareResponse> {
    return this.client.request("GET", "/api/v1/campaign-templates/compare", {
      query: { templates: identifiers.join(",") },
    });
  }

  recordView(id: string): Promise<CampaignTemplateRecentView> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/view`,
      { body: {} },
    );
  }

  recent(limit?: number): Promise<{ items: CampaignTemplateRecentView[] }> {
    return this.client.request("GET", "/api/v1/campaign-templates/recent", {
      query: { limit },
    });
  }

  clearRecent(id?: string): Promise<{ ok: boolean; cleared: number }> {
    return this.client.request(
      "DELETE",
      id
        ? `/api/v1/campaign-templates/recent/${encodeURIComponent(id)}`
        : "/api/v1/campaign-templates/recent",
    );
  }

  listCollections(): Promise<{ items: CampaignTemplateCollection[] }> {
    return this.client.request("GET", "/api/v1/campaign-template-collections");
  }

  getCollection(id: string): Promise<CampaignTemplateCollection> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
    );
  }

  createCollection(
    input: {
      name: string;
      description?: string;
      template_ids?: string[];
    },
    idempotencyKey: string,
  ): Promise<CampaignTemplateCollection> {
    return this.client.request(
      "POST",
      "/api/v1/campaign-template-collections",
      {
        body: input,
        idempotencyKey: campaignTemplateDiscoveryIdempotencyKey(idempotencyKey),
      },
    );
  }

  updateCollection(
    id: string,
    input: { name?: string; description?: string },
    ifMatch: string,
  ): Promise<CampaignTemplateCollection> {
    return this.client.request(
      "PATCH",
      `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
      {
        body: input,
        headers: {
          "If-Match": campaignTemplateDiscoveryIfMatch(
            ifMatch,
            "campaign-template-collection",
            id,
          ),
        },
      },
    );
  }

  replaceCollectionItems(
    id: string,
    templateIds: string[],
    ifMatch: string,
  ): Promise<CampaignTemplateCollection> {
    return this.client.request(
      "PUT",
      `/api/v1/campaign-template-collections/${encodeURIComponent(id)}/items`,
      {
        body: { template_ids: templateIds },
        headers: {
          "If-Match": campaignTemplateDiscoveryIfMatch(
            ifMatch,
            "campaign-template-collection",
            id,
          ),
        },
      },
    );
  }

  deleteCollection(
    id: string,
    ifMatch: string,
  ): Promise<{ ok: boolean; deleted: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/campaign-template-collections/${encodeURIComponent(id)}`,
      {
        headers: {
          "If-Match": campaignTemplateDiscoveryIfMatch(
            ifMatch,
            "campaign-template-collection",
            id,
          ),
        },
      },
    );
  }

  listSavedSearches(): Promise<{ items: CampaignTemplateSavedSearch[] }> {
    return this.client.request(
      "GET",
      "/api/v1/campaign-template-saved-searches",
    );
  }

  getSavedSearch(id: string): Promise<CampaignTemplateSavedSearch> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
    );
  }

  createSavedSearch(
    input: {
      name: string;
      filters: CampaignTemplateSavedSearchFilters;
    },
    idempotencyKey: string,
  ): Promise<CampaignTemplateSavedSearch> {
    return this.client.request(
      "POST",
      "/api/v1/campaign-template-saved-searches",
      {
        body: input,
        idempotencyKey: campaignTemplateDiscoveryIdempotencyKey(idempotencyKey),
      },
    );
  }

  updateSavedSearch(
    id: string,
    input: { name?: string; filters?: CampaignTemplateSavedSearchFilters },
    ifMatch: string,
  ): Promise<CampaignTemplateSavedSearch> {
    return this.client.request(
      "PATCH",
      `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
      {
        body: input,
        headers: {
          "If-Match": campaignTemplateDiscoveryIfMatch(
            ifMatch,
            "campaign-template-saved-search",
            id,
          ),
        },
      },
    );
  }

  deleteSavedSearch(
    id: string,
    ifMatch: string,
  ): Promise<{ ok: boolean; deleted: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}`,
      {
        headers: {
          "If-Match": campaignTemplateDiscoveryIfMatch(
            ifMatch,
            "campaign-template-saved-search",
            id,
          ),
        },
      },
    );
  }

  savedSearchResults(
    id: string,
    params: { cursor?: string; per_page?: number } = {},
  ): Promise<CampaignTemplateSearchResponse> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-template-saved-searches/${encodeURIComponent(id)}/results`,
      { query: params },
    );
  }

  create(input: CreateCampaignTemplateInput): Promise<CampaignTemplate> {
    return this.client.request("POST", "/api/v1/campaign-templates", {
      body: input,
    });
  }

  update(
    id: string,
    patch: UpdateCampaignTemplateInput,
    ifMatch: string,
  ): Promise<CampaignTemplate> {
    return this.client.request(
      "PATCH",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
      {
        body: patch,
        headers: { "If-Match": campaignTemplateIfMatch(ifMatch) },
      },
    );
  }

  archive(id: string, ifMatch: string): Promise<CampaignTemplate> {
    return this.client.request(
      "PATCH",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/archive`,
      { headers: { "If-Match": campaignTemplateIfMatch(ifMatch) } },
    );
  }

  restore(id: string, ifMatch: string): Promise<CampaignTemplate> {
    return this.client.request(
      "PATCH",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/restore`,
      { headers: { "If-Match": campaignTemplateIfMatch(ifMatch) } },
    );
  }

  /**
   * @deprecated This compatibility endpoint archives the template; it never
   * permanently deletes it. Prefer `archive(id, ifMatch)`.
   */
  delete(id: string, ifMatch: string): Promise<CampaignTemplate> {
    return this.client.request(
      "DELETE",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
      { headers: { "If-Match": campaignTemplateIfMatch(ifMatch) } },
    );
  }

  listRevisions(
    id: string,
    params: CampaignTemplateRevisionListParams = {},
  ): Promise<CampaignTemplateRevisionPage> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions`,
      { query: { page: params.page, per_page: params.per_page } },
    );
  }

  getRevision(id: string, version: number): Promise<CampaignTemplateRevision> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions/${campaignTemplateRevisionPathSegment(version)}`,
    );
  }

  clone(
    id: string,
    input: CloneCampaignTemplateInput = {},
  ): Promise<CampaignTemplate> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/clone`,
      { body: input },
    );
  }

  adapt(
    id: string,
    input: AdaptCampaignTemplateInput,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    return this.createDesign(
      {
        ...input,
        mode: "adapt",
        source_template_id: id,
      },
      options,
    );
  }

  generate(
    input: GenerateCampaignTemplateInput,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    return this.createDesign({ ...input, mode: "generate" }, options);
  }

  createDesign(
    input: CreateCampaignTemplateDesignInput,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    return this.client.request("POST", "/api/v1/campaign-template-designs", {
      body: input,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  /**
   * Recover active durable design jobs created by the exact authenticated
   * tenant and actor, newest first. The server excludes archived and expired
   * work and binds every continuation cursor to that same actor.
   */
  listDesigns(
    params: CampaignTemplateDesignListParams = {},
  ): Promise<CampaignTemplateDesignPage> {
    return this.client.request("GET", "/api/v1/campaign-template-designs", {
      query: campaignTemplateDesignListQuery(params),
    });
  }

  getDesign(
    id: string,
    signal?: AbortSignal,
  ): Promise<CampaignTemplateDesignDraft> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  listDesignRevisions(
    id: string,
  ): Promise<{ items: CampaignTemplateDesignRevision[] }> {
    return this.client.request(
      "GET",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/revisions`,
    );
  }

  refineDesign(
    id: string,
    input: RefineCampaignTemplateDesignInput,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/refine`,
      {
        body: input,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  retryDesign(
    id: string,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/retry`,
      {
        body: {},
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  saveDesign(
    id: string,
    input: SaveCampaignTemplateDesignInput,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplate> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/save`,
      {
        body: input,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  createCampaignFromDesign(
    id: string,
    input: CreateCampaignFromDesignInput,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<Campaign> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/create-campaign`,
      {
        body: input,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  archiveDesign(
    id: string,
    options: CampaignTemplateDesignMutationOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    return this.client.request(
      "POST",
      `/api/v1/campaign-template-designs/${encodeURIComponent(id)}/archive`,
      {
        body: {},
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      },
    );
  }

  /**
   * Poll `getDesign(id)` until the draft leaves `queued`/`generating`, and
   * resolve with it. Any other status, including `failed`, is returned, not
   * thrown. Between polls it waits `max(pollIntervalMs, retry_after_seconds * 1000)`
   * milliseconds (`retry_after_seconds` is the server hint, in seconds).
   *
   * Shares the lifecycle of `sequences.waitForJob()`: the deadline and
   * `signal` bound in-flight polls, body reads and delays, are checked against
   * a monotonic clock, and release their timers and listeners on every exit.
   * Errors from a poll itself (e.g. `NotFoundError`) propagate unchanged.
   */
  waitForDesign(
    id: string,
    options: WaitForCampaignTemplateDesignOptions = {},
  ): Promise<CampaignTemplateDesignDraft> {
    const timeoutMs = normalizeDesignWaitTimeout(options.timeoutMs);
    const pollIntervalMs = normalizeDesignPollInterval(options.pollIntervalMs);
    return pollUntilTerminal({
      label: `campaignTemplates.waitForDesign(${id})`,
      timeoutMessage: `Campaign template design ${id} did not finish within ${timeoutMs}ms`,
      intervalMs: pollIntervalMs,
      timeoutMs,
      signal: options.signal,
      poll: (signal) => this.getDesign(id, signal),
      isTerminal: (draft) =>
        draft.status !== "queued" && draft.status !== "generating",
      nextDelayMs: (draft) =>
        designPollDelay(pollIntervalMs, draft.retry_after_seconds),
    });
  }

  createCampaign(
    input: CreateCampaignFromTemplateInput,
  ): Promise<CampaignFromTemplateResult> {
    return this.client.request("POST", "/api/v1/campaigns/from-template", {
      body: input,
    });
  }
}

/**
 * waitForDesign option normalisation. Valid values behave as before: the same
 * defaults and floors, no SDK-imposed maximum, and numeric strings still
 * coerce. What changes:
 * - NaN and Infinity take the default. NaN/Infinity `timeoutMs` meant the
 *   wait could never time out, and a NaN interval re-polled almost at once.
 * - Everything is clamped to the runtime timer limit (2^31-1 ms), the only
 *   upper bound. The deadline is now a timer, and a longer delay would make
 *   setTimeout fire after ~1ms. A `timeoutMs` above the limit was
 *   previously honoured in full (the old deadline was wall-clock arithmetic,
 *   not a timer), so it now ends after ~24.8 days instead. An oversized
 *   interval previously overflowed the delay timer and re-polled almost
 *   immediately.
 */
function normalizeDesignWaitTimeout(value: number | undefined): number {
  return normalizeDesignDuration(value, 120_000, 1_000);
}

function normalizeDesignPollInterval(value: number | undefined): number {
  return normalizeDesignDuration(value, 1_000, 250);
}

function normalizeDesignDuration(
  value: number | undefined,
  fallback: number,
  floor: number,
): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(floor, n), MAX_TIMER_DELAY_MS);
}

/**
 * max(intervalMs, retry_after_seconds * 1000), as before (the hint is in
 * seconds, the interval in milliseconds). A hint that is not a positive finite
 * number (negative, non-numeric) is ignored rather than producing NaN, which
 * made the old loop re-poll almost immediately. Numeric strings still coerce.
 */
function designPollDelay(intervalMs: number, retryAfterSeconds: unknown): number {
  const hint = Number(retryAfterSeconds ?? 0);
  const hintMs = Number.isFinite(hint) && hint > 0 ? hint * 1_000 : 0;
  return Math.min(Math.max(intervalMs, hintMs), MAX_TIMER_DELAY_MS);
}

function campaignTemplateIfMatch(value: string): string {
  if (!/^"[^"\r\n]+"$/.test(value)) {
    throw new Error(
      "Campaign template ifMatch must be the exact strong etag returned by the API",
    );
  }
  return value;
}

function campaignTemplateDiscoveryIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized === "" ||
    new TextEncoder().encode(normalized).length > 255 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(
      "Campaign template discovery idempotencyKey must be 1-255 UTF-8 bytes without control characters",
    );
  }
  // The server owns normalization. Preserve the caller-held token byte-for-byte
  // so an uncertain cross-process retry reaches the original durable create.
  return value;
}

function campaignTemplateDiscoveryIfMatch(
  value: string,
  resource: "campaign-template-collection" | "campaign-template-saved-search",
  id: string,
): string {
  const match =
    /^"(campaign-template-collection|campaign-template-saved-search):([^"\\\s,]+):v([1-9]\d*)"$/.exec(
      value,
    );
  if (
    !match ||
    match[1] !== resource ||
    match[2] !== id ||
    value.trim() !== value
  ) {
    throw new Error(
      `Campaign template discovery ifMatch must be the exact current ${resource} etag returned by the API`,
    );
  }
  return value;
}

function campaignTemplateRevisionPathSegment(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(
      "Campaign template revision version must be a positive safe integer",
    );
  }
  return String(version);
}

function campaignTemplateDesignListQuery(
  params: CampaignTemplateDesignListParams,
): { limit?: number; cursor?: string } {
  const { limit, cursor } = params;
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 50)
  ) {
    throw new RangeError(
      "Campaign template design list limit must be an integer between 1 and 50",
    );
  }
  if (cursor !== undefined) {
    if (typeof cursor !== "string") {
      throw new TypeError(
        "Campaign template design list cursor must be a string",
      );
    }
    if (
      cursor !== cursor.trim() ||
      new TextEncoder().encode(cursor).length > 1_024
    ) {
      throw new RangeError(
        "Campaign template design list cursor must be unchanged and at most 1024 UTF-8 bytes",
      );
    }
  }
  return { limit, cursor };
}

function searchQuery(
  params: CampaignTemplateSearchParams,
): Record<string, string | number | boolean | undefined> {
  return {
    q: params.q,
    goal: params.goal,
    category: params.category,
    source: params.source,
    provider: params.provider,
    style: params.style,
    layout: params.layout,
    industry: params.industry,
    kind: params.kind,
    tags: params.tags?.join(","),
    featured: params.featured,
    favorited: params.favorited,
    archived: params.archived,
    sort: params.sort,
    cursor: params.cursor,
    page: params.page,
    per_page: params.per_page,
  };
}
