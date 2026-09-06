import assert from "node:assert/strict";
import test from "node:test";
import { svixHeaders } from "./svix.mjs";

test("Svix signing matches the fixed official verification example", () => {
  // Source: https://docs.svix.com/receiving/verifying-payloads/how
  // A fixed provider result detects errors that a second copy of our signing
  // expression would miss. Preserve the space in the published raw JSON.
  const input = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", rawBody: '{"test": 2432232314}',
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" };
  const headers = svixHeaders(input, 1614265330);
  assert.equal(headers["svix-signature"], "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  assert.equal(headers["svix-id"], input.id);
  assert.equal(headers["svix-timestamp"], "1614265330");
  assert.notEqual(svixHeaders({ ...input, rawBody: JSON.stringify(JSON.parse(input.rawBody)) }, 1614265330)["svix-signature"], headers["svix-signature"]);
});
