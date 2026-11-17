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
  const internal = ["DECODE_WINDOW_BYTES"];
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
