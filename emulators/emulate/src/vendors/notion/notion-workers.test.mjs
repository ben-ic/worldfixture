import assert from "node:assert/strict";
import test from "node:test";

import { WebhookVerificationError, Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

import { createNotionWorkersRuntime, notionWorkersRuntimeLimits } from "./workers-runtime.mjs";

function deterministicOptions(overrides = {}) {
  let sequence = 0;
  return {
    now: () => "2026-05-12T10:30:00.000Z",
    dateNow: () => 1_778_581_800_000,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    ...overrides,
  };
}

function taskDatabase(worker, type = "managed") {
  return worker.database("tasks", {
    type,
    initialTitle: "Tasks",
    primaryKeyProperty: "Task ID",
    schema: {
      properties: {
        Name: Schema.title(),
        "Task ID": Schema.richText(),
        Status: Schema.select([{ name: "Open", color: "blue" }, { name: "Done", color: "green" }]),
      },
    },
  });
}

test("uses the exact published Worker manifest for database, pacer, sync, tool, webhook, and OAuth", () => {
  const worker = new Worker();
  const tasks = taskDatabase(worker, "attached");
  const upstream = worker.pacer("upstream", { allowedRequests: 10, intervalMs: 1_000 });
  worker.sync("taskSync", { database: tasks, schedule: "manual", execute: async () => ({ changes: [], hasMore: false }) });
  worker.tool("lookup", { title: "Lookup", description: "Look up a task.", schema: j.object({ id: j.string() }), execute: ({ id }) => ({ id }) });
  worker.webhook("events", { title: "Events", description: "Accept events.", execute: () => {} });
  worker.oauth("github", {
    name: "github-oauth",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scope: "repo user",
    clientId: "client-id",
    clientSecret: "client-secret",
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  assert.equal(runtime.manifest.sdkVersion, "0.9.0");
  assert.deepEqual(runtime.manifest.databases, worker.manifest.databases);
  assert.deepEqual(runtime.manifest.pacers, [{ key: "upstream", config: { allowedRequests: 10, intervalMs: 1_000 } }]);
  assert.deepEqual(runtime.manifest.capabilities.map(({ _tag, key }) => ({ _tag, key })), [
    { _tag: "sync", key: "taskSync" },
    { _tag: "tool", key: "lookup" },
    { _tag: "webhook", key: "events" },
    { _tag: "oauth", key: "github" },
  ]);
  assert.equal(upstream.key, "upstream");
});

test("runs paginated replace syncs and commits stale deletion only after the final page", async () => {
  const worker = new Worker();
  const tasks = taskDatabase(worker);
  let cycle = 1;
  worker.sync("taskSync", {
    database: tasks,
    mode: "replace",
    schedule: "manual",
    execute: async (state) => {
      if (cycle === 2) return { changes: [], hasMore: false };
      const page = state?.page ?? 1;
      return {
        changes: [{
          type: "upsert",
          key: `task-${page}`,
          properties: {
            Name: Builder.title(`Task ${page}`),
            "Task ID": Builder.richText(`task-${page}`),
            Status: Builder.select(page === 1 ? "Open" : "Done"),
          },
          upstreamUpdatedAt: `2026-05-${String(10 + page).padStart(2, "0")}T10:00:00Z`,
          pageContentMarkdown: `# Task ${page}`,
        }],
        hasMore: page === 1,
        nextState: page === 1 ? { page: 2 } : undefined,
      };
    },
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  const first = await runtime.runSync("taskSync");
  assert.equal(first.pages, 2);
  assert.deepEqual(runtime.databaseRows("tasks").map(({ key }) => key), ["task-1", "task-2"]);
  assert.equal(runtime.databaseRows("tasks")[1].pageContentMarkdown, "# Task 2");

  cycle = 2;
  await runtime.runSync("taskSync");
  assert.deepEqual(runtime.databaseRows("tasks"), []);
  assert.equal(runtime.runs().at(-1).kind, "sync");
});

test("executes the SDK pacer with deterministic persisted runtime state", async () => {
  const worker = new Worker();
  const tasks = taskDatabase(worker);
  const pacer = worker.pacer("api", { allowedRequests: 2, intervalMs: 2 });
  worker.sync("paced", {
    database: tasks,
    schedule: "manual",
    execute: async () => {
      await pacer.wait();
      await pacer.wait();
      return { changes: [], hasMore: false };
    },
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  await runtime.runSync("paced");
  assert.deepEqual(runtime.pacerState(), {
    api: { lastScheduledAtMs: 1_778_581_800_001, allowedRequests: 2, intervalMs: 2 },
  });
});

test("supports incremental upserts, explicit deletes, cross-database targets, and cursor persistence", async () => {
  const worker = new Worker();
  const tasks = taskDatabase(worker);
  worker.database("archive", {
    type: "managed",
    initialTitle: "Archive",
    primaryKeyProperty: "Task ID",
    schema: tasks.config.schema,
  });
  let invocation = 0;
  worker.sync("delta", {
    database: tasks,
    mode: "incremental",
    schedule: "1m",
    execute: async (state) => {
      invocation += 1;
      if (invocation === 1) {
        assert.equal(state, undefined);
        return {
          changes: [{
            type: "upsert",
            key: "task-1",
            targetDatabaseKey: "archive",
            properties: { Name: Builder.title("Task 1"), "Task ID": Builder.richText("task-1"), Status: Builder.select("Open") },
          }],
          hasMore: false,
          nextState: { cursor: "cursor-1" },
        };
      }
      assert.deepEqual(state, { cursor: "cursor-1" });
      return { changes: [{ type: "delete", key: "task-1", targetDatabaseKey: "archive" }], hasMore: false, nextState: { cursor: "cursor-2" } };
    },
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  await runtime.runSync("delta");
  assert.deepEqual(runtime.databaseRows("archive").map(({ key }) => key), ["task-1"]);
  await runtime.runSync("delta");
  assert.deepEqual(runtime.databaseRows("archive"), []);
  assert.deepEqual(runtime.syncState("delta"), { cursor: "cursor-2" });
});

test("executes tools through SDK input/output validation and injects OAuth access tokens", async () => {
  const worker = new Worker();
  const auth = worker.oauth("github", {
    name: "github-oauth",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    scope: "repo",
    clientId: "client-id",
    clientSecret: "client-secret",
  });
  worker.tool("repository", {
    title: "Repository",
    description: "Returns repository metadata.",
    schema: j.object({ owner: j.string(), private: j.boolean() }),
    outputSchema: j.object({ owner: j.string(), token: j.string() }),
    hints: { readOnlyHint: true },
    execute: async ({ owner }) => ({ owner, token: await auth.accessToken() }),
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions({ oauthTokens: { github: "github-token" } }));
  assert.deepEqual(await runtime.runTool("repository", { owner: "lumen", private: false }), { owner: "lumen", token: "github-token" });
  await assert.rejects(runtime.runTool("repository", { owner: "lumen" }), { name: "InvalidToolInputError" });
  runtime.setOAuthAccessToken("github", "rotated-token");
  assert.equal((await runtime.runTool("repository", { owner: "lumen", private: true })).token, "rotated-token");
  assert.equal(process.env.OAUTH_6769746875622D6F61757468_ACCESS_TOKEN, undefined);
});

test("accepts webhook ingress, preserves the documented event shape, and retries ordinary failures", async () => {
  const worker = new Worker();
  const observed = [];
  let attempts = 0;
  worker.webhook("github", {
    title: "GitHub",
    description: "Accept GitHub events.",
    execute: (events) => {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary failure");
      observed.push(...events);
    },
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  const accepted = await runtime.receiveWebhook("github", {
    method: "POST",
    url: "https://www.notion.com/webhooks/worker/space/worker/secret/github",
    headers: { "X-GitHub-Event": "push" },
    rawBody: JSON.stringify({ ref: "refs/heads/main" }),
    deliveryId: "delivery-from-notion",
  });
  assert.deepEqual(accepted, { status: 202, body: "", contentType: "text/plain", queued: true, deliveryId: "delivery-from-notion" });
  assert.equal(observed.length, 0);
  const completed = await runtime.drainWebhooks();
  assert.equal(completed[0].status, "succeeded");
  assert.equal(completed[0].attempts, 3);
  assert.deepEqual(observed[0], {
    deliveryId: "delivery-from-notion",
    body: { ref: "refs/heads/main" },
    rawBody: "{\"ref\":\"refs/heads/main\"}",
    headers: { "x-github-event": "push" },
    method: "POST",
  });
});

test("runs synchronous webhook verification before queueing and validates its response", async () => {
  const worker = new Worker();
  let executions = 0;
  worker.webhook("challenge", {
    title: "Challenge",
    description: "Verify a provider challenge.",
    verify: ({ query }) => query.token === "valid"
      ? { status: 200, body: query.challenge, contentType: "text/plain" }
      : { status: 401, body: "invalid", contentType: "text/plain" },
    execute: () => { executions += 1; },
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  const rejected = await runtime.receiveWebhook("challenge", { method: "GET", url: "https://local.invalid/hook?token=bad&challenge=no" });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.queued, false);
  const accepted = await runtime.receiveWebhook("challenge", { method: "GET", url: "https://local.invalid/hook?token=valid&challenge=yes" });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body, "yes");
  assert.equal(accepted.queued, true);
  await runtime.drainWebhooks();
  assert.equal(executions, 1);
});

test("does not retry verification errors and blocks a webhook after five consecutive failures", async () => {
  const worker = new Worker();
  let attempts = 0;
  worker.webhook("signed", {
    title: "Signed",
    description: "Requires a valid signature.",
    execute: () => {
      attempts += 1;
      throw new WebhookVerificationError("bad signature");
    },
  });

  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  for (let count = 0; count < notionWorkersRuntimeLimits.webhookBlockThreshold; count += 1) {
    const response = await runtime.receiveWebhook("signed", { rawBody: String(count) });
    assert.equal(response.status, 202);
    const [result] = await runtime.drainWebhooks();
    assert.equal(result.status, "verification_failed");
    assert.equal(result.attempts, 1);
  }
  const blocked = await runtime.receiveWebhook("signed", { rawBody: "blocked" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.queued, false);
  assert.equal(attempts, 5);
});

test("rejects sync output that cannot represent the declared managed database", async () => {
  const worker = new Worker();
  const tasks = taskDatabase(worker);
  worker.sync("invalid", {
    database: tasks,
    execute: async () => ({
      changes: [{ type: "upsert", key: "task-1", properties: { Name: Builder.title("Task") } }],
      hasMore: false,
    }),
  });
  const runtime = createNotionWorkersRuntime(worker, deterministicOptions());
  await assert.rejects(runtime.runSync("invalid"), /missing: Status, Task ID/);
  assert.equal(runtime.runs().at(-1).status, "failed");
});
