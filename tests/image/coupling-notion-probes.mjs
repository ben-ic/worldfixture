import { createHash, randomBytes } from "node:crypto";
import { credential } from "../../runtime/src/credentials.mjs";
import { compareIdentities } from "./coupling-artifacts.mjs";
import {legacyBusinessContract, sourceProviderPeople} from "./coupling-source-contracts.mjs";

const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value : array(value).map(part => part.plain_text ?? part.text?.content ?? "").join("");
const title = page => text(Object.values(page.properties ?? {}).find(value => value.type === "title")?.title);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = encodeURIComponent;

// The public identity mapping is tested against the source, independently of the
// compiler projection. A dropped source record cannot remove its own expectation.
export function sourceNotionId(worldId, kind, sourceId) {
  const hash = createHash("sha256").update(`worldfixture:notion:${worldId}:${kind}:${sourceId}`).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export async function notionPages(read) {
  const rows = [], seen = new Set();
  let cursor;
  for (;;) {
    const response = await read(cursor);
    if (!Array.isArray(response.results)) throw new Error("Notion response omitted its results array");
    rows.push(...response.results);
    const next = response.next_cursor;
    if (response.has_more && !next) throw new Error("Notion has_more omitted its next_cursor");
    if (!next) return rows;
    if (seen.has(next)) throw new Error("Notion repeated a pagination cursor");
    seen.add(next); cursor = next;
    if (seen.size > 10000) throw new Error("Notion pagination exceeded the safety bound");
  }
}

export async function probeNotionWorld({ artifact, bindings, credentials, fetchImpl = fetch }) {
  const world = artifact.world, projection = artifact.projections?.notion ?? {};
  const overlay = artifact.projections?.["emulator-overlay"] ?? {};
  const checks = [], responses = [], coverage = [], handled = new Set();
  const people = array(world.people), users = array(projection.users), pages = array(projection.pages);
  const legacy = legacyBusinessContract(world);
  const staff = sourceProviderPeople(world, {emailOnly: true});
  const docs = array(world.communication?.documents), projects = array(world.work?.projects);
  const calendars = array(world.communication?.calendar_events).filter(event => array(event.attendees).some(email => staff.some(person => person.email === email)));
  const id = (kind, sourceId) => sourceNotionId(world.id, kind, sourceId);
  const add = (check, passed, detail = {}) => checks.push({ check, status: passed ? "passed" : "failed", ...detail });
  const compare = (check, expected, actual) => add(check, same(expected, actual), { expected, actual });
  const gap = (collection, detail) => add(`notion.reader.${collection}`, false, { failure_kind: "reader_gap", detail });
  const secrets = Object.values(credentials?.values ?? {}).filter(value => typeof value === "string" && value);
  const clean = value => {
    if (typeof value === "string") { for (const secret of secrets) value = value.replaceAll(secret, "[redacted]"); return value; }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /token|secret|password|authorization|cookie/i.test(key) ? "[redacted]" : clean(entry)]));
    return value;
  };
  const run = async (check, action) => {
    try { const result = await action(); add(check, true); return result; }
    catch (error) { add(check, false, { failure_kind: error.readerGap ? "reader_gap" : "assertion", detail: clean(String(error.message ?? error)) }); return null; }
  };
  const mapped = (check, expected, actual) => checks.push(compareIdentities({ check, expected, actual }));
  mapped("notion.source.people.projection", staff.map(person => ({ id: person.id })), users.map(user => ({ id: user.worldfixture_person_id })));
  const expectedPages = [
    ...docs.map(doc => ({ id: id("page", doc.id) })), ...projects.map(project => ({ id: id("page", project.id) })),
    ...(legacy ? calendars.map(event => ({ id: id("page", `meeting:${event.id}`) })) : []),
  ];
  mapped("notion.source.pages.projection", expectedPages, pages);
  if (legacy || Object.hasOwn(projection, "file_uploads")) mapped("notion.source.uploads.projection", docs.map(doc => ({ id: id("file-upload", doc.id) })), array(projection.file_uploads));
  if (legacy || Object.hasOwn(projection, "meeting_notes")) mapped("notion.source.meetings.projection", calendars.map(event => ({ id: id("block", `meeting-note:${event.id}`) })), array(projection.meeting_notes));
  const goals = array(world.agentic?.goals);
  if (legacy || Object.hasOwn(projection, "agents")) mapped("notion.source.goals.projection", goals.map(goal => ({ id: id("agent", goal.id) })), array(projection.agents));
  const sourceComments = array(world.communication?.channels).flatMap(channel => array(channel.messages).filter(message => {
    const refs = message.entity_refs ?? {};
    return staff.some(person => person.id === message.author_id) && (docs.some(doc => doc.id === refs.document_id) || projects.some(project => project.id === refs.project_id));
  }));
  if (legacy || Object.hasOwn(projection, "comments")) mapped("notion.source.comments.projection", sourceComments.map(message => ({ id: id("comment", message.id) })), array(projection.comments));
  if (credentials?.world?.id !== world.id || credentials?.world?.version !== String(world.version)) {
    add("provider.notion.read", false, { failure_kind: "assertion", detail: "Run credentials belong to a different or unspecified world." });
    return { checks, responses, coverage };
  }
  if (!bindings.NOTION_BASE_URL) {
    add("provider.notion.read", false, { failure_kind: "assertion", detail: "Missing NOTION_BASE_URL" });
    return { checks, responses, coverage };
  }
  function actorFor(record = {}, parent) {
    const input = parent ?? record;
    const preferred = record.worldfixture_owner_id ? users.find(user => user.worldfixture_person_id === record.worldfixture_owner_id)?.id : record.created_by;
    const candidates = [preferred, input.created_by, ...array(input.accessible_by), ...users.map(user => user.id)].filter(Boolean);
    for (const userId of candidates) {
      if (Array.isArray(input.accessible_by) && !input.accessible_by.includes(userId)) continue;
      const user = users.find(entry => entry.id === userId);
      const person = people.find(entry => entry.id === user?.worldfixture_person_id);
      if (!user || !person || person.email !== user.email) continue;
      const match = Object.entries(overlay.tokens ?? {}).find(([key, token]) => key.startsWith("notion_token_") && token.login === person.email && array(token.scopes).includes("read:content"));
      if (!match) continue;
      return { user, person, token: credential(credentials, `token:${match[0]}`) };
    }
    const error = new Error(`No per-person token maps to an allowed source identity for ${record.id ?? "Notion collection"}`);
    error.readerGap = true; throw error;
  }
  async function request(path, actor, { method = "GET", body, admin = false } = {}) {
    const token = admin ? credential(credentials, "token:notion_admin_token") : actor.token;
    const base = admin ? bindings.NOTION_ADMIN_BASE_URL ?? bindings.NOTION_BASE_URL : bindings.NOTION_BASE_URL;
    const response = await fetchImpl(`${base.replace(/\/$/, "")}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "Notion-Version": admin ? "2026-06-01" : "2026-03-11" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const raw = await response.text();
    let value; try { value = JSON.parse(raw); } catch { value = raw; }
    responses.push({ provider: "notion", path, actor_id: actor?.person.id ?? "admin", status: response.status, body: clean(value) });
    if (!response.ok || value?.object === "error") throw new Error(`${path} returned HTTP ${response.status}${value?.code ? ` (${value.code})` : ""}`);
    if (!value || typeof value !== "object") throw new Error(`${path} did not return JSON`);
    return value;
  }
  const list = (path, actor, body, admin = false, resultKey = "results") => notionPages(async cursor => {
    const response = body === undefined
      ? await request(`${path}${path.includes("?") ? "&" : "?"}page_size=100${cursor ? `&start_cursor=${enc(cursor)}` : ""}`, actor, { admin })
      : await request(path, actor, { method: "POST", body: { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, admin });
    return { ...response, results: response[resultKey] };
  });
  const actors = new Map();
  async function verifiedActor(record = {}, parent) {
    const actor = actorFor(record, parent);
    if (!actors.has(actor.user.id)) {
      const me = await request("/v1/users/me", actor);
      // Integration self is a bot-shaped object, with the actor's stable id.
      // The person email belongs to the user directory endpoint, not /users/me.
      const directory = await request(`/v1/users/${enc(actor.user.id)}`, actor);
      compare(`notion.identity.${actor.person.id}.mapping`, [actor.user.id, actor.user.id, actor.person.email], [me.id, directory.id, directory.person?.email]);
      actors.set(actor.user.id, actor);
    }
    return actor;
  }
  const defaultActor = await run("notion.identity.default", () => verifiedActor());
  if (!defaultActor) return { checks, responses, coverage };
  if (Object.hasOwn(projection, "users")) {
    handled.add("users");
    await run("notion.users.read", async () => {
      const served = await list("/v1/users", defaultActor);
      mapped("notion.source.people.api", staff.map(person => ({ id: person.email })), served.filter(user => user.type === "person").map(user => ({ id: user.person?.email })));
      for (const person of staff) compare(`notion.source.person.${person.id}`, person.name, served.find(user => user.person?.email === person.email)?.name);
    });
  }
  async function blocks(pageId, actor, visited = new Set()) {
    if (visited.has(pageId)) throw new Error("Notion block children form a cycle");
    visited.add(pageId);
    const children = await list(`/v1/blocks/${enc(pageId)}/children`, actor);
    for (const block of children) if (block.has_children) block.children = await blocks(block.id, actor, visited);
    return children;
  }
  const blockText = children => children.flatMap(block => [text(block[block.type]?.rich_text), ...(block.children ? [blockText(block.children)] : [])]).filter(Boolean).join("\n");
  const readPages = new Map();
  if (Object.hasOwn(projection, "pages")) {
    handled.add("pages");
    for (const page of pages) await run(`notion.page.${page.id}.read`, async () => {
      const actor = await verifiedActor(page);
      const served = await request(`/v1/pages/${enc(page.id)}`, actor);
      const children = await blocks(page.id, actor);
      compare(`notion.page.${page.id}.identity`, page.id, served.id);
      compare(`notion.page.${page.id}.title`, page.title, title(served));
      if (page.created_by) compare(`notion.page.${page.id}.owner`, page.created_by, served.created_by?.id);
      const doc = docs.find(entry => id("page", entry.id) === page.id);
      const project = projects.find(entry => id("page", entry.id) === page.id);
      const event = calendars.find(entry => id("page", `meeting:${entry.id}`) === page.id);
      if (doc) {
        compare(`notion.source.document.${doc.id}.title`, (legacy ? doc.name.replace(/\.md$/, "") : doc.name ?? doc.title ?? doc.id), title(served));
        compare(`notion.source.document.${doc.id}.content`, (doc.content ?? doc.body_md ?? doc.body ?? ""), blockText(children));
        if (doc.owner_id) compare(`notion.source.document.${doc.id}.owner`, id("user", doc.owner_id), served.created_by?.id);
      } else if (project) {
        compare(`notion.source.project.${project.id}.title`, (project.name ?? project.title ?? project.id), title(served));
        if (legacy) {
          compare(`notion.source.project.${project.id}.status`, project.status, served.properties?.Status?.status?.id);
          compare(`notion.source.project.${project.id}.target`, project.target_on, served.properties?.Target?.date?.start);
          compare(`notion.source.project.${project.id}.owner`, [id("user", project.owner_id)], array(served.properties?.Owner?.people).map(user => user.id));
          add(`notion.source.project.${project.id}.summary`, blockText(children).includes(project.summary), {expected: project.summary, actual: blockText(children)});
        } else {
          compare(`notion.source.project.${project.id}.summary`, project.summary ?? project.description ?? "", blockText(children));
          if (project.owner_id) compare(`notion.source.project.${project.id}.owner`, id("user", project.owner_id), served.created_by?.id);
          add(`notion.source.project.${project.id}.scope`, true, {detail: 'Section contract serves project title, summary and page creator only. Canonical workflow fields remain in the domain API; no Notion Status/Target property is claimed.'});
        }
      } else if (event) {
        compare(`notion.source.calendar.${event.id}.title`, event.summary, title(served));
        compare(`notion.source.calendar.${event.id}.content`, event.description ?? "", blockText(children));
      } else gap(`pages.${page.id}.source`, "Page API was read, but no source identity mapping is known for this declared page.");
      readPages.set(page.id, { actor, served });
    });
    // Search is a complete listing per exercised identity. Restriction is part
    // of the expectation; one primary user's results cannot define all pages.
    for (const actor of actors.values()) await run(`notion.search.${actor.person.id}`, async () => {
      const served = await list("/v1/search", actor, {});
      const expected = pages.filter(page => !Array.isArray(page.accessible_by) || page.accessible_by.includes(actor.user.id));
      mapped(`notion.search.${actor.person.id}.pages`, expected, served.filter(row => row.object === "page"));
    });
  }
  for (const [key, endpoint] of [["databases", "databases"], ["data_sources", "data_sources"], ["views", "views"], ["comments", "comments"], ["file_uploads", "file_uploads"], ["meeting_notes", "blocks"], ["agents", "agents"], ["agent_sessions", "sessions"]]) {
    if (!Object.hasOwn(projection, key)) continue;
    handled.add(key);
    for (const record of array(projection[key])) await run(`notion.${key}.${record.id}.read`, async () => {
      const parent = pages.find(page => page.id === record.parent?.page_id);
      const actor = await verifiedActor(record, parent);
      const served = await request(`/v1/${endpoint}/${enc(record.id)}${key === "agents" ? "?verbose=true" : ""}`, actor);
      compare(`notion.${key}.${record.id}.identity`, record.id, served.id);
      if (key === "databases") {
        compare(`notion.databases.${record.id}.title`, text(record.title), text(served.title));
        compare(`notion.databases.${record.id}.description`, text(record.description), text(served.description));
        mapped(`notion.databases.${record.id}.sources`, array(projection.data_sources).filter(source => source.database_id === record.id), array(served.data_sources));
      } else if (key === "data_sources") {
        compare(`notion.data_sources.${record.id}.parent`, record.database_id, served.parent?.database_id);
        compare(`notion.data_sources.${record.id}.title`, record.title ?? record.name, text(served.title));
        const schema = properties => Object.entries(properties ?? {}).map(([name, property]) => [name, property.type]).sort(([a], [b]) => a.localeCompare(b));
        compare(`notion.data_sources.${record.id}.schema`, schema(record.properties), schema(served.properties));
        const queried = await list(`/v1/data_sources/${enc(record.id)}/query`, actor, {});
        mapped(`notion.data_sources.${record.id}.pages`, pages.filter(page => page.parent?.data_source_id === record.id && (!page.accessible_by || page.accessible_by.includes(actor.user.id))), queried);
        if (Array.isArray(record.templates)) mapped(`notion.data_sources.${record.id}.templates`, record.templates, await list(`/v1/data_sources/${enc(record.id)}/templates`, actor, undefined, false, "templates"));
      } else if (key === "views") {
        compare(`notion.views.${record.id}.fields`, [record.name, record.type, record.database_id, record.data_source_id, record.filter ?? null, record.sorts ?? []],
          [served.name, served.type, served.parent?.database_id, served.data_source_id, served.filter ?? null, served.sorts ?? []]);
      } else if (key === "comments") {
        compare(`notion.comments.${record.id}.text`, text(record.rich_text), text(served.rich_text));
        compare(`notion.comments.${record.id}.author`, record.created_by, served.created_by?.id);
        compare(`notion.comments.${record.id}.parent`, record.parent?.page_id ?? record.parent?.block_id, served.parent?.page_id ?? served.parent?.block_id);
        const source = sourceComments.find(message => id("comment", message.id) === record.id);
        if (source) compare(`notion.source.comment.${source.id}.text`, source.text, text(served.rich_text));
      } else if (key === "file_uploads") {
        const doc = docs.find(doc => id("file-upload", doc.id) === record.id);
        compare(`notion.file_uploads.${record.id}.fields`, [doc?.name ?? record.filename, doc?.mime_type ?? record.content_type, doc ? Buffer.byteLength(doc.content) : record.content_length, record.status],
          [served.filename, served.content_type, served.content_length, served.status]);
      } else if (key === "meeting_notes") {
        const event = calendars.find(event => id("block", `meeting-note:${event.id}`) === record.id);
        const value = served[served.type] ?? {};
        if (event) {
          compare(`notion.source.meeting.${event.id}.title`, event.summary, text(value.title));
          compare(`notion.source.meeting.${event.id}.time`, [event.start, event.end], [value.calendar_event?.start_time, value.calendar_event?.end_time]);
          const attendees = staff.filter(person => array(event.attendees).includes(person.email)).map(person => id("user", person.id)).sort();
          compare(`notion.source.meeting.${event.id}.attendees`, attendees, [...array(value.calendar_event?.attendees)].sort());
        }
      } else if (key === "agents") {
        const goal = goals.find(goal => id("agent", goal.id) === record.id);
        compare(`notion.agents.${record.id}.name`, goal?.title ?? record.name, served.name);
        compare(`notion.agents.${record.id}.description`, goal?.instructions ?? record.description, served.description);
        const sections = goal ? [goal.instructions,
          ...(array(world.agentic?.constraints).length ? [`Constraints:\n${world.agentic.constraints.map(value => `- ${value}`).join("\n")}`] : []),
          ...(array(goal.success_evidence).length ? [`Success evidence:\n${goal.success_evidence.map(value => `- ${value}`).join("\n")}`] : [])] : null;
        compare(`notion.agents.${record.id}.instructions`, sections ? sections.join("\n\n") : record.instructions, served.instructions);
      } else if (key === "agent_sessions") {
        compare(`notion.agent_sessions.${record.id}.fields`, [record.title, record.status, record.agent_id], [served.title, served.status, served.agent_id]);
        const events = await list(`/v1/sessions/${enc(record.id)}/events/query`, actor, {});
        mapped(`notion.agent_sessions.${record.id}.events`, array(projection.agent_session_events).filter(event => event.session_id === record.id), events);
        if (Object.hasOwn(projection, "agent_session_events")) handled.add("agent_session_events");
      }
    });
  }
  // Complete list reads also prove declared empty collections. GET details alone
  // cannot detect extra records or an empty collection that is never served.
  for (const [key, path, body] of [["file_uploads", "/v1/file_uploads", undefined], ["agents", "/v1/agents/query", { verbose: true, include_deleted: true }], ["agent_sessions", "/v1/sessions/query", {}]]) {
    if (!Object.hasOwn(projection, key)) continue;
    for (const actor of actors.values()) await run(`notion.${key}.list.${actor.person.id}`, async () => {
      const served = await list(path, actor, body);
      const expected = array(projection[key]).filter(record => key === "file_uploads" ? record.created_by === actor.user.id
        : !Array.isArray(record.accessible_by) || record.accessible_by.includes(actor.user.id));
      mapped(`notion.${key}.list.${actor.person.id}.identities`, expected, served);
    });
  }
  if (Object.hasOwn(projection, "comments")) for (const [pageId, { actor }] of readPages) await run(`notion.comments.list.${pageId}`, async () => {
    mapped(`notion.comments.list.${pageId}.identities`, array(projection.comments).filter(comment => comment.parent?.page_id === pageId), await list(`/v1/comments?block_id=${enc(pageId)}`, actor));
  });
  if (Object.hasOwn(projection, "views")) for (const database of array(projection.databases)) await run(`notion.views.list.${database.id}`, async () => {
    mapped(`notion.views.list.${database.id}.identities`, array(projection.views).filter(view => view.database_id === database.id), await list(`/v1/views?database_id=${enc(database.id)}`, await verifiedActor(database)));
  });
  if (projection.admin) {
    handled.add("admin");
    const space = enc(projection.workspace?.id ?? "");
    const routes = { groups: `/admin/v1/spaces/${space}/groups`, personal_access_tokens: `/admin/v1/spaces/${space}/personal_access_tokens`,
      legal_holds: "/admin/v1/legal_holds", mcp_client_connections: `/admin/v1/mcp_client_connections?workspace_id=${space}` };
    for (const [key, records] of Object.entries(projection.admin)) {
      if (!Array.isArray(records)) continue;
      if (!routes[key]) { gap(`admin.${key}`, "No reader mapping exists for this declared admin collection."); continue; }
      await run(`notion.admin.${key}.read`, async () => {
        const served = await list(routes[key], defaultActor, undefined, true, key === "legal_holds" ? "legal_holds" : "results");
        if (key === "mcp_client_connections") mapped(`notion.admin.${key}.identities`, records.map(record => ({ id: `${record.client_key}:${record.user_id}` })), served.map(record => ({ id: `${record.client?.key}:${record.user?.id}` })));
        else mapped(`notion.admin.${key}.identities`, records, served);
        if (key === "groups") for (const group of records) mapped(`notion.admin.groups.${group.id}.members`, array(group.members).map(member => ({ id: member.user_id })),
          (await list(`${routes[key]}/${enc(group.id)}/members`, defaultActor, undefined, true)).map(member => ({ id: member.member?.user_id })));
      });
    }
  }
  if (Object.hasOwn(projection, "teamspaces")) {
    handled.add("teamspaces");
    const teams = [...new Set(staff.map(person => person.team).filter(value => typeof value === "string"))];
    mapped("notion.source.teamspaces.projection", teams.map(team => ({ id: id("teamspace", team) })), array(projection.teamspaces));
    await run("notion.teamspaces.mcp.read", async () => {
      // Hosted MCP uses OAuth grants, not integration REST credentials. Create
      // test authentication records through the normal local API. Never seed a
      // grant directly or send a REST token to a tool as a substitute.
      const base = bindings.NOTION_BASE_URL.replace(/\/$/, "");
      const authRequest = async (path, options = {}) => {
        const response = await fetchImpl(`${base}${path}`, { ...options, redirect: "manual", signal: AbortSignal.timeout(30000) });
        const raw = await response.text();
        let value; try { value = JSON.parse(raw); } catch { value = raw || {}; }
        for (const key of ["access_token", "refresh_token", "client_secret"]) if (typeof value?.[key] === "string") secrets.push(value[key]);
        responses.push({ provider: "notion", path, actor_id: defaultActor.person.id, status: response.status, body: clean(value) });
        if (response.status < 200 || response.status >= 400 || value?.error) throw new Error(`Notion authentication/MCP ${path} returned HTTP ${response.status}${value?.error ? " with protocol error" : ""}`);
        return { value, response };
      };
      const form = body => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
      const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const metadata = (await authRequest("/.well-known/oauth-protected-resource/mcp")).value;
      if (typeof metadata.resource !== "string") throw new Error("MCP resource metadata omitted resource");
      const redirectUri = "http://127.0.0.1/coupling-notion-callback";
      const client = (await authRequest("/register", json({ client_name: "WorldFixture coupling read test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }))).value;
      const verifier = randomBytes(32).toString("hex"), state = randomBytes(16).toString("hex");
      const grant = { client_id: client.client_id, redirect_uri: redirectUri, state, scope: "default", resource: metadata.resource,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
      const consent = await authRequest("/authorize", form({ ...grant, user_id: defaultActor.user.id, decision: "approve" }));
      const location = consent.response.headers.get("location");
      if (!location) throw new Error("MCP authorization omitted its redirect");
      const callback = new URL(location);
      if (callback.searchParams.get("state") !== state || !callback.searchParams.get("code")) throw new Error("MCP authorization returned invalid state or code");
      const token = (await authRequest("/token", form({ grant_type: "authorization_code", client_id: client.client_id, redirect_uri: redirectUri,
        code: callback.searchParams.get("code"), code_verifier: verifier, resource: metadata.resource }))).value;
      if (!token.access_token) throw new Error("MCP token response omitted access_token");
      let sessionId;
      const headers = { authorization: `Bearer ${token.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
      try {
        if (token.user_id !== defaultActor.user.id) throw new Error("MCP grant belongs to a different source identity");
        const initialized = await authRequest("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Claude Code", version: "coupling-test" } } }) });
        sessionId = initialized.response.headers.get("mcp-session-id");
        if (!sessionId || !initialized.value.result?.protocolVersion) throw new Error("MCP initialization omitted session or protocol version");
        headers["MCP-Session-Id"] = sessionId;
        headers["MCP-Protocol-Version"] = initialized.value.result.protocolVersion;
        let callId = 1;
        const getTeams = async args => {
          const response = (await authRequest("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++callId, method: "tools/call", params: { name: "notion-get-teams", arguments: args } }) })).value;
          if (response.result?.isError) throw new Error("notion-get-teams returned a tool error");
          const contents = array(response.result?.content).filter(item => item.type === "text").map(item => item.text).join("\n");
          const value = JSON.parse(contents);
          if (!Array.isArray(value.teams)) throw new Error("notion-get-teams omitted its teams array");
          return value.teams;
        };
        const first = await getTeams({});
        // The hosted tool advertises a bounded list. Query each declared name,
        // so a listing limit cannot hide one of the world's expected teams.
        const read = new Map(first.map(team => [team.id, team]));
        for (const team of array(projection.teamspaces)) {
          for (const served of await getTeams({ query: team.name })) read.set(served.id, served);
          const served = read.get(team.id);
          compare(`notion.teamspaces.${team.id}.name`, team.name, served?.name);
          compare(`notion.teamspaces.${team.id}.membership`, array(team.member_ids).includes(defaultActor.user.id) ? "member" : "not_member", served?.membership);
        }
        mapped("notion.source.teamspaces.api", teams.map(team => ({ id: id("teamspace", team) })), [...read.values()]);
        add("notion.teamspaces.scope", true, { detail: "Reads every source team by name and the default tool listing. Membership is checked for the selected source person only; no claim covers unlisted foreign teams beyond the hosted list limit. OAuth client/session records are test authentication setup, not authored source content." });
      } finally {
        const cleanup = [];
        if (sessionId) try { await authRequest("/mcp", { method: "DELETE", headers }); } catch (error) { cleanup.push(error.message); }
        try { await authRequest("/token", form({ token: token.access_token })); } catch (error) { cleanup.push(error.message); }
        if (cleanup.length) throw new Error(`MCP authentication cleanup failed: ${cleanup.join("; ")}`);
      }
    });
  }
  // Workspace and storage are named configuration consumers, not record lists.
  for (const key of ["workspace", "object_store"]) if (Object.hasOwn(projection, key)) handled.add(key);
  for (const [key, value] of Object.entries(projection)) if (Array.isArray(value) && !handled.has(key)) gap(key, `No complete API reader is implemented for ${value.length} declared records (including empty collections).`);
  const failed = checks.some(check => check.status === "failed");
  add("provider.notion.read", !failed, { detail: "Per-person REST identity, source content, and declared projection readers only. No claim covers unexercised API operations." });
  for (const [collection, prefix] of [["communication.documents", "notion.source.document."], ["work.projects", "notion.source.project."], ["communication.calendar_events", "notion.source.calendar."]]) {
    const sourceRows = collection === "communication.documents" ? docs : collection === "work.projects" ? projects : calendars;
    if (collection === "communication.calendar_events" && !legacy) continue;
    if (collection === "communication.documents" && !Object.hasOwn(world.communication ?? {}, "documents")) continue;
    if (collection === "work.projects" && !Object.hasOwn(world.work ?? {}, "projects")) continue;
    const relevant = checks.filter(check => check.check.startsWith(prefix));
    const pass = !failed && (sourceRows.length === 0 || relevant.length > 0) && relevant.every(check => check.status === "passed")
      && sourceRows.every(record => readPages.has(id("page", collection === "communication.calendar_events" ? `meeting:${record.id}` : record.id)));
    coverage.push({ collection, provider: "notion", path: "GET /v1/pages/:id; GET /v1/blocks/:id/children", status: pass ? "passed" : "failed", detail: "Source identity and full block content through an allowed per-person API identity. Section projects expose title/summary/creator; other canonical project fields require domain API evidence." });
  }
  return clean({ checks, responses, coverage });
}
