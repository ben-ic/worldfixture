// Load in host-only tests, including child processes through NODE_OPTIONS.
// Check the actual socket address so omitted hosts and IPv6 wildcard binds fail.
import assert from "node:assert/strict";
import { Server } from "node:net";

const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address !== "string") {
      assert.ok(["127.0.0.1", "::1"].includes(address.address), `Host test opened a non-loopback listener: ${address.address}:${address.port}`);
    }
  });
  return listen.apply(this, args);
};
