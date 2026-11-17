# @postwave/sdk

First-party TypeScript SDK for the [Moosewave](https://moosewave.com) API.
MIT licensed as Layer 2 of the Moosewave open-core architecture.

- Strict types end-to-end (no `any`).
- Dual ESM + CJS build.
- Works in Node 18+, modern browsers, and edge runtimes.
- Exponential-backoff retries on 429 / 5xx (with `Retry-After` honoring).
- Per-attempt timeouts covering the response body, an optional overall
  request budget, and cancellation at any point via `AbortSignal`, for every
  request/response call. The long-lived `events.stream()` has no SDK
  timeouts, but its `signal` cancels it at any point.
- Constant-time HMAC-SHA256 webhook signature verification.
- Hand-written — no codegen toolchain — kept in lockstep with `packages/openapi`.

## Install

```bash
pnpm add @postwave/sdk
# or: npm i / yarn add
```

## Quickstart

```ts
import { PostwaveClient } from "@postwave/sdk";

const pw = new PostwaveClient({
  apiKey: process.env.POSTWAVE_API_KEY!,
  tenantId: "acme", // local-dev only; production API keys carry tenant scope
});

// Generate a 3-email welcome series
const seq = await pw.sequences.generate({
  template_id: "tpl_welcome_3",
  name: "Welcome series",
  variables: { product_name: "Acme", founder_name: "Alex" },
});

console.log(seq.emails[0].subject);
```

## Method index

| Resource                  | Methods                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pw.integrations`         | `catalog`, `connections`, `coverage`, `stacks`, `readiness`, `recipes`, `recipe`, `applyRecipe`, `detail`, `contract`, `health`, `startConnect`, `finishConnect`, `sync`, `backfill`, `pause`, `disconnect`                                                                                                     |
| `pw.nativeIntegrations`   | `commerce`, `crm`, `lead`, `reviews`, `loyalty`, `subscriptions`, `support`, `analytics`, `warehouse` first-party surfaces. Support is catalog/minimized-read compatibility only: provider catalog plus minimized stored list/detail reads remain available; every support lifecycle method fails locally with `support_integration_runtime_held` and sends no HTTP request. Other generic families expose their route-accurate methods. |
| `pw.audienceDestinations` | `providers`, `list`, `create`, `get`, `update`, `readiness`, `preview`, `sync`, `jobs`, `disconnect` for first-party Meta, Google Ads, TikTok, LinkedIn, and Snap audience delivery.                                                                                                                            |
| `pw.chatIntegrations`     | `slack`, `discord`, and `teams` incoming-webhook integrations. Each exposes `list`, `create`, `update`, and `delete`; direct `pw.discordIntegrations` and `pw.teamsIntegrations` accessors are also available.                                                                                                  |
| `pw.sms`                  | **Source candidate; HOLD / NO-GO for customer traffic.** Draft/configuration method names exist, but dispatch/scheduling, A2P submit/poll, hosted callbacks/clicks, financial/MMS evidence, auto-replies, and private reports are structurally release-held. Published immutable-package parity is not certified.            |
| `pw.pushSuppressions`     | `list`, `add`, `remove`, `bulkImport`, `bulkRemove` for exact-admin tenant-customer APNs/FCM/Web suppression authority. This is a private registry/control-plane surface, not operator Expo-device management or evidence of live delivery.                                                                            |
| `pw.developerMarketplace` | `monitoring`, `submitListingReview`, `listPartnerProfiles`, `upsertPartnerProfile`, `submitPartnerProfileReview`, `reviewQueue`, `reviewAppDecision`, `reviewListingDecision`, `reviewPartnerProfileDecision`, `authorize`, `token`, `revoke`                                                                   |
| `pw.migrations`           | `start`, `callback`, `discover`, `dryRun`, `commit`, `get`, `verification`, `rollback`, `rollbackStatus`, `listSources`                                                                                                                                                                                         |
| `pw.subscribers`          | `list`, `get`, `create`, `update`, `delete`, `search`, `suppress`                                                                                                                                                                                                                                               |
| `pw.sequences`            | `list`, `get`, `generate`, `regenerate`, `getJob`, `waitForJob`                                                                                                                                                                                                                                                                |
| `pw.templates`            | Voice/sequence templates: `list`, `get`, `create`, `update`, `delete`                                                                                                                                                                                                                                           |
| `pw.campaignTemplates`    | Visual newsletter designs: `list`, `search`, `get`, personal `favorite`/`unfavorite`, recents, collections, saved searches, `listRevisions`, `getRevision`, `create`, concurrency-safe `update`, `archive`, `restore`, `clone`, durable `adapt`/`generate`, actor-scoped `listDesigns`, and `createCampaign`. Deprecated `delete` safely archives.             |
| `pw.voiceProfile`         | `get`, `build`, `listSources`, `addSource`, `ingestSource`, `getIngestJob`, `waitForIngestJob`, `removeSource`                                                                                                                                                                                                                                      |
| `pw.forms`                | `list`, `get`, `create`, `update`, `delete`, `listSubmissions`, `exportSubmissionsCSV`                                                                                                                                                                                                                          |
| `pw.inboxReality`         | `getCampaignReport`, `predict`, `diagnose`, `render`                                                                                                                                                                                                                                                            |
| `pw.reputation`           | `get`                                                                                                                                                                                                                                                                                                           |
| `pw.authChecks`           | `list`                                                                                                                                                                                                                                                                                                          |
| `pw.sending`              | `provision`, `getState`, `getWarmup`                                                                                                                                                                                                                                                                            |
| `pw.automations`          | `trigger`, `listExecutions`, `pause`, `resume`                                                                                                                                                                                                                                                                  |
| `pw.webhooks`             | Canonical outbound destinations: `list`, `create`, `update`, `delete`, `test`, `deliveries`, `deliveriesList`, `replay`, `rotateSecret`, `verifySignature`                                                                                                                                                       |
| `pw.inboundWebhooks`      | Signed inbound endpoints: `list`, `create`, `get`, `update`, `rotate`, `delete`, `events`, `replay`, `triggers`, `createTrigger`, `updateTrigger`, `deleteTrigger`, `previewTransform`                                                                                                                            |
| `pw.conversionIngest`     | Key-bound HMAC v2 server-side conversions: `ingest` and atomic `ingestBatch` (maximum 500). The resource signs the exact raw JSON bytes and omits dashboard bearer/tenant headers.                                                                                                                               |
| `pw.conversionIngestSecrets` | Exact-admin, metadata-only `list`, reveal-once `issue`, and exact `revoke` for the HMAC credentials used by conversion ingest. Pages are capped at 100 and are never auto-walked. |

`conversionIngestSecrets.issue()` makes exactly one request and forcibly omits
`Idempotency-Key`, even if the client has a default header. If its transport or
201 response is ambiguous, do not call it again blindly: list the metadata
register, identify any newly issued key ID, revoke it, and then issue a
replacement. The CLI intentionally exposes no mint command.

The SMS source candidate includes exact-admin `listSuppressions`,
`addSuppression`, and `removeSuppression`. Listing returns one tenant-bound
response-cutoff page and never follows `nextCursor` automatically. When
`phone` is present the SDK uses `POST /api/v1/sms/suppressions/query`, keeping
the exact recipient out of URLs. Add/remove affect only reversible
`manual/manual` workspace holds and never grant or restore consent.

## Push suppression authority (Route43)

`pw.pushSuppressions` requires an exact-admin credential and an expected
canonical tenant UUID. `list` returns one strict snapshot page; copy an opaque
`nextCursor` unchanged to continue. Returned rows contain a minimized 16-hex
`device_token_hash`, never the raw customer token or full digest. Raw tokens are
accepted only in `add` and `bulkImport` request bodies and must not be logged.
Snapshot membership is pinned by a monotonic visibility revision;
`snapshotAt` is response-observation metadata, so valid row timestamps may be
later if the database clock moved backward.

Only reversible `manual`/`dashboard` authority can be removed. Pass the exact
reviewed row `version` to `remove`, or `expected_version` for every
`bulkRemove` item. A valid receipt increments that version and reports
`stillSuppressed`; `true` means another independent authority still holds the
customer token. Provider, user-opt-out, complaint, and legacy-review authority
is locked and fails closed.

```ts
const tenantId = process.env.POSTWAVE_TENANT_UUID!;
const page = await pw.pushSuppressions.list({ tenantId, limit: 50 });

// Fetch this secret directly from a private store. Never log or persist it in
// application evidence.
const manual = await pw.pushSuppressions.add(
  {
    device_token: process.env.CUSTOMER_PUSH_TOKEN!,
    platform: "fcm",
    reason: "manual",
  },
  { tenantId },
);

const receipt = await pw.pushSuppressions.remove(manual.id, manual.version, {
  tenantId,
});
if (receipt.stillSuppressed) {
  // Keep treating the customer token as suppressed by another authority.
}
```

This tenant-customer APNs/FCM/Web registry does not lift the current
**HOLD / NO-GO** on customer push runtime, audience materialization, APNs/FCM
providers, or automatic provider feedback. Web is registry-only. It must not be
presented as proof that a push was excluded from, or processed by, a live send.

## Editable campaign-template lifecycle

Editable visual templates use strong ETags so one editor or agent cannot
silently overwrite another. Always fetch the current template, pass its
`etag` unchanged, and continue with the fresh ETag returned by each mutation:

```ts
const templateId = "00000000-0000-0000-0000-000000000000";
const current = await pw.campaignTemplates.get(templateId);
const updated = await pw.campaignTemplates.update(
  current.id,
  { subject: "This week at Acme" },
  current.etag,
);
const archived = await pw.campaignTemplates.archive(updated.id, updated.etag);
const restored = await pw.campaignTemplates.restore(
  archived.id,
  archived.etag,
);

const history = await pw.campaignTemplates.listRevisions(restored.id);
const snapshot = await pw.campaignTemplates.getRevision(
  restored.id,
  history.items[0].version,
);
```

`delete(id, etag)` is retained for compatibility but performs the same
recoverable archival transition. It does not permanently erase source or
revision history.

## Mailchimp migration lifecycle

Mailchimp runs require an explicit audience scope. Discover once without a
scope to list audiences, repeat the chosen IDs for the scoped preview and
authoritative dry run, wait for `awaiting_confirmation`, then commit those same
IDs:

```ts
const auth = await pw.migrations.start("mailchimp");
// Redirect to auth.authorize_url. The OAuth callback returns the job_id.
const { job_id } = await pw.migrations.callback("mailchimp", code, auth.state);

const inventory = await pw.migrations.discover("mailchimp", job_id);
const discoveredAudienceIds = new Set(
  (inventory.audiences ?? []).map(({ id }) => id),
);
// Replace this placeholder with IDs the operator explicitly chose from the
// discovery result. Never default to every discovered audience.
const audienceIds = ["<operator-selected-audience-id>"];
if (
  audienceIds.length === 0 ||
  audienceIds.some((id) => !discoveredAudienceIds.has(id))
) {
  throw new Error("Choose valid Mailchimp audience IDs");
}

await pw.migrations.discover("mailchimp", job_id, audienceIds);
await pw.migrations.dryRun("mailchimp", job_id, audienceIds);
// Poll pw.migrations.get(job_id) until status === "awaiting_confirmation".
const report = await pw.migrations.verification(job_id);
// Present the full report for operator approval, especially discovery/source-
// archive warnings, account-global resources, unsupported automations, and the
// generic, non-detected Customer Journey gap. Do not approve from counts alone
// or treat that gap as a Journey inventory.
console.log(report.resource_completeness);
const operatorApproved = await yourExplicitApprovalWorkflow(report);
if (!operatorApproved) throw new Error("Explicit operator approval required");
await pw.migrations.commit("mailchimp", job_id, audienceIds);
```

If the credential is revoked, invalidated, or the authorizing user's access
changes, call `start("mailchimp", job_id)` and complete its callback. Passing
`job_id` reconnects the same non-running job, preserving its reviewed scope;
omitting it starts a new migration. Only the validated Classic `welcomeSeries`
subset can become paused runtime records; other Classic workflows require
manual rebuild/review. The API cannot enumerate or export Customer Journey
graphs, so operators must inventory them in Mailchimp and attach rebuild or
waiver evidence themselves.

## Integrations facade

Search the public catalog, inspect connection health, and delegate lifecycle
actions through the owning connector surface:

```ts
const catalog = await pw.integrations.catalog({
  q: "Shopify",
  badge: "native",
  capability: "orders",
});

const shopify = catalog.items[0];
if (shopify) {
  const readiness = await pw.integrations.readiness();
  console.log(readiness.public_claim);

  const detail = await pw.integrations.detail(shopify.slug);
  console.log(detail.connection.health_message);

  const sync = await pw.integrations.sync(shopify.slug);
  console.log(sync.delegated_to);
}
```

Catalog badges are intentionally explicit: `native`, `partner`, `zapier`,
`webhook`, `api_sdk`, `migration_only`, or `planned`. Check `runtime_status`:
`partial` native entries are Moosewave-managed foundations until provider
pullers, callbacks, and lifecycle adapters are verified.

## Native managed integrations

Use the facade for catalog discovery and public setup state. Use
`nativeIntegrations` when you already have the concrete managed connection ID
and need provider metadata, run history, or direct lifecycle controls:

Support is the held exception: `providers()` is static discovery, while
`list()` and `get()` return tenant-bound minimized historical stored
projections. A first page is not complete history. Continue manually only when
`page.has_more` is true by copying the opaque `page.next_cursor` exactly into a
new `list({ limit, cursor })` call; do not decode, alter, or reuse a cursor for a
different query. Rows and detail do not prove live credentials, callbacks,
synchronization, or run history.

```ts
const supportPage = await pw.nativeIntegrations.support.list({ limit: 50 });
if (supportPage.page.has_more) {
  const nextSupportPage = await pw.nativeIntegrations.support.list({
    limit: 50,
    cursor: supportPage.page.next_cursor!,
  });
  console.log(nextSupportPage.items);
}
const supportDetail = await pw.nativeIntegrations.support.get(
  "22222222-2222-4222-8222-222222222222",
);
console.log(supportDetail.runtime_status); // held

const contactEmail = ["reader", "example.com"].join("@");

const providers = await pw.nativeIntegrations.crm.providers();
console.log(providers.items.map((provider) => provider.name));

const connection = await pw.nativeIntegrations.crm.create({
  provider: "hubspot",
  name: "HubSpot production",
  credentials_ref: "vault://crm/hubspot",
  settings: { portal_id: "123456" },
});

await pw.nativeIntegrations.crm.sync(connection.id, {
  contacts: [{ email: contactEmail }],
});
await pw.nativeIntegrations.lead.ingest("lead_conn_123", {
  email: contactEmail,
});
const runs = await pw.nativeIntegrations.crm.runs(connection.id, 10);
console.log(runs.items[0]?.status);

await pw.nativeIntegrations.commerce.sync("commerce_conn_123", {
  cursor: "last_cursor",
  orders: [{ source_id: "order_123", customer_email: contactEmail }],
});

await pw.nativeIntegrations.warehouse.backfill("warehouse_conn_123", {
  object_selection: ["profiles", "events"],
});
```

## Ad audience destinations

`audienceDestinations` operates readiness-gated first-party ad audience
foundations for Meta, Google Ads, TikTok, LinkedIn, and Snap. Public config
stores credential references; readiness stays `credential_resolution_required`
until the trusted resolver hydrates provider tokens for live delivery:

```ts
const providers = await pw.audienceDestinations.providers();
console.log(providers.providers);

const readiness = await pw.audienceDestinations.readiness("meta", {
  credentials_ref: "vault://ads/meta",
  audience_id: "aud_123",
});
console.log(readiness.ready, readiness.missing ?? []);

const destination = await pw.audienceDestinations.create({
  provider: "meta",
  list_id: "list_123",
  external_audience_id: "aud_123",
  config: {
    credentials_ref: "vault://ads/meta",
    audience_id: "aud_123",
  },
});

await pw.audienceDestinations.preview(destination.id);
await pw.audienceDestinations.sync(destination.id);
const jobs = await pw.audienceDestinations.jobs(destination.id);
console.log(jobs.items[0]?.status);
```

## Chat notification integrations

Slack, Discord, and Teams incoming-webhook integrations share one route
shape and encrypt webhook URLs server-side:

```ts
await pw.chatIntegrations.discord.create({
  url: "https://discord.com/api/webhooks/123/token",
  channel_hint: "#growth",
  events: ["subscriber.added", "campaign.sent"],
});

await pw.teamsIntegrations.update("teams_123", { enabled: false });
await pw.chatIntegrations.forProvider("slack").delete("slack_123");
```

## Developer marketplace

Public partner apps can use the marketplace OAuth runtime without hand-rolling
endpoint paths. Partner profiles also follow the review-owned certification
flow used by public catalog tiles:

```ts
const monitoring = await pw.developerMarketplace.monitoring("app_123");
console.log(monitoring.status, monitoring.blockers ?? []);

const listing = await pw.developerMarketplace.submitListingReview("app_123");
console.log(listing.review_state);

const profile = await pw.developerMarketplace.upsertPartnerProfile({
  organization_name: "Example Agency",
  profile_type: "agency",
});
console.log(profile.status);

await pw.developerMarketplace.submitPartnerProfileReview();

const queue = await pw.developerMarketplace.reviewQueue(
  process.env.POSTWAVE_REVIEW_SECRET!,
  { kind: "partner_profile", limit: 25 },
);
console.log(queue.counts.profiles);

await pw.developerMarketplace.reviewPartnerProfileDecision(
  "00000000-0000-0000-0000-000000000000",
  { decision: "approve", partner_level: "premier" },
  process.env.POSTWAVE_REVIEW_SECRET!,
);

const auth = await pw.developerMarketplace.authorize({
  response_type: "code",
  client_id: "pw_oac_123",
  redirect_uri: "https://partner.example/oauth/callback",
  state: "st_123",
  code_challenge: "S256_CHALLENGE",
  code_challenge_method: "S256",
});

const token = await pw.developerMarketplace.token({
  grant_type: "authorization_code",
  code: auth.code,
  redirect_uri: auth.redirect_uri,
  client_id: "pw_oac_123",
  client_secret: process.env.POSTWAVE_CLIENT_SECRET!,
  code_verifier: process.env.PKCE_VERIFIER!,
});

await pw.developerMarketplace.revoke({ token: token.access_token });
```

## Error handling

Every method throws a typed subclass of `PostwaveError`:

```ts
import { PostwaveClient, NotFoundError, RateLimitError } from "@postwave/sdk";

try {
  await pw.subscribers.get("does-not-exist");
} catch (e) {
  if (e instanceof NotFoundError) console.warn(`gone: ${e.code}`);
  else if (e instanceof RateLimitError)
    console.warn(`retry in ${e.retryAfterSeconds}s`);
  else throw e;
}
```

Every error carries `status`, `code`, `message`, and (when the gateway sets it)
a `requestId` you can include in support tickets.

## Timeouts, budgets and cancellation

Three independent bounds apply to every call made through
`PostwaveClient.request()`. That covers every resource method **except
`events.stream()`**, which is a long-lived stream and deliberately does not
use `request()`. It has caller cancellation but no timeouts (see
[Which operations get these guarantees](#which-operations-get-these-guarantees)).

| Bound | Set with | Default | Covers | On expiry |
| --- | --- | --- | --- | --- |
| Per-attempt timeout | client `timeoutMs` | 30 s (max 120 s) | One wire attempt: connect, headers **and body read**. Each retry gets a fresh timer. | `TimeoutError`, `scope: "attempt"`. Retried under the normal retry policy. |
| Overall budget | client `totalTimeoutMs`; per-call `totalTimeoutMs` on `pw.request()` only | Off | The whole call: every attempt, body read and backoff sleep. | `TimeoutError`, `scope: "total"`. Never retried. |
| Caller cancellation | per-call `signal`, where the method accepts one (listed below) | — | The whole call, at any point. | `RequestAbortedError`. Never retried. |

```ts
import { PostwaveClient, RequestAbortedError, TimeoutError } from "@postwave/sdk";

// Every call gets at most 20 s end to end, retries and backoff included.
const pw = new PostwaveClient({ apiKey, timeoutMs: 10_000, totalTimeoutMs: 20_000 });

const ac = new AbortController();
try {
  // Per-call override: tighter for this call. `null` disables the budget.
  await pw.request("GET", "/api/v1/subscribers", {
    signal: ac.signal,
    totalTimeoutMs: 5_000,
  });
} catch (e) {
  if (e instanceof RequestAbortedError) {
    /* the caller cancelled; e.payload is signal.reason */
  } else if (e instanceof TimeoutError) {
    /* an SDK deadline expired; e.scope is "attempt" | "total" */
  } else throw e;
}
```

- **Timeout and cancellation stay distinct.** `TimeoutError` means an
  SDK-owned deadline expired. `RequestAbortedError` means *your* signal fired,
  even if it came from `AbortSignal.timeout()`. Both keep their stable codes
  (`request_timeout` / `request_aborted`) and both extend `NetworkError`.
- **Budget and backoff.** If the next backoff (including a `Retry-After`)
  would not fit in the remaining budget, the last attempt's real error (for
  example `RateLimitError`) is thrown at once instead of waiting out the
  budget. An attempt never runs past the budget.
- **Write safety is unchanged.** Retries still require a safe verb or an
  `Idempotency-Key`, and an auto-minted key is reused for every attempt. A
  body-read timeout on a keyless `POST`/`PATCH`/`DELETE` is not retried, and
  `maxAttempts` is honoured inside the budget.
- **Deadlines are checked against a monotonic clock, not only by timers.**
  A retry, a 304 cache-bust refetch or a poll never *starts* once the
  caller has cancelled or a deadline has passed. This holds even when a
  blocked event loop delays the deadline's own timer past a shorter backoff
  or interval timer.
- **Wall-clock corrections do not move budgets.** `timeoutMs`,
  `totalTimeoutMs` and waiter deadlines are relative durations, measured with
  `performance.now()`, never `Date.now()`. An NTP step, a manual clock change
  or a VM resume re-sync neither expires a budget early nor stretches it.
  Time the whole machine spends suspended may not count, just as it does not
  for runtime timers. Only an HTTP-date `Retry-After`, which is an absolute
  time, is compared with the wall clock. Where `performance.now` is
  unavailable, the SDK falls back to a wall clock clamped never to run
  backwards; there, a forward correction can still shorten a budget.
- **Settle rule.** Once the caller has cancelled (including from inside
  `onResponseHeaders`) or the overall budget has passed, the call rejects
  with `RequestAbortedError` / `TimeoutError` and never resolves. The
  request's success, a 204 with no body, or its HTTP error is not reported
  either. The per-attempt timeout is a stall detector: it interrupts a
  stalled attempt, but a response that has already been fully received is
  not discarded just because it overran the attempt timer.
- **Nothing is left armed.** Every path, whether success, error, timeout or
  cancellation, clears the SDK's timers, removes its listener from your
  signal, and cancels any response body it did not finish reading. A
  signal that is already aborted rejects without calling `fetch`.
- `totalTimeoutMs` must be a positive, finite number of milliseconds; other
  values throw rather than silently running unbounded. Values above
  2,147,483,647 ms (the timer limit) are clamped.

### Which operations get these guarantees

| Operation | Per-attempt `timeoutMs` + retries | Client `totalTimeoutMs` | Per-call `totalTimeoutMs` | Caller `signal` |
| --- | --- | --- | --- | --- |
| `pw.request(method, path, opts)` | Yes | Yes | Yes | Yes |
| Resource methods that accept a `signal`: `pushSuppressions.list/add/remove/bulkImport/bulkRemove`, `conversionIngest.ingest/ingestBatch`, `conversionIngestSecrets.list/issue/revoke`, `campaignTemplates.createDesign/getDesign/refineDesign/retryDesign/saveDesign/createCampaignFromDesign/archiveDesign/waitForDesign`, `sequences.getJob/waitForJob`, `voiceProfile.getIngestJob/waitForIngestJob` | Yes | Yes | No | Yes |
| Every other resource method, including `events.subscribe()` | Yes | Yes | No | No |
| `GeneratedOperations` with a `PostwaveClient` transport | Yes | Yes | No | No |
| `events.stream()` | **No** | **No** | **No** | Yes, enforced by the SDK; see below |

Resource methods do not forward a per-call budget. To give one call its own
budget or cancellation when its method has no `signal` option, either use
`pw.request()` for that call or construct a client with the
`totalTimeoutMs` you need. The three polling helpers,
`sequences.waitForJob()`, `voiceProfile.waitForIngestJob()` and
`campaignTemplates.waitForDesign()`, additionally have the wait-deadline
guarantees below. Methods that never touch the network (webhook signature helpers,
locally held operations) have no lifecycle to bound.

### Streaming exception: `events.stream()`

`events.stream()` opens a Server-Sent Events connection that is meant to stay
open indefinitely, so it calls the transport directly (`fetchRaw`) instead of
`request()`. Applying a per-attempt timeout or overall budget would cut off a
healthy stream, so it has no SDK deadline. Cancellation and cleanup, however,
are enforced by the SDK:

- **No SDK deadline.** Neither `timeoutMs` nor `totalTimeoutMs` applies, to
  connecting or to reading. A stream that stalls stays open until you cancel
  it.
- **No retries or reconnection.** A failed connect, an HTTP error or a
  dropped stream ends the iteration; reconnecting is up to you.
- **Cancellation is enforced by the SDK.** The request is sent on the first
  `next()`, not when `stream()` is called. If the `signal` has already
  aborted by then, iteration rejects without calling `fetch`. An abort at any
  later point (while connecting, while reading the body or an HTTP error
  body, or while your loop body runs) makes the pending `next()` reject with
  `RequestAbortedError`, with the abort reason as its `payload`. If no
  `next()` is pending, the next one rejects. This also applies after the
  final event has been delivered. Leaving the loop with `break` or `return`
  after an abort ends quietly, without an error. Once iteration has finished
  (`done: true`) or already rejected, a later abort changes nothing. The SDK
  races every wait on the transport against the signal, so this holds even
  for a custom transport or body that ignores it.
- **Nothing is processed after an abort.** Once the signal has aborted, no
  event is yielded, and nothing further is decoded or parsed. That includes
  events still buffered from an earlier chunk, the undecoded rest of a chunk
  already received, and data from a read that completed just before the
  abort was observed. That data is discarded unread. The same applies to an HTTP error body.
- **The body is cancelled on abort.** If the stream is reading the event
  body or is paused in your loop body, the body is cancelled synchronously
  from the abort, even if you never resume the iterator. If the abort lands
  while the SDK has another step pending (the transport has just resolved,
  or an HTTP error body is being read), it is cancelled as soon as that step
  resumes. This does not wait for the transport. A response that arrives
  only after the abort has its body cancelled on arrival. Whether
  cancelling the body frees the underlying connection is up to the
  transport. The SDK also aborts the signal it passed to the transport
  (next item).
- **Each call is independent.** Every `stream()` call has its own request,
  parser and cleanup. Streams on the same client, or sharing one `signal`,
  do not affect each other. Aborting a shared signal rejects each of them
  with the same reason. The SDK never aborts your signal: ending, breaking
  out of or failing one stream leaves it, and any other stream using it,
  untouched.
- **The transport receives an SDK-owned signal**, linked to yours. It aborts
  with your reason when you abort. It also aborts whenever the stream ends
  any other way than reading the body to its end: leaving the loop early, an
  HTTP error or a transport error. A transport that honours its signal can
  then tear the request down. It is not aborted when the stream ends
  normally.
- **Errors.** A non-2xx response is mapped to the usual typed error (for
  example `ServerError`) after at most 64 KiB of its body is read. A larger
  or unreadable error body is cancelled and the error carries no payload, as
  before. Transport failures other than your abort (a failed connect, a
  dropped connection) surface as thrown by the transport, not as
  `NetworkError`. If the signal has aborted by the time any of these would
  be reported, `RequestAbortedError` is reported instead.
- **Every exit releases the body.** The reader is released on every exit:
  the end of the stream, leaving the `for await` loop (`break`, `return` or
  a thrown error), an abort, a transport error or an HTTP error. Every exit
  before the end of the body also cancels it. A body whose `cancel()` never
  settles does not delay your `break`.
- **Parsing does not depend on chunking.** LF, CRLF and CR line endings are
  accepted, including a CRLF split across two chunks, and multi-line `data`
  fields are joined. Only `data` is used. Comments and other fields (`event`,
  `id`, `retry`) are ignored. A frame that is not valid JSON, is not an event
  record, or is longer than the frame limit is skipped, and parsing resumes
  after the blank line that ends it. The lines of a skipped oversized frame are never
  read as frames of their own. For compatibility, a final frame that has
  valid data but no closing blank line is still delivered at end of stream.
  An oversized final frame is not.
- **The frame limit counts string units, not bytes.** The limit is 262,144
  UTF-16 code units: JavaScript string length, measured on the decoded text,
  not UTF-8 bytes. It covers all of the frame's lines (comments and other
  fields included), with each line break counting as one whatever its form,
  and excludes the blank line that ends the frame. A character outside the
  Basic Multilingual Plane, such as most emoji, counts as two. A frame at
  the limit is 262,144 bytes if it is ASCII, but can be up to about three
  times as many bytes of 3-byte characters such as CJK text, and is still
  kept. A leading byte-order mark is removed during decoding and does not
  count. Only one, at the very start of the stream, is removed. A U+FEFF
  anywhere else is content, including at the start of a line right after a
  skipped oversized frame. A line that starts with one has no `data` field,
  so its frame yields no event.
- **Decoding and parsing follow demand.** Each `next()` decodes and parses
  only as far as the next valid event. The current transport chunk is
  decoded from UTF-8 in windows of at most 8 KiB, and the next window is
  decoded only when parsing needs more text. So one `next()` decodes at most
  8 KiB beyond the end of the frame it returns, plus any frames it skips (a
  malformed or oversized frame still has to be decoded to find where it
  ends). A chunk holding thousands of events is not decoded or turned into
  records up front, and after `break` or an abort the rest of it is never
  decoded or parsed. A character or CRLF split across chunks or windows is
  decoded as if the bytes were contiguous.
- **What is retained.** The SDK holds the current chunk's bytes, by
  reference and not copied, until they have all been decoded or the stream
  stops. An abort, `break` or error drops them at once, even if you never
  resume the iterator. A consumer that simply stops calling `next()`,
  without `break` or an abort, keeps them. Holding the chunk also keeps
  alive any larger buffer it is a view into.
  Beyond the chunk, it holds at most one decoded window (8 KiB of bytes),
  the current frame's text and up to 3 bytes of an incomplete character.
  The frame's text is bounded by the frame limit of 262,144 code units.
  JavaScript engines store up to 2 bytes per unit, so that is up to 512 KiB,
  plus temporary copies while a complete frame is joined and parsed. Because decoding is deferred, a custom
  transport that reuses or modifies a chunk's buffer after delivering it
  would change what is decoded. Previously each chunk was decoded as soon
  as it was read, so this did not matter. Deliver each chunk in its own
  buffer.

To bound how long you wait for the connection or the next event, own the
deadline yourself. Use a controller you abort from your own timer and reset
on each event. Avoid `AbortSignal.timeout()` for this: it would also end a
healthy stream once it fires.

```ts
const ac = new AbortController();
let idle = setTimeout(() => ac.abort(), 30_000); // no event for 30 s -> stop
try {
  for await (const event of pw.events.stream({ signal: ac.signal })) {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(), 30_000);
    handle(event);
  }
} catch (e) {
  if (!ac.signal.aborted) throw e; // a real failure, not our idle cutoff
} finally {
  clearTimeout(idle);
}
```

### Polling helpers

`sequences.waitForJob()`, `voiceProfile.waitForIngestJob()` and
`campaignTemplates.waitForDesign()` share one implementation and the same
guarantees. Their options and defaults are their own and are unchanged:

| Helper | Delay option | Delay default / min | `timeoutMs` default / bounds | Terminal (returned, not thrown) | Timeout message |
| --- | --- | --- | --- | --- | --- |
| `sequences.waitForJob(id, opts)` | `intervalMs` | 2 s / max 30 s | 5 min / max 30 min | `succeeded`, `failed` | `sequences.waitForJob(<id>): timed out after <ms>ms` |
| `voiceProfile.waitForIngestJob(src, id, opts)` | `intervalMs` | 2 s / max 30 s | 5 min / max 30 min | `succeeded`, `failed` | `voice.waitForIngestJob(<id>): timed out after <ms>ms` |
| `campaignTemplates.waitForDesign(id, opts)` | `pollIntervalMs` | 1 s / min 250 ms | 120 s / min 1 s; no SDK maximum (runtime timer limit applies, see below) | any status except `queued`/`generating` | `Campaign template design <id> did not finish within <ms>ms` |

```ts
const job = await pw.sequences.waitForJob(ack.job_id, {
  timeoutMs: 120_000, // wait deadline
  intervalMs: 2_000,  // delay between polls
  signal: ac.signal,
});

const design = await pw.campaignTemplates.waitForDesign(draft.id, {
  timeoutMs: 60_000,
  pollIntervalMs: 1_000, // retry_after_seconds * 1000 wins if longer
  signal: ac.signal,
});
```

- The wait deadline and `signal` bound an **in-flight poll** (request and
  body read) as well as the delay between polls.
  No poll starts, and no result (not even a terminal one) is returned, once
  the deadline has passed on the monotonic clock or the caller has cancelled.
  This also applies to the client's own retries inside a poll.
- Deadline expiry rejects with `TimeoutError` (`scope: "wait"`, `timeoutMs`
  set) and the helper's message from the table. Caller cancellation rejects
  with `RequestAbortedError`, with the abort reason as `payload`. A
  signal that is already aborted sends no request.
- Every exit path releases the deadline timer, the delay timer and every
  listener added to your signal.
- Errors from a poll itself propagate unchanged. That includes
  `NotFoundError`, and a per-attempt `TimeoutError` once client retries are
  exhausted.
- Each poll is an ordinary `request()`, so the client's `timeoutMs`,
  `retries` and any `totalTimeoutMs` apply to each poll individually.
- `waitForDesign` waits `max(pollIntervalMs, retry_after_seconds * 1000)`
  milliseconds between polls, as before. `pollIntervalMs` is in
  milliseconds; the server's `retry_after_seconds` hint is in seconds. A hint
  that runs past the deadline is cut off by it. A hint that is not a
  positive number is ignored (numeric strings still count).
- **Upper bounds.** `sequences.waitForJob()` and
  `voiceProfile.waitForIngestJob()` cap `timeoutMs` at 30 minutes and
  `intervalMs` at 30 seconds. `campaignTemplates.waitForDesign()` imposes **no
  application-level maximum** on `timeoutMs` or `pollIntervalMs`. The
  runtime timer limit still applies to every helper: any deadline or delay
  above 2,147,483,647 ms (2^31-1, about 24.8 days) is clamped to it, because
  a longer `setTimeout` fires after about 1 ms instead.

#### Intentional changes to `campaignTemplates.waitForDesign()`

Moving this helper onto the shared lifecycle changes these, deliberately:

| Situation | Before | Now |
| --- | --- | --- |
| Deadline expires | plain `Error` | `TimeoutError` (`scope: "wait"`). The message is identical and `instanceof Error` still holds. It is now also a `NetworkError`/`PostwaveError`. |
| Cancelled during the delay between polls | the raw `signal.reason` (e.g. a `DOMException` `AbortError`) was rethrown | `RequestAbortedError` with `payload === signal.reason`, matching cancellation during a poll, which was already `RequestAbortedError` |
| A poll stalls | waited indefinitely; the deadline was only checked after a poll returned | ends at the deadline; the stalled request and its body are released |
| Delay or retry hint runs past the deadline | slept in full, then polled once more, so the wait could overrun `timeoutMs` and still return a late result | ends at the deadline with no further poll |
| A wait completes | each delay left an abort listener on your signal (two after a three-poll wait) | all listeners and timers released |
| `timeoutMs` is `NaN`/`Infinity` | never timed out | 120 s default |
| `pollIntervalMs` is `NaN` | re-polled almost immediately | 1 s default |
| `timeoutMs` above 2^31-1 ms (about 24.8 days) | honoured in full (the old deadline was wall-clock arithmetic, not a timer) | clamped to the runtime timer limit, 2^31-1 ms; there is still no application-level cap |
| `pollIntervalMs` or `retry_after_seconds * 1000` above 2^31-1 ms | overflowed the delay timer, which then fired after about 1 ms, so it re-polled almost immediately | clamped to 2^31-1 ms, and cut short by the wait deadline |

Options within the runtime timer limit, defaults, floors, terminal statuses
and retry hints behave as before.

## Signed server-side conversions

`conversionIngest.ingest` and `conversionIngest.ingestBatch` support signed
server-side conversion events. Supply signing configuration at runtime. The SDK
binds the routing ID and timestamp to the exact request body with HMAC-SHA256 and
preserves the operation identifier across retries. Plaintext contact data is not
part of the typed conversion contract. Credential-bearing setup examples are
omitted from this source workbench.

## Outbound webhook event contract

`OUTBOUND_WEBHOOK_EVENT_TYPES` exports the exact subscription vocabulary:

```text
campaign.sent
subscriber.added
subscriber.removed
subscriber.unsubscribed
approval.requested
approval.decided
audit.created
bounce.received
list_health.degraded
list.subscriber.added
email.bounced
email.complained
email.delivered
assurance.run.completed
assurance.run.blocked
```

`pw.webhooks.test(id)` sends only the fixed `webhook.test` probe. The SDK does
not wrap the admin playground's arbitrary custom-payload fire: that route is a
live receiver side effect with a step-up/idempotency/reconciliation workflow,
not a normal retryable resource method. Clients deliberately opting into it
must use the documented HTTP operation, retain its `fire_id` and exact
`Idempotency-Key`, and reconcile ambiguous or cancelled calls by `fire_id`
before creating another attempt.

## Webhook signature verification

```ts
import { verifySignature } from "@postwave/sdk";

// Express, with body-parser raw middleware so req.body is a Buffer:
app.post("/postwave-webhook", async (req, res) => {
  const ok = await verifySignature(
    req.body,
    req.headers["x-postwave-signature"] as string,
    process.env.POSTWAVE_WEBHOOK_SECRET!,
  );
  if (!ok) return res.status(401).end();
  const envelope = JSON.parse(req.body.toString());
  // Persist event.id before side effects. It is stable across automatic
  // retries and manual replay; delivery.id identifies this delivery only.
  await handleOnce(envelope.event.id, envelope.event.type, envelope.event.data);
  res.status(200).end();
});
```

The verifier parses `t=<unix>,v1=<hex>`, authenticates
`<timestamp>.<raw-body>`, accepts overlapping `v1` values during secret
rotation, and enforces a five-minute replay window by default. It uses Web
Crypto and works unchanged on Cloudflare Workers, Vercel Edge, Deno, Bun, and
Node 18+.

## Contributing

Open a PR against `packages/sdk-ts/`. Run:

```bash
pnpm -F @postwave/sdk test
pnpm -F @postwave/sdk typecheck
pnpm -F @postwave/sdk build
```

The OpenAPI spec at `packages/openapi/openapi.yaml` is the source of truth;
keep `src/types.ts` in sync with any spec change in the same PR.
