import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { test } from "node:test";
import { createServer, serve } from "@emulators/core";
import { VENDORS } from "../registry.mjs";
import { configureLinearWebhookDelivery } from "./linear.mjs";
import { importPatchedProvider } from "./pinned-bundle.mjs";

const loaded = await VENDORS.linear.load();
const secret = "linear-webhook-secret";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(t, handler, options = {}) {
  const received = [];
  const receiver = httpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw);
    received.push({ raw, body, headers: request.headers });
    assert.equal(request.method, "POST");
    assert.equal(request.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(request.headers["accept-charset"], "utf-8");
    assert.equal(request.headers["user-agent"], "Linear-Webhook");
    assert.match(request.headers["linear-delivery"], uuid);
    assert.equal(request.headers["linear-event"], body.type);
    assert.equal(request.headers["linear-timestamp"], String(body.webhookTimestamp));
    assert.equal(request.headers["linear-signature"], createHmac("sha256", secret).update(raw).digest("hex"));
    assert.equal(request.headers["x-github-event"], undefined);
    if (handler) return handler(request, response, body);
    response.end();
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => { receiver.closeAllConnections(); receiver.close(); });
  const server = createServer(loaded.plugin, { port: 0, baseUrl: "http://linear.test",
    tokens: { token: { login: "alice@fixture.test", scopes: ["admin", "read", "write"] },
      bob: { login: "bob@fixture.test", scopes: ["admin", "read", "write"] },
      app: { login: "fixture-bot@apps.linear.local", scopes: ["admin", "read", "write"] } } });
  loaded.seedFromConfig(server.store, "http://linear.test", {
    organization: { name: "Fixture", url_key: "fixture" }, users: [
      { email: "alice@fixture.test", name: "Alice", admin: true },
      { email: "bob@fixture.test", name: "Bob", admin: true },
      { email: "fixture-bot@apps.linear.local", name: "Fixture Bot" }],
    teams: [{ key: "ENG", name: "Engineering" }, { key: "SEC", name: "Private", private: true }],
    projects: [{ name: "Delivery", team: "ENG" }], cycles: [{ name: "Current", team: "ENG" }],
    strict_scopes: true,
  });
  const hooks = configureLinearWebhookDelivery(server.store, { retryDelays: [0, 1, 1], ...options });
  t.after(() => hooks.close());
  const listener = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => listener.listening ? resolve() : listener.once("listening", resolve));
  t.after(() => { listener.closeAllConnections(); listener.close(); });
  async function query(query, variables = {}, token = "token") {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/graphql`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const answer = await response.json();
    assert.equal(answer.errors, undefined, JSON.stringify(answer.errors));
    return answer.data;
  }
  async function subscribe(input = {}) {
    const result = await query("mutation($input:WebhookCreateInput!){webhookCreate(input:$input){success webhook{id secret enabled}}}", {
      input: { url: `http://127.0.0.1:${receiver.address().port}/webhook`, allPublicTeams: true,
        resourceTypes: ["Issue", "Comment", "IssueLabel"], secret, ...input },
    });
    assert.equal(result.webhookCreate.success, true);
    return result.webhookCreate.webhook;
  }
  async function issue(title = "Webhook task", teamId = "ENG") {
    const answer = await query("mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id title description url createdAt updatedAt team{id} creator{id}}}}", {
      input: { teamId, title, description: "Description" },
    });
    return answer.issueCreate.issue;
  }
  return { ...server, hooks, received, query, subscribe, issue };
}

test("Linear registry sends signed native issue create/update/remove with exact live IDs and previous changed values", async (t) => {
  const f = await fixture(t);
  const hook = await f.subscribe();
  const created = await f.issue();
  await f.query("mutation($id:String!){issueUpdate(id:$id,input:{title:\"Changed\"}){success issue{id}}}", { id: created.id });
  await f.query("mutation($id:String!){issueDelete(id:$id){success}}", { id: created.id });
  await f.hooks.drain();
  assert.deepEqual(f.received.map((row) => row.body.action), ["create", "update", "remove"]);
  const organization = f.store.collection("linear.organizations").all()[0].linear_id;
  for (const { body } of f.received) {
    assert.equal(body.type, "Issue");
    assert.equal(body.webhookId, hook.id);
    assert.equal(body.organizationId, organization);
    assert.equal(body.actor.id, created.creator.id);
    assert.equal(body.actor.type, "user");
    assert.equal(body.data.id, created.id);
    assert.equal(body.url, created.url);
    assert.ok(Math.abs(Date.now() - body.webhookTimestamp) < 5000);
    assert.equal(body.api_version, undefined);
  }
  assert.equal(f.received[0].body.data.title, created.title);
  assert.equal(f.received[1].body.data.title, "Changed");
  assert.equal(f.received[1].body.updatedFrom.title, created.title);
  assert.equal(f.received[1].body.updatedFrom.id, undefined);
  assert.equal(f.received[1].body.updatedFrom.description, undefined);
  assert.equal(f.received[2].body.data.title, "Changed");
});

test("Linear comment and label mutations use the corresponding native resource and action", async (t) => {
  const f = await fixture(t);
  await f.subscribe({ resourceTypes: ["Comment", "IssueLabel"] });
  const issue = await f.issue();
  const { commentCreate } = await f.query("mutation($id:String!){commentCreate(input:{issueId:$id,body:\"Before\"}){comment{id body user{id}}}}", { id: issue.id });
  await f.query("mutation($id:String!){commentUpdate(id:$id,input:{body:\"After\"}){success}}", { id: commentCreate.comment.id });
  await f.query("mutation($id:String!){commentDelete(id:$id){success}}", { id: commentCreate.comment.id });
  const { issueLabelCreate } = await f.query("mutation{issueLabelCreate(input:{name:\"Urgent\",teamId:\"ENG\"}){issueLabel{id name}}}");
  await f.query("mutation($id:String!){issueLabelUpdate(id:$id,input:{name:\"Soon\"}){success}}", { id: issueLabelCreate.issueLabel.id });
  await f.query("mutation($id:String!){issueLabelDelete(id:$id){success}}", { id: issueLabelCreate.issueLabel.id });
  await f.hooks.drain();
  assert.deepEqual(f.received.map((row) => [row.body.type, row.body.action]), [
    ["Comment", "create"], ["Comment", "update"], ["Comment", "remove"],
    ["IssueLabel", "create"], ["IssueLabel", "update"], ["IssueLabel", "remove"],
  ]);
  assert.equal(f.received[0].body.data.id, commentCreate.comment.id);
  assert.equal(f.received[0].body.data.issueId, issue.id);
  assert.equal(f.received[0].body.data.userId, commentCreate.comment.user.id);
  assert.equal(f.received[0].body.url, `${issue.url}#comment-${commentCreate.comment.id}`);
  assert.equal(f.received[0].body.data.edited, false);
  assert.equal(f.received[0].body.data.editedAt, null);
  assert.equal(f.received[1].body.data.edited, true);
  assert.ok(Number.isFinite(Date.parse(f.received[1].body.data.editedAt)));
  assert.equal(f.received[1].body.updatedFrom.editedAt, null);
  assert.equal(f.received[2].body.data.edited, true);
  assert.equal(f.received[2].body.data.editedAt, f.received[1].body.data.editedAt);
  assert.equal(f.received[1].body.updatedFrom.body, "Before");
  assert.equal(f.received[4].body.updatedFrom.name, "Urgent");
  assert.equal(f.received[3].body.data.isGroup, false);
});

test("Linear issue payload retains stored relations, dates, labels, and the user who made the change", async (t) => {
  const f = await fixture(t);
  await f.subscribe({ resourceTypes: ["Issue"] });
  const issue = await f.issue('Unicode: café ✓; quotes: " and newline\n');
  const { issueLabelCreate: { issueLabel: label } } = await f.query(
    'mutation{issueLabelCreate(input:{name:"Review",color:"#123456",teamId:"ENG"}){issueLabel{id name color}}}');
  const { projects, cycles, viewer } = await f.query(
    "{projects{nodes{id}} cycles{nodes{id}} viewer{id name email url avatarUrl}}", {}, "bob");
  const { issueUpdate: { issue: changed } } = await f.query(
    `mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){issue{
      id number creator{id} project{id} cycle{id} assignee{id} dueDate startedAt completedAt canceledAt
    }}}`, { id: issue.id, input: { projectId: projects.nodes[0].id, cycleId: cycles.nodes[0].id,
      assigneeId: viewer.id, dueDate: "2026-09-30", priority: 2, stateId: "Done", labelIds: [label.id] } }, "bob");
  await f.query("mutation($id:String!,$label:String!){issueRemoveLabel(id:$id,labelId:$label){success}}",
    { id: issue.id, label: label.id });
  await f.query("mutation($id:String!,$label:String!){issueAddLabel(id:$id,labelId:$label){success}}",
    { id: issue.id, label: label.id });
  await f.hooks.drain();
  const [created, updated, removed, added] = f.received.map(({ body }) => body);
  assert.equal(created.data.title, issue.title);
  assert.deepEqual(updated.actor, { ...viewer, type: "user" });
  assert.equal(updated.data.creatorId, issue.creator.id);
  assert.equal(updated.data.number, changed.number);
  assert.equal(updated.data.priorityLabel, "High");
  assert.equal(updated.updatedFrom.priorityLabel, "No priority");
  assert.equal(updated.data.projectId, changed.project.id);
  assert.equal(updated.data.cycleId, changed.cycle.id);
  assert.equal(updated.data.assigneeId, changed.assignee.id);
  for (const field of ["dueDate", "startedAt", "completedAt", "canceledAt"]) {
    assert.equal(updated.data[field], changed[field]);
  }
  assert.ok(changed.completedAt);
  for (const field of ["projectId", "cycleId", "assigneeId", "dueDate", "completedAt"]) {
    assert.equal(updated.updatedFrom[field], null);
  }
  assert.deepEqual(updated.data.labelIds, [label.id]);
  assert.deepEqual(updated.data.labels, [label]);
  assert.deepEqual(updated.updatedFrom.labelIds, []);
  assert.equal(updated.updatedFrom.creatorId, undefined);
  assert.deepEqual(removed.updatedFrom.labelIds, [label.id]);
  assert.deepEqual(removed.data.labelIds, []);
  assert.deepEqual(added.updatedFrom.labelIds, []);
  assert.deepEqual(added.data.labelIds, [label.id]);
});

test("Linear single-team subscriptions include private teams and ignore other teams and disabled hooks", async (t) => {
  const f = await fixture(t);
  const hook = await f.subscribe({ allPublicTeams: false, teamId: "SEC", resourceTypes: ["Issue"] });
  await f.subscribe({ enabled: false });
  await f.issue("Public");
  const issue = await f.issue("Private", "SEC");
  await f.hooks.drain();
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].body.data.id, issue.id);
  assert.equal(f.received[0].body.webhookId, hook.id);
});

test("Linear app users retain the User actor shape and their actual resource identity", async (t) => {
  const f = await fixture(t);
  // App actors cannot be declared in world source. Exercise an existing app
  // User record, as found in the pinned provider or an older state snapshot.
  const users = f.store.collection("linear.users");
  const bot = users.all().find((user) => user.email === "fixture-bot@apps.linear.local");
  users.update(bot.id, { app: true });
  await f.subscribe({ resourceTypes: ["Issue"] });
  const { viewer: { app, ...viewer } } = await f.query("{viewer{id name email url avatarUrl app}}", {}, "app");
  assert.equal(app, true);
  const { issueCreate: { issue } } = await f.query(
    'mutation{issueCreate(input:{teamId:"ENG",title:"App issue"}){issue{id creator{id}}}}', {}, "app");
  await f.hooks.drain();
  assert.equal(f.received.length, 1);
  assert.deepEqual(f.received[0].body.actor, { ...viewer, type: "user" });
  assert.equal(f.received[0].body.actor.id, issue.creator.id);
  assert.equal(f.received[0].body.data.creatorId, viewer.id);
});

test("Linear stops after three retries and does not follow receiver redirects", async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: "/redirect-target" }); response.end();
  });
  await f.subscribe();
  await f.issue();
  await f.hooks.drain();
  assert.equal(f.received.length, 4);
  assert.deepEqual(f.store.collection("linear.webhook_deliveries").all().map(({ status }) => status), [302, 302, 302, 302]);
});

test("Linear retries requests that exceed the response timeout", async (t) => {
  const f = await fixture(t, () => {}, { timeoutMs: 30 });
  await f.subscribe();
  await f.issue();
  await f.hooks.drain();
  const deliveries = f.store.collection("linear.webhook_deliveries").all();
  assert.equal(deliveries.length, 4);
  for (const delivery of deliveries) {
    assert.equal(delivery.status, null);
    assert.match(delivery.error, /timeout|aborted/i);
  }
});

test("Linear archive and unarchive are data update actions with the previous archivedAt", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  const issue = await f.issue();
  await f.query("mutation($id:String!){issueArchive(id:$id){success}}", { id: issue.id });
  await f.query("mutation($id:String!){issueUnarchive(id:$id){success}}", { id: issue.id });
  await f.hooks.drain();
  assert.deepEqual(f.received.map((row) => row.body.action), ["create", "update", "update"]);
  assert.equal(f.received[1].body.updatedFrom.archivedAt, null);
  const oldUpdatedAt = f.received[0].body.data.updatedAt;
  assert.equal(f.received[1].body.updatedFrom.updatedAt,
    oldUpdatedAt === f.received[1].body.data.updatedAt ? undefined : oldUpdatedAt);
  assert.equal(f.received[1].body.updatedFrom.id, undefined);
  assert.equal(f.received[2].body.updatedFrom.archivedAt, f.received[1].body.data.archivedAt);
  assert.equal(f.received[2].body.data.archivedAt, null);
});

test("Linear retries non-200 results using documented delays and stable delivery IDs", async (t) => {
  let attempts = 0;
  const delays = [];
  const f = await fixture(t, (_request, response) => { response.statusCode = ++attempts < 4 ? 204 : 200; response.end(); }, {
    retryDelays: [60_000, 3_600_000, 21_600_000], sleep: async (ms) => { delays.push(ms); },
  });
  await f.subscribe();
  await f.issue();
  await f.hooks.drain();
  assert.equal(f.received.length, 4);
  assert.equal(new Set(f.received.map((row) => row.headers["linear-delivery"])).size, 1);
  assert.equal(new Set(f.received.map((row) => row.body.data.id)).size, 1);
  assert.deepEqual(delays, [60_000, 3_600_000, 21_600_000]);
});

test("Linear mutation responds before a slow receiver and respects team/resource/delete filters", async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, async (_request, response) => { await waiting; response.end(); });
  t.after(() => release());
  const hook = await f.subscribe({ resourceTypes: ["Issue"] });
  await f.issue("Private", "SEC");
  const created = await f.issue("Public");
  assert.match(created.id, uuid, "mutation returns while receiver is still waiting");
  release();
  await f.hooks.drain();
  assert.equal(f.received.length, 1);
  await f.query("mutation($id:String!){webhookDelete(id:$id){success}}", { id: hook.id });
  await f.issue("No subscription");
  await f.hooks.drain();
  assert.equal(f.received.length, 1);
});

test("Linear creates a signing secret when none is supplied", async (t) => {
  const f = await fixture(t);
  const hook = await f.subscribe({ secret: null });
  assert.match(hook.secret, /^[0-9a-f]{64}$/);
});

test("pinned provider adapter rejects source drift", async () => {
  await assert.rejects(importPatchedProvider({ url: import.meta.url, sha256: "0".repeat(64), replacements: [] }), /source changed/);
});
