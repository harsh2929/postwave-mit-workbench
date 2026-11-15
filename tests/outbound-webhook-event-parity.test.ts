// Compare the SDK vocabulary to the versioned public API contract snapshot.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { OUTBOUND_WEBHOOK_EVENT_TYPES } from "../src/types.js";

const CONTRACT = resolve(__dirname, "../contracts/service-contract.json");

/**
 * The AllowedEvents slice, resolved through its constants.
 *
 * Entries are written two ways -- bare string literals and Event* constant
 * references -- so a literal-only scan silently sees a fraction of the list and
 * the comparison passes for the wrong reason.
 */
function contractData(): { outboundWebhookEvents: string[]; resolvedEventConstantReferences: number } {
  return JSON.parse(readFileSync(CONTRACT, "utf8"));
}
function contractAllowedEvents(): string[] {
  const events = contractData().outboundWebhookEvents;
  if (!Array.isArray(events) || events.length === 0) throw new Error("The exported event contract is empty");
  return [...new Set(events)].sort();
}

describe("outbound webhook event parity", () => {
  it("offers exactly the events the public API accepts", () => {
    expect([...OUTBOUND_WEBHOOK_EVENT_TYPES].sort()).toEqual(contractAllowedEvents());
  });

  it("says which direction drifted", () => {
    // Widened to string[] deliberately: the SDK constant is a narrow union, and
    // .includes() on it rejects the plain strings parsed out of Go. Comparing
    // two vocabularies means treating both as vocabularies.
    const ts: string[] = [...OUTBOUND_WEBHOOK_EVENT_TYPES].sort();
    const accepted = contractAllowedEvents();
    expect({
      offeredButRejectedByTheAPI: ts.filter((e) => !accepted.includes(e)),
      acceptedButNotOfferedBySDK: accepted.filter((e) => !ts.includes(e)),
    }).toEqual({ offeredButRejectedByTheAPI: [], acceptedButNotOfferedBySDK: [] });
  });

  it("retains the resolved upstream catalog provenance", () => {
    // Guards the guard. AllowedEvents mixes literals and Event* references; a
    // parser that only saw literals would compare a fraction of the list and
    // pass vacuously. At least one entry must have arrived via a constant.
    const refLines = contractData().resolvedEventConstantReferences;
    expect(refLines).toBeGreaterThan(0);
    expect(contractAllowedEvents().length).toBeGreaterThanOrEqual(10);
  });
});
