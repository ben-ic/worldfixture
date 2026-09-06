import assert from "node:assert/strict";
import test from "node:test";
import { createWebhookTransport } from "./transport.mjs";

test("close cancels scheduled and active deliveries, including a late response", async () => {
  let respond, scheduled, cancelled = 0;
  const transport = createWebhookTransport({ retryDelays: [1],
    fetchImpl: async url => url.endsWith("/active") ? new Promise(resolve => { respond = resolve; }) : new Response(null, { status: 500 }),
    setTimer: fn => { scheduled = fn; return 1; }, clearTimer: () => { cancelled++; } });
  const retrying = transport.enqueue({ url: "https://receiver.test/retry", rawBody: "{}" });
  await transport.drain();
  assert.equal(retrying.status, "retrying");
  const active = transport.enqueue({ url: "https://receiver.test/active", rawBody: "{}" });
  transport.close();
  assert.equal(retrying.status, "cancelled");
  assert.equal(active.status, "cancelled");
  assert.equal(cancelled, 1);
  respond(new Response(null, { status: 200 }));
  scheduled();
  await transport.drain();
  assert.equal(active.status, "cancelled");
  assert.equal(retrying.attempts, 1);
});

test("an accepted HTTP status is not retried when response body cancellation fails", async () => {
  const transport = createWebhookTransport({ retryDelays: [1], fetchImpl: async () => ({ ok: true, status: 200,
    body: { cancel: async () => { throw new Error("body stream failed"); } } }) });
  const delivery = transport.enqueue({ url: "https://receiver.test", rawBody: "{}" });
  await transport.drain();
  assert.equal(delivery.status, "succeeded");
  transport.close();
});
