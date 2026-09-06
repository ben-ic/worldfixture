import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationClient } from "./api.js";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const result = (value, generation, status = 200) => new Response(JSON.stringify(value), { status, headers: { "X-WorldFixture-Generation": generation } });
test("managed mutations use the captured generation and preserve custom Headers", async () => {
  let received;
  const client = createGenerationClient(async (_url, options) => { received = options; return result({ ok: true }, "one"); });
  client.setSession({ generation: "one", phase: "ready" });
  await client.request("/api/actions/domain", { method: "POST", headers: new Headers({ "x-test": "present", "X-WorldFixture-Generation": "forged" }) });
  assert.equal(received.headers.get("X-WorldFixture-Generation"), "one"); assert.equal(received.headers.get("x-test"), "present");
});
test("an old result is rejected after its response headers arrive but before its body finishes", async () => {
  const pending = deferred();
  const client = createGenerationClient(async () => ({ status: 200, headers: new Headers({ "X-WorldFixture-Generation": "one" }), text: () => pending.promise }));
  client.setSession({ generation: "one", phase: "ready" });
  const read = client.request("/api/overview");
  await new Promise(resolve => setImmediate(resolve)); client.setSession({ generation: "two", phase: "ready" }); pending.resolve('{"world":"old"}');
  await assert.rejects(read, error => error.code === "stale_generation");
});
test("a switch transition aborts old provider reads before the generation changes", async () => {
  const entered = deferred();
  const client = createGenerationClient(async (_url, { signal }) => { entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); });
  client.setSession({ generation: "one", phase: "ready" }); const read = client.request("/api/provider/gmail"); await entered.promise;
  client.setSession({ generation: "one", phase: "switching" });
  await assert.rejects(read, error => error.code === "stale_generation");
});
test("a switch result may confirm the new generation but cannot overwrite a later switch", async () => {
  const pending = deferred(); const client = createGenerationClient(() => pending.promise);
  client.setSession({ generation: "one", phase: "ready" }); const switching = client.request("/api/world/switch", { method: "POST" });
  client.setSession({ generation: "two", phase: "ready" }); pending.resolve(result({ generation: "two" }, "two"));
  assert.equal((await switching).generation, "two");
  const late = deferred(); const second = createGenerationClient(() => late.promise); second.setSession({ generation: "one", phase: "ready" });
  const old = second.request("/api/world/switch", { method: "POST" }); second.setSession({ generation: "three", phase: "ready" }); late.resolve(result({ generation: "two" }, "two"));
  await assert.rejects(old, error => error.code === "stale_generation");
});
test("raw clock errors preserve delivery evidence and reject a stale generation", async () => {
  const client = createGenerationClient(async () => result({ error: "Delivery failed", code: "delivery_failed", result: { played: [{ id: "due-one" }] } }, "one", 409));
  client.setSession({ generation: "one", phase: "ready" });
  const response = await client.response("/api/clock", { method: "POST" }); assert.equal(response.status, 409); assert.equal((await response.json()).result.played[0].id, "due-one");
  client.setSession({ generation: "two", phase: "ready" }); await assert.rejects(client.response("/api/clock"), error => error.code === "stale_generation");
});
