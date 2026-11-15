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
