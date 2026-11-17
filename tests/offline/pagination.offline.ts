/**
 * FOCUSED OFFLINE PAGINATION CHECKS. These need no installed dependencies.
 *
 *   npm run --offline test:pagination:offline
 *
 * Runs the shared cases in tests/pagination-cases.ts,
 * tests/pagination-concurrency-cases.ts and tests/pagination-retry-cases.ts
 * on Node's built-in test
 * runner against the TypeScript SOURCE (via --experimental-transform-types
 * and scripts/offline/register-ts.mjs), with the same unmocked-network block
 * as the vitest suite. The same cases also run under vitest in
 * tests/pagination.test.ts, alongside fake-timer and type-level checks that
 * are not repeated here. A passing offline run is not a passing `verify`.
 * Named *.offline.ts so vitest's *.test.ts glob does not pick it up.
 */
import { describe, test } from "node:test";

import { concurrencyCases } from "../pagination-concurrency-cases.js";
import { paginationCases } from "../pagination-cases.js";
import { retryCases } from "../pagination-retry-cases.js";

describe("pagination (offline, shared cases)", () => {
  for (const c of paginationCases) test(c.name, c.run);
});

describe("pagination: concurrent traversals on one client (offline, shared cases)", () => {
  for (const c of concurrencyCases) test(c.name, c.run);
});

describe("pagination: retry and recovery (offline, shared cases)", () => {
  for (const c of retryCases) test(c.name, c.run);
});
