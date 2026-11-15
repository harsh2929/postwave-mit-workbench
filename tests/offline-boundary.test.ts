import { connect } from "node:net";
import { expect, it } from "vitest";
it("refuses an unmocked socket before a service can be contacted", () => {
  expect(() => connect({ host: "example.invalid", port: 443 })).toThrow("Unmocked network access is disabled");
});
