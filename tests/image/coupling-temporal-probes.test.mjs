import assert from "node:assert/strict";
import test from "node:test";
import { observeFeeds } from "./coupling-temporal-probes.mjs";

const base = "http://feed.test";
const feeds = [{ path: "/rss", items: [
  { id: "initial", title: "Initial", summary: "First", path: "/first", published_at: "2026-01-01T00:00:00Z" },
  { id: "later", title: "Later", summary: "Second", path: "/second", published_at: "2026-01-02T00:00:00Z", available_after_seconds: 5 },
] }];
async function scenario({ early = false, missing = false, duplicate = false, changed = false, lateStart = false, visibleAt = 5500 } = {}) {
  let clock = lateStart ? 7000 : 1000;
  return observeFeeds({ feeds, base, launchAt: 0, readyAt: clock, now: () => clock, wait: async ms => { clock += ms; },
    fetchImpl: async () => {
      const items = feeds[0].items.filter(item => item.id === "initial" || (!missing && (early || clock >= visibleAt)));
      if (duplicate) items.push(items[0]);
      const xml = items.map(item => `<item><guid>${item.id}</guid><title>${changed ? "Wrong" : item.title}</title><description>${item.summary}</description><link>${base}${item.path}</link><pubDate>${new Date(item.published_at).toUTCString()}</pubDate></item>`).join("");
      return new Response(`<rss><channel>${xml}</channel></rss>`);
    } });
}
test("temporal reader observes real transitions within process-start bounds", async () => {
  const result = await scenario();
  assert.ok(result.checks.length > 0);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.equal(result.coverage[0].status, "passed");
});
test("early, missing, duplicate and changed feed records fail temporal evidence", async () => {
  for (const input of [{ early: true }, { missing: true }, { duplicate: true }, { changed: true }]) {
    const result = await scenario(input);
    assert.equal(result.coverage[0].status, "failed", JSON.stringify(input));
  }
});
test("a missed pre-arrival observation cannot claim complete temporal coverage", async () => {
  const result = await scenario({ lateStart: true });
  assert.equal(result.checks.find(check => check.check.endsWith("/rss.later") && check.check.includes("observed-transition")).status, "failed");
});
test("temporal observation honors cancellation before reads", async () => {
  await assert.rejects(observeFeeds({ feeds, base, launchAt: 0, readyAt: 0, now: () => 0,
    signal: AbortSignal.abort(new Error("stop temporal test")), fetchImpl: () => assert.fail("must not read") }), /stop temporal test/);
});
test("failed temporal HTTP reads retain their response evidence", async () => {
  const responses = [];
  await assert.rejects(observeFeeds({ feeds, base, launchAt: 0, readyAt: 0, now: () => 0, responses,
    fetchImpl: async () => new Response("unavailable", { status: 503 }) }), /HTTP 503/);
  assert.equal(responses[0].status, 503);
  assert.equal(responses[0].body, "unavailable");
});
test("temporal evidence states the observation window rather than an exact delivery time", async () => {
  const result = await scenario({ visibleAt: 4500 });
  const transition = result.checks.find(check => check.check === "http.temporal.observed-transition./rss.later");
  assert.deepEqual(transition.observation_window, [4000, 7000]);
  assert.match(transition.detail, /does not prove its exact time/);
});
