import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";
import { VENDORS } from "./registry.mjs";
import { seedWorldLinear } from "./world-linear-seed.mjs";

const world = { id: "consumer.unusual", version: "v7", digest: "a".repeat(64) };
const plugin = await VENDORS.linear.load();
function fixture() {
  const config = { organization: { name: "Unusual", url_key: "unusual" }, users: [{ email: "solo@fixture.test", name: "Solo", admin: true }],
    teams: [{ key: "ODD", name: "Unusual team", states: [{ name: "Queued", type: "unstarted" }] }],
    labels: ["Owner", "Review"].map(name => ({ name, team: "ODD" })),
    issues: ["task.a", "task.b", "task.c"].map(id => ({ worldfixture_task_id: id, team: "ODD", title: "Same title",
      description: "Same description", state: "Queued", assignee: "solo@fixture.test", labels: ["Owner", "Review"] })), strict_scopes: false };
  const server = createServer(plugin.plugin, { tokens: { scratch: { login: "solo@fixture.test", id: 1, scopes: [] } } });
  const calls = [], seeds = [];
  const options = { world, config, token: "scratch", actorEmail: "solo@fixture.test", baseUrl: "http://linear.test", pageSize: 1,
    seedFromConfig: input => { seeds.push(input); plugin.seedFromConfig(server.store, "http://linear.test", input); },
    fetchImpl: (url, init) => { calls.push(JSON.parse(init.body)); return server.app.fetch(new Request(url, init)); } };
  return { server, options, calls, seeds };
}

test("Linear creates identical task content under distinct source-to-provider IDs through pinned API", async () => {
  const env = fixture(), before = JSON.stringify(env.options.config);
  const receipt = await seedWorldLinear(env.options);
  assert.equal(receipt.issues.length, 3);
  assert.equal(new Set(receipt.issues.map(issue => issue.provider_issue_id)).size, 3);
  assert.deepEqual(receipt.issues.map(issue => issue.source_task_id), ["task.a", "task.b", "task.c"]);
  assert.deepEqual(env.seeds[0].issues, [], "the title-deduplicating upstream seed is bypassed");
  assert.equal(JSON.stringify(env.options.config), before);
  assert.ok(env.calls.some(call => call.variables.after), "all issue and label pages must be read");
  assert.equal(env.calls.filter(call => call.query.startsWith("mutation")).length, 3);
  assert.equal(JSON.stringify(receipt).includes("scratch"), false);
});

test("Linear snapshot restore uses saved IDs without repeating API mutations", async () => {
  const env = fixture(), receipt = await seedWorldLinear(env.options);
  const restored = fixture();
  restored.server.store.restore(env.server.store.snapshot());
  const result = await seedWorldLinear({ ...restored.options, receipt: JSON.parse(JSON.stringify(receipt)),
    seedFromConfig() { assert.fail("restore must not seed"); } });
  assert.deepEqual(result, receipt);
  assert.equal(restored.calls.some(call => call.query.startsWith("mutation")), false);
  await assert.rejects(seedWorldLinear({ ...restored.options, receipt: { ...receipt, world: { ...world, digest: "b".repeat(64) } } }), /saved receipt world/);
});

test("Linear does not return an accepted receipt after a failed middle mutation", async () => {
  const env = fixture(), fetchImpl = env.options.fetchImpl;
  let creates = 0;
  await assert.rejects(seedWorldLinear({ ...env.options, fetchImpl: (url, init) => {
    if (JSON.parse(init.body).query.startsWith("mutation") && ++creates === 2) return Promise.resolve(Response.json({ errors: [{ message: "controlled failure" }] }));
    return fetchImpl(url, init);
  } }), /GraphQL errors/);
  assert.equal(creates, 2);
});

test("Linear detects missing, foreign and changed live issues without matching titles", async t => {
  for (const damage of ["missing", "foreign", "body"]) await t.test(damage, async () => {
    const env = fixture(), fetchImpl = env.options.fetchImpl;
    await assert.rejects(seedWorldLinear({ ...env.options, fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init), body = await response.json();
      const query = JSON.parse(init.body).query;
      if (query.includes("id title description") && body.data?.issues?.nodes.length) {
        if (damage === "missing") body.data.issues.nodes = [];
        if (damage === "foreign") body.data.issues.nodes[0].id = `foreign-${body.data.issues.nodes[0].id}`;
        if (damage === "body") body.data.issues.nodes[0].description = "Changed";
      }
      return Response.json(body, { status: response.status });
    } }), /verification failed/);
  });
});

test("Linear rejects duplicate source IDs before normal seed writes", async () => {
  const env = fixture(); env.options.config.issues[1].worldfixture_task_id = "task.a";
  await assert.rejects(seedWorldLinear(env.options), /Duplicate Linear source task ID/);
  assert.equal(env.seeds.length, 0);
});

test("Linear rejects malformed receipts, failed HTTP and repeated pagination cursors", async () => {
  const env = fixture();
  await assert.rejects(seedWorldLinear({ ...env.options, fetchImpl: async () => new Response("down", { status: 503 }) }), /HTTP 503/);
  const repeated = fixture(), fetchImpl = repeated.options.fetchImpl;
  await assert.rejects(seedWorldLinear({ ...repeated.options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init), body = await response.json();
    if (body.data?.users) body.data.users.pageInfo = { hasNextPage: true, endCursor: "same" };
    return Response.json(body);
  } }), /cursor did not advance/);
  const restored = fixture(), receipt = await seedWorldLinear(restored.options);
  receipt.issues[1].provider_issue_id = receipt.issues[0].provider_issue_id;
  await assert.rejects(seedWorldLinear({ ...restored.options, receipt }), /Duplicate Linear receipt provider ID/);
});

test("Linear checks a declared actor and cancellation before writes", async () => {
  const env = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(seedWorldLinear({ ...env.options, actorEmail: "foreign@fixture.test" }), /not a declared user/);
  await assert.rejects(seedWorldLinear({ ...env.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(env.seeds.length, 0);
});
