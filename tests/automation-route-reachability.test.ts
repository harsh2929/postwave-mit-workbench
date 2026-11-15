// Compare client verb/path pairs against the pinned service contract; no live backend is needed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SDK = resolve(__dirname, "../src/resources/automations.ts");
const CONTRACT = resolve(__dirname, "../contracts/service-contract.json");

/**
 * METHOD + path pairs the SDK calls, normalised to the service's `{id}` grammar.
 *
 * The verb is not optional detail here: after `list` landed, GET
 * /v1/automations exists and POST /v1/automations still does not. A path-only
 * comparison calls that route "registered" and excuses the missing `create` --
 * which is exactly what the first version of this guard did.
 */
function sdkCalls(): string[] {
  const src = readFileSync(SDK, "utf8");
  const calls: string[] = [];
  for (const m of src.matchAll(
    /"(GET|POST|PATCH|PUT|DELETE)"[\s\S]{0,400}?["`](\/api\/v1\/automations[^"`]*)/g,
  )) {
    const path = m[2]!
      .replace(/\$\{[^}]*$/, "{id}")
      .replace(/\$\{[^}]*\}/g, "{id}")
      .replace(/^\/api/, "")
      .replace(/\/$/, "");
    calls.push(`${m[1]} ${path}`);
  }
  if (calls.length === 0) throw new Error("no automations calls found in the SDK");
  return [...new Set(calls)].sort();
}

/** METHOD + path pairs services/automation actually mounts. */
function registeredCalls(): string[] {
  const contract = JSON.parse(readFileSync(CONTRACT, "utf8")) as { automationRoutes: string[] };
  if (!Array.isArray(contract.automationRoutes) || contract.automationRoutes.length === 0) {
    throw new Error("The exported automation route contract is empty");
  }
  return [...new Set(contract.automationRoutes)].sort();
}

/**
 * Shipped SDK methods whose route does not exist yet. Each needs a real
 * implementation, not a mount. Remove an entry the moment its route lands.
 */
const KNOWN_UNROUTED: string[] = [
  // Empty since create and update landed. Kept as the place to declare a
  // shipped-but-unrouted SDK method if one ever appears again, because the
  // assertion below fails the moment an entry here outlives its gap.
];

describe("SDK automations paths are reachable", () => {
  it("every SDK path is either routed or a declared gap", () => {
    const registered = registeredCalls();
    const unreachable = sdkCalls().filter(
      (c) => !registered.includes(c) && !KNOWN_UNROUTED.includes(c),
    );
    expect(unreachable).toEqual([]);
  });

  it("the declared gaps are still gaps", () => {
    // An allowance that outlives what it allows is how a guard quietly loosens:
    // implement `create` without deleting its entry here and this guard would
    // keep excusing a route that now exists.
    const registered = registeredCalls();
    const stale = KNOWN_UNROUTED.filter((c) => registered.includes(c));
    expect(stale).toEqual([]);
  });

  it("list is routed, because that was the headline gap", () => {
    expect(registeredCalls()).toContain("GET /v1/automations");
  });

  it("can see both sides", () => {
    expect(sdkCalls().length).toBeGreaterThanOrEqual(5);
    expect(registeredCalls().length).toBeGreaterThanOrEqual(8);
  });
});
