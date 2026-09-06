import assert from "node:assert/strict";
import test from "node:test";
import { readLinearOverview, readStripeOverview } from "./workbench-provider-data.mjs";
import { providerOverview, surfaceReadiness, workbenchBindingGroups } from "./workbench.mjs";

test("Stripe totals require every page and preserve transaction/recurrence fields", async () => {
  const calls = [];
  const result = await readStripeOverview(async path => {
    calls.push(path);
    const url = new URL(path, "http://local.test"), key = url.pathname.split("/").at(-1);
    if (key !== "charges") return { data: [], has_more: false };
    return url.searchParams.has("starting_after") ? { data: [{ id: "last", amount: 51, currency: "jpy", paid: true }], has_more: false }
      : { data: Array.from({ length: 100 }, (_, id) => ({ id: `charge-${id}`, amount: 101, currency: "usd", paid: true })), has_more: true };
  });
  assert.equal(result.charges.length, 101);
  assert.deepEqual(result.charges.at(-1), { id: "last", amount: 51, currency: "jpy", paid: true });
  assert.equal(result.collectionStatus.charges.status, "complete");
  assert.ok(calls.includes("/v1/charges?limit=100&starting_after=charge-99"));
  assert.ok(calls.includes("/v1/subscriptions?limit=100&status=all"));
});

test("a failed Stripe later page or missing metadata cannot report a complete zero or partial total", async () => {
  const result = await readStripeOverview(async path => {
    const url = new URL(path, "http://local.test");
    if (url.pathname.endsWith("charges")) {
      if (url.searchParams.has("starting_after")) throw new Error("provider offline");
      return { data: [{ id: "charge-1", amount: 100 }], has_more: true };
    }
    if (url.pathname.endsWith("refunds")) return { data: [] };
    return { data: [], has_more: false };
  });
  assert.equal(result.charges.length, 1);
  assert.equal(result.collectionStatus.charges.status, "failed");
  assert.match(result.collectionStatus.charges.error, /offline/);
  assert.equal(result.collectionStatus.refunds.status, "failed");
  assert.equal(result.collectionStatus.customers.status, "complete");
});

test("Linear reads all pages, retains provider state identity/type, and rejects repeated cursors", async () => {
  const calls = [];
  const read = async query => {
    calls.push(query);
    if (query.includes("organization {")) return { data: { organization: { id: "org", name: "Mono" } } };
    const key = query.match(/\{ (\w+)\(/)[1];
    const first = !query.includes("after:");
    return { data: { [key]: { nodes: key === "issues" ? [{ id: first ? "issue-1" : "issue-2",
      state: { id: "state-9", name: "準備中", type: "unstarted" }, labels: { nodes: [] } }] : [],
      pageInfo: { hasNextPage: key === "issues" && first, endCursor: first ? "page-2" : null } } } };
  };
  const result = await readLinearOverview(read);
  assert.equal(result.issues.length, 2);
  assert.deepEqual(result.issues[1].state, { id: "state-9", name: "準備中", type: "unstarted" });
  assert.equal(result.collectionStatus.issues.status, "complete");
  assert.ok(calls.some(query => query.includes('after: "page-2"')));
  const damaged = await readLinearOverview(async query => {
    const value = await read(query);
    if (value.data.issues) { value.data.issues.pageInfo = { hasNextPage: true, endCursor: "page-2" }; }
    return value;
  });
  assert.equal(damaged.collectionStatus.issues.status, "failed");
  assert.match(damaged.collectionStatus.issues.error, /cursor/);
});

test("selected services and every capability binding remain visible before readiness", () => {
  const instance = { lock: { services: [{ name: "emulate", version: "1", readiness: [{ kind: "protocol", port: "unusual_api" }] }],
    capabilities: { "unusual.events.v1": { service: "emulate", port: "unusual_api" } },
    bindings: { ODD_CREDENTIAL: { service: "emulate", port: "unusual_api", profile: "unusual.events.v1" } } },
    serviceStates: new Map([["emulate", "running"]]), readiness: new Map() };
  const [surface] = surfaceReadiness(instance);
  assert.equal(surface.id, "unusual_api");
  assert.equal(surface.state, "starting");
  assert.deepEqual(surface.capabilities, ["unusual.events.v1"]);
  assert.deepEqual(workbenchBindingGroups(instance, { ODD_CREDENTIAL: "secret" })[0].bindings, ["ODD_CREDENTIAL"]);
  instance.readiness.set("emulate", { checks: [{ kind: "protocol", port: "unusual_api", ok: true }] });
  assert.equal(surfaceReadiness(instance)[0].state, "ready");
});

test("an omitted provider is unavailable, not a successful empty read", async () => {
  const result = await providerOverview({}, "/missing", {});
  assert.equal(result.stripe.status, "not-selected");
  assert.equal(result.slack.available, false);
  assert.equal(result.website.status, "not-selected");
  assert.deepEqual(result.errors, []);
});
