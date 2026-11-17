import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
test("ESM SDK and webhook exports load after build", async () => {
  const sdk = await import("../dist/index.js");
  const hooks = await import("../dist/webhook.js");
  assert.equal(typeof sdk.PostwaveClient, "function");
  assert(Object.keys(hooks).length > 0);
});
test("CommonJS SDK and webhook exports load after build", () => {
  assert.equal(typeof require("../dist/index.cjs").PostwaveClient, "function");
  assert(Object.keys(require("../dist/webhook.cjs")).length > 0);
});
test("internal stream constants stay out of the public package", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const internal = [
    "DECODE_WINDOW_BYTES",
    // Pagination engine internals: only the typed iterators are public.
    "iteratePages",
    "iterateItems",
    "PaginationRun",
    "DEFAULT_MAX_PAGES",
    "CONTINUATION_HISTORY_LIMIT",
    "snapshotParams",
    "checkPageSize",
  ];
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Only the documented entry points are importable...
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./webhook"]);
  // ...and the build emits only their bundles, so there is no module file
  // an internal constant could be deep-imported from.
  for (const file of readdirSync(new URL("../dist/", import.meta.url))) {
    assert.match(file, /^(index|webhook)\.(js|cjs|d\.ts|d\.cts)(\.map)?$/, `unexpected build output ${file}`);
  }
  const modules = [
    await import("../dist/index.js"),
    await import("../dist/webhook.js"),
    require("../dist/index.cjs"),
    require("../dist/webhook.cjs"),
  ];
  for (const name of internal) {
    for (const mod of modules) assert.equal(name in mod, false, `${name} is exported at runtime`);
    for (const file of ["index.d.ts", "index.d.cts", "webhook.d.ts", "webhook.d.cts"]) {
      const declarations = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(declarations, new RegExp(`\\b${name}\\b`), `${name} appears in ${file}`);
    }
  }
});

test("pagination API is public, typed and working in both module formats", async () => {
  const { readFileSync } = await import("node:fs");
  const methods = {
    subscribers: ["listPages", "listAll"],
    lists: ["membersPages", "membersAll"],
    webhooks: ["listPages", "listAll", "deliveriesPages", "deliveriesAll"],
    audit: ["queryPages", "queryAll"],
  };
  for (const mod of [await import("../dist/index.js"), require("../dist/index.cjs")]) {
    assert.equal(typeof mod.PaginationError, "function");
    assert.ok(Object.prototype.isPrototypeOf.call(mod.PostwaveError.prototype, mod.PaginationError.prototype));
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      const cursor = new URL(url).searchParams.get("cursor");
      return new Response(
        JSON.stringify(cursor ? { items: [{ id: "b" }], next_cursor: null } : { items: [{ id: "a" }], next_cursor: "c1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const pw = new mod.PostwaveClient({ apiKey: "k", fetch, retries: 0 });
    for (const [resource, names] of Object.entries(methods)) {
      for (const name of names) assert.equal(typeof pw[resource][name], "function", `${resource}.${name}`);
    }
    const it = pw.audit.queryAll();
    assert.equal(calls.length, 0, "lazy in the built bundle");
    const ids = [];
    for await (const row of it) ids.push(row.id);
    assert.deepEqual(ids, ["a", "b"]);
    assert.deepEqual({ ...it.progress }, { pages: 2, items: 2, done: true, complete: true, stopReason: "end" });
  }
  for (const file of ["index.d.ts", "index.d.cts"]) {
    const declarations = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    for (const name of [
      "PaginatedIterator", "PageIterationOptions", "ItemIterationOptions", "PaginationProgress",
      "PaginationStopReason", "PaginationFailureReason", "PaginationError", "PaginationMetadataConflict",
      "listPages", "listAll", "membersPages", "membersAll", "deliveriesPages", "deliveriesAll", "queryPages", "queryAll",
    ]) {
      assert.match(declarations, new RegExp(`\\b${name}\\b`), `${name} missing from ${file}`);
    }
  }
});
