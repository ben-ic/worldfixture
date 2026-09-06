import assert from "node:assert/strict";
import test from "node:test";
import { notionPages, probeNotionWorld, sourceNotionId } from "./coupling-notion-probes.mjs";

function fixture() {
  const world = { id: "odd-notes", version: "v1", profile: "business.operations/v1", software: {}, support: {}, agentic: {}, stories: [], work: {projects: [], tasks: []}, finance: {history_months: 0, currency: "USD", customers: [], suppliers: [], anchor_invoices: [], billing_owner_id: "primary"}, organizations: [{ id: "org", primary: true }],
    people: [{ id: "primary", primary: true, name: "First", email: "first@odd.test", organization_id: "org" }, { id: "owner", name: "Second", email: "second@odd.test", organization_id: "org" }],
    communication: { channels: [], mail: [], documents: [{ id: "restricted-doc", name: "Restricted.md", owner_id: "owner", content: "First line\nSecond line", mime_type: "text/markdown" }] } };
  const id = (kind, value) => sourceNotionId(world.id, kind, value);
  const users = world.people.map(person => ({ id: id("user", person.id), worldfixture_person_id: person.id, email: person.email, name: person.name }));
  const page = { id: id("page", "restricted-doc"), title: "Restricted", created_by: users[1].id, accessible_by: [users[1].id], worldfixture_document_id: "restricted-doc", worldfixture_owner_id: "owner" };
  const upload = { id: id("file-upload", "restricted-doc"), created_by: users[1].id, status: "uploaded", filename: "Restricted.md", content_type: "text/markdown", content_length: Buffer.byteLength(world.communication.documents[0].content) };
  const artifact = { world, projections: { notion: { users, pages: [page], file_uploads: [upload], agents: [], comments: [], meeting_notes: [] },
    "emulator-overlay": { tokens: Object.fromEntries(users.map(user => [`notion_token_${user.worldfixture_person_id}`, { login: user.email, scopes: ["read:content"] }])) } } };
  const credentials = { world: { id: world.id, version: world.version }, values: { "token:notion_token_primary": "first-private-value", "token:notion_token_owner": "second-private-value" } };
  const bindings = { NOTION_BASE_URL: "http://notion.test", NOTION_TOKEN: "do-not-use-workspace-token" };
  const calls = [];
  const wire = structuredClone({ users, page, upload });
  const respond = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const listed = (results, more = false, cursor = null) => ({ results, has_more: more, next_cursor: cursor });
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname;
    const token = options.headers.authorization.replace("Bearer ", "");
    const actor = token === "first-private-value" ? wire.users[0] : token === "second-private-value" ? wire.users[1] : null;
    calls.push({ path, token, method: options.method, query: parsed.search, body: options.body ? JSON.parse(options.body) : null });
    if (!actor) return respond({ object: "error", code: "unauthorized" }, 401);
    if (path === "/v1/users/me") return respond({ id: actor.id, type: "bot", name: actor.name, bot: { owner: { type: "workspace", workspace: true } } });
    if (path === `/v1/users/${actor.id}`) return respond({ id: actor.id, type: "person", name: actor.name, person: { email: actor.email } });
    if (path === "/v1/users") return respond(listed(wire.users.map(user => ({ id: user.id, type: "person", name: user.name, person: { email: user.email } }))));
    if (path === "/v1/search") return respond(listed(actor.id === wire.page.created_by ? [{ object: "page", id: wire.page.id }] : []));
    if (path === `/v1/pages/${wire.page.id}`) {
      if (actor.id !== wire.page.created_by) return respond({ object: "error", code: "object_not_found" }, 404);
      return respond({ id: wire.page.id, created_by: { id: wire.page.created_by }, properties: { title: { type: "title", title: [{ plain_text: wire.page.title }] } } });
    }
    if (path === `/v1/blocks/${wire.page.id}/children`) {
      if (actor.id !== wire.page.created_by) return respond({ object: "error" }, 404);
      const second = parsed.searchParams.get("start_cursor") === "second";
      return respond(listed([{ id: second ? "block-2" : "block-1", type: "paragraph", has_children: false,
        paragraph: { rich_text: [{ plain_text: second ? "Second line" : "First line" }] } }], !second, second ? null : "second"));
    }
    if (path === `/v1/file_uploads/${wire.upload.id}`) return respond(wire.upload);
    if (path === "/v1/file_uploads") return respond(listed(actor.id === wire.upload.created_by ? [wire.upload] : []));
    if (path === "/v1/agents/query" || path === "/v1/comments") return respond(listed([]));
    return respond({ object: "error", code: "object_not_found" }, 404);
  };
  return { artifact, credentials, bindings, fetchImpl, calls, wire, respond, listed };
}

test("restricted source documents use owner credentials and complete block pagination", async () => {
  const input = fixture();
  const result = await probeNotionWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  const reads = input.calls.filter(call => call.path.includes(input.wire.page.id));
  assert.ok(reads.length >= 3);
  assert.ok(reads.every(call => call.token === "second-private-value"));
  assert.ok(reads.some(call => call.query.includes("start_cursor=second")));
  assert.ok(input.calls.every(call => call.token !== input.bindings.NOTION_TOKEN));
  assert.equal(result.coverage.find(row => row.collection === "communication.documents").status, "passed");
  assert.equal(JSON.stringify(result).includes("second-private-value"), false);
});

test("source document cannot disappear from its own projection expectation", async () => {
  const input = fixture(); input.artifact.projections.notion.pages = [];
  const result = await probeNotionWorld(input);
  assert.equal(result.checks.find(check => check.check === "notion.source.pages.projection").status, "failed");
  assert.equal(result.coverage.find(row => row.collection === "communication.documents").status, "failed");
});

test("changed source content fails even when projection identity and API identity match", async () => {
  const input = fixture(); input.artifact.world.communication.documents[0].content = "Changed source text.";
  const result = await probeNotionWorld(input);
  assert.equal(result.checks.find(check => check.check === "notion.source.document.restricted-doc.content").status, "failed");
});

test("missing permitted identity is a reader gap with no shared credential fallback", async () => {
  const input = fixture(); delete input.artifact.projections["emulator-overlay"].tokens.notion_token_owner;
  const result = await probeNotionWorld(input);
  const failure = result.checks.find(check => check.check === `notion.page.${input.wire.page.id}.read`);
  assert.equal(failure.failure_kind, "reader_gap");
  assert.equal(failure.status, "failed");
  assert.ok(input.calls.every(call => call.token !== input.bindings.NOTION_TOKEN));
});

test("a measured HTTP failure is an assertion, not a missing reader", async () => {
  const input = fixture(), read = input.fetchImpl;
  input.fetchImpl = (url, options) => new URL(url).pathname === `/v1/pages/${input.wire.page.id}`
    ? Promise.resolve(input.respond({ object: "error", code: "object_not_found" }, 404)) : read(url, options);
  const result = await probeNotionWorld(input);
  const failure = result.checks.find(check => check.check === `notion.page.${input.wire.page.id}.read`);
  assert.equal(failure.failure_kind, "assertion");
  assert.match(failure.detail, /HTTP 404/);
  assert.ok(result.responses.some(response => response.status === 404));
});

test("an unknown empty declared collection fails reader coverage", async () => {
  const input = fixture(); input.artifact.projections.notion.future_records = [];
  const result = await probeNotionWorld(input);
  const failure = result.checks.find(check => check.check === "notion.reader.future_records");
  assert.equal(failure.failure_kind, "reader_gap");
  assert.equal(failure.status, "failed");
});

test("declared sessions and admin groups use complete read routes", async () => {
  const input = fixture(), read = input.fetchImpl;
  const session = { id: "session-1", title: "Authored session", status: "completed", agent_id: "agent-1", created_by: input.wire.users[1].id, accessible_by: [input.wire.users[1].id] };
  input.artifact.projections.notion.agent_sessions = [session];
  input.artifact.projections.notion.agent_session_events = [{ id: "event-1", session_id: session.id }];
  input.artifact.projections.notion.workspace = { id: "space-1" };
  input.artifact.projections.notion.admin = { groups: [{ id: "group-1", members: [{ user_id: input.wire.users[1].id }] }] };
  input.credentials.values["token:notion_admin_token"] = "admin-private-value";
  input.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/admin/")) {
      assert.equal(options.headers.authorization, "Bearer admin-private-value");
      return input.respond(input.listed(path.endsWith("/members") ? [{ member: { user_id: input.wire.users[1].id } }] : [{ id: "group-1" }]));
    }
    if (path === "/v1/sessions/session-1") return input.respond(session);
    if (path === "/v1/sessions/session-1/events/query") return input.respond(input.listed([{ id: "event-1" }]));
    if (path === "/v1/sessions/query") return input.respond(input.listed(options.headers.authorization === "Bearer second-private-value" ? [session] : []));
    return read(url, options);
  };
  const result = await probeNotionWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.equal(JSON.stringify(result).includes("admin-private-value"), false);
});

test("pagination refuses a repeated cursor and a missing continuation", async () => {
  await assert.rejects(notionPages(async () => ({ results: [], has_more: true, next_cursor: "same" })), /repeated/);
  await assert.rejects(notionPages(async () => ({ results: [], has_more: true })), /omitted/);
});

test("credentials from another world fail before any API call", async () => {
  const input = fixture(); input.credentials.world.id = "foreign";
  const result = await probeNotionWorld(input);
  assert.equal(input.calls.length, 0);
  assert.equal(result.checks.find(check => check.check === "provider.notion.read").status, "failed");
});

test("bot self identity mismatch stays a failure while independent document reads continue", async () => {
  const input = fixture(), read = input.fetchImpl;
  input.fetchImpl = (url, options) => new URL(url).pathname === "/v1/users/me"
    ? Promise.resolve(input.respond({ id: "wrong-user", type: "bot" })) : read(url, options);
  const result = await probeNotionWorld(input);
  assert.equal(result.checks.find(check => check.check === "notion.identity.primary.mapping").status, "failed");
  assert.equal(result.checks.find(check => check.check === "notion.source.document.restricted-doc.content").status, "passed");
});

test("templates use their distinct paginated response field", async () => {
  const input = fixture(), read = input.fetchImpl;
  input.artifact.projections.notion.data_sources = [{ id: "source-1", database_id: "database-1", name: "Projects", properties: { Name: { type: "title" } }, templates: [{ id: "template-1" }] }];
  input.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/v1/data_sources/source-1") return input.respond({ id: "source-1", parent: { database_id: "database-1" }, title: [{ plain_text: "Projects" }], properties: { Name: { type: "title" } } });
    if (path.endsWith("/templates")) return input.respond({ templates: [{ id: "template-1" }], has_more: false, next_cursor: null });
    if (path === "/v1/data_sources/source-1/query") return input.respond(input.listed([]));
    return read(url, options);
  };
  const result = await probeNotionWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
});

test("teamspaces use source identity, normal PKCE authentication and only read MCP tools", async () => {
  const input = fixture(), read = input.fetchImpl;
  input.artifact.world.people[0].team = "Red"; input.artifact.world.people[1].team = "Blue";
  const teams = ["Red", "Blue"].map((name, index) => ({ id: sourceNotionId(input.artifact.world.id, "teamspace", name), name, member_ids: [input.wire.users[index].id] }));
  input.artifact.projections.notion.teamspaces = teams;
  const history = [];
  let challenge, consentState;
  input.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (!["/.well-known/oauth-protected-resource/mcp", "/register", "/authorize", "/token", "/mcp"].includes(path)) return read(url, options);
    const body = options.body instanceof URLSearchParams ? Object.fromEntries(options.body) : options.body ? JSON.parse(options.body) : {};
    history.push({ path, method: options.method ?? "GET", body });
    if (path.startsWith("/.well-known")) return input.respond({ resource: "http://notion.internal/mcp" });
    if (path === "/register") return input.respond({ client_id: "test-client" });
    if (path === "/authorize") {
      assert.equal(body.user_id, input.wire.users[0].id); assert.equal(body.resource, "http://notion.internal/mcp");
      challenge = body.code_challenge; consentState = body.state;
      return new Response(null, { status: 302, headers: { location: `${body.redirect_uri}?code=auth-code&state=${consentState}` } });
    }
    if (path === "/token") {
      if (body.token) { assert.equal(body.token, "mcp-private-value"); return new Response(null, { status: 200 }); }
      assert.equal(body.code, "auth-code"); assert.ok(challenge); assert.equal(body.code_verifier.length, 64);
      return input.respond({ access_token: "mcp-private-value", refresh_token: "refresh-private-value", user_id: input.wire.users[0].id });
    }
    assert.equal(options.headers.authorization, "Bearer mcp-private-value");
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25" } }), { headers: { "mcp-session-id": "test-session" } });
    assert.equal(body.method, "tools/call"); assert.equal(body.params.name, "notion-get-teams");
    const selected = teams.filter(team => !body.params.arguments.query || team.name === body.params.arguments.query);
    return input.respond({ result: { content: [{ type: "text", text: JSON.stringify({ teams: selected.map(team => ({ id: team.id, name: team.name, membership: team.name === "Red" ? "member" : "not_member" })) }) }] } });
  };
  const result = await probeNotionWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.equal(history.filter(call => call.path === "/mcp" && call.body.method === "tools/call").length, 3);
  assert.ok(history.some(call => call.path === "/mcp" && call.method === "DELETE"));
  assert.ok(history.some(call => call.path === "/token" && call.body.token === "mcp-private-value"));
  assert.equal(JSON.stringify(result).includes("mcp-private-value"), false);
  assert.equal(JSON.stringify(result).includes("refresh-private-value"), false);

  const original = input.fetchImpl;
  const revocations = () => history.filter(call => call.path === "/token" && call.body.token).length;
  const beforeCloseFailure = revocations();
  input.fetchImpl = (url, options) => new URL(url).pathname === "/mcp" && options.method === "DELETE"
    ? Promise.reject(new Error("Session close failed")) : original(url, options);
  const closeFailure = await probeNotionWorld(input);
  assert.equal(revocations(), beforeCloseFailure + 1, "session close failure must not block grant revocation");
  assert.equal(closeFailure.checks.find(check => check.check === "notion.teamspaces.mcp.read").status, "failed");

  const beforeIdentityFailure = revocations();
  input.fetchImpl = (url, options) => new URL(url).pathname === "/token" && options.body?.get?.("grant_type")
    ? Promise.resolve(input.respond({ access_token: "mcp-private-value", user_id: "wrong-person" })) : original(url, options);
  const identityFailure = await probeNotionWorld(input);
  assert.equal(revocations(), beforeIdentityFailure + 1, "wrong-person grant must be revoked");
  assert.equal(identityFailure.checks.find(check => check.check === "notion.teamspaces.mcp.read").status, "failed");
});

function sectionFixture() {
  const input = fixture(); delete input.artifact.world.profile;
  for (const person of input.artifact.world.people) {delete person.primary; person.organization_id = null;}
  input.artifact.world.organizations = [];
  const projection = input.artifact.projections.notion;
  for (const key of ['file_uploads', 'meeting_notes', 'agents', 'comments']) delete projection[key];
  input.wire.page.title = 'Restricted.md'; projection.pages[0].title = 'Restricted.md';
  return input;
}

test('profile-less documents keep authored titles and do not invent uploads, meetings, or admin collections', async () => {
  const input = sectionFixture();
  input.artifact.world.communication.calendar_events = [{id: 'meeting-declared', attendees: [input.artifact.world.people[0].email], summary: 'Calendar belongs to Google'}];
  input.artifact.world.agentic.goals = [{id: 'goal-declared', title: 'Domain context'}];
  const result = await probeNotionWorld(input);
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(result.coverage.find(row => row.collection === 'communication.documents').status, 'passed');
  assert.ok(input.calls.every(row => !/file_upload|meeting|admin|agents/.test(row.path)));
  assert.equal(result.coverage.some(row => row.collection === 'communication.calendar_events'), false);
  assert.equal(result.checks.find(row => row.check === 'notion.source.people.api').status, 'passed');
});

test('section project title, summary and creator are read without invented Notion workflow properties', async () => {
  const input = sectionFixture(), world = input.artifact.world;
  world.communication.documents = [];
  world.work.projects = [{id: 'project-one', title: 'Translated project', summary: 'First line\nSecond line', owner_id: 'owner', status: 'En cours', target_on: '2031-12-01'}];
  const page = {...input.wire.page, id: sourceNotionId(world.id, 'page', 'project-one'), title: 'Translated project', worldfixture_project_id: 'project-one'};
  delete page.worldfixture_document_id; input.wire.page = page; input.artifact.projections.notion.pages = [page];
  const result = await probeNotionWorld(input);
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(result.checks.some(row => row.check === 'notion.source.project.project-one.status'), false);
  assert.equal(result.coverage.find(row => row.collection === 'work.projects').status, 'passed');
  world.work.projects[0].summary = 'Changed source summary';
  const changed = await probeNotionWorld(input);
  assert.equal(changed.checks.find(row => row.check === 'notion.source.project.project-one.summary').status, 'failed');
});

test('section records dropped from projection still fail and declared optional collections still receive reads', async () => {
  const input = sectionFixture(); input.artifact.projections.notion.pages = [];
  const result = await probeNotionWorld(input);
  assert.equal(result.checks.find(row => row.check === 'notion.source.pages.projection').status, 'failed');
  const declared = sectionFixture(); declared.artifact.projections.notion.file_uploads = [declared.wire.upload];
  const base = declared.fetchImpl;
  declared.fetchImpl = (url, options) => new URL(url).pathname.includes('/file_uploads') ? Promise.resolve(declared.respond({object: 'error', code: 'not_found'}, 404)) : base(url, options);
  const failed = await probeNotionWorld(declared);
  assert.ok(failed.responses.some(row => row.path.includes('/file_uploads') && row.status === 404));
  assert.ok(failed.checks.some(row => row.status === 'failed' && row.check.includes('file_uploads')));
});
