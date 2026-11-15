// This unit-test workbench has no live-provider or application-server dependency.
// Intercept the socket boundary so missing mocks fail instead of reaching a service.
import { Socket } from "node:net";
Socket.prototype.connect = function blockedNetwork(): never {
  throw new Error("Unmocked network access is disabled in the SDK workbench");
} as typeof Socket.prototype.connect;
