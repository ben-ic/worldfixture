import { createNotionDomain, normalizeId } from "./domain.mjs";
import { NOTION_VERSION, notionError } from "./rest.mjs";

const DEFAULT_TIME = "2026-09-03T09:00:00.000Z";
const PERSONAL_AGENT_ID = "33333333-3333-3333-3333-333333333333";
const STATUSES = new Set(["queued", "in_progress", "requires_action", "completed", "failed", "canceled", "terminated"]);

function timestamp(store) { return store.getData("notion_clock") ?? DEFAULT_TIME; }
function collection(store, name, indexes) { return store.collection(name, indexes); }
function nextId(store, kind, prefix) {
  const key = `notion_uuid_counter_${kind}`;
  const next = (store.getData(key) ?? 0) + 1;
  store.setData(key, next);
  return `${prefix}-0000-4000-8000-${String(next).padStart(12, "0")}`;
}

async function body(c) {
  try { return await c.req.json(); } catch { return null; }
}

function pageSize(value) {
  const result = value === undefined ? 100 : Number(value);
  return Number.isInteger(result) && result >= 1 && result <= 100 ? result : null;
}

function paginate(records, cursor, size) {
  const start = cursor ? records.findIndex((item) => item.notion_id === normalizeId(cursor)) + 1 : 0;
  if (cursor && start === 0) return { invalid_cursor: true };
  const selected = records.slice(start, start + size);
  return { selected, next_cursor: start + size < records.length ? selected.at(-1)?.notion_id ?? null : null };
}

function canRead(record, actor) {
  return Boolean(record && actor && (!record.accessible_by?.length || record.accessible_by.includes(actor.notion_id)));
}

function canEdit(record, actor) {
  return canRead(record, actor) && (!record.editable_by?.length || record.editable_by.includes(actor.notion_id));
}

function dateMatches(value, condition = {}, { equals = false } = {}) {
  const actual = Date.parse(value);
  if (!Number.isFinite(actual)) return false;
  const boundary = (name) => Date.parse(condition[name]);
  if (equals && condition.equals !== undefined && actual !== boundary("equals")) return false;
  if (condition.before !== undefined && actual >= boundary("before")) return false;
  if (condition.after !== undefined && actual <= boundary("after")) return false;
  if (condition.on_or_before !== undefined && actual > boundary("on_or_before")) return false;
  if (condition.on_or_after !== undefined && actual < boundary("on_or_after")) return false;
  return true;
}

function numberMatches(value, condition = {}) {
  if (condition.equals !== undefined && value !== condition.equals) return false;
  if (condition.greater_than !== undefined && value <= condition.greater_than) return false;
  if (condition.greater_than_or_equal_to !== undefined && value < condition.greater_than_or_equal_to) return false;
  if (condition.less_than !== undefined && value >= condition.less_than) return false;
  if (condition.less_than_or_equal_to !== undefined && value > condition.less_than_or_equal_to) return false;
  return true;
}

function wireValue(record, property) {
  if (property === "created_at") return record.session_created_at ?? record.event_created_at ?? record.created_at;
  if (property === "updated_at") return record.session_updated_at ?? record.updated_at;
  return record[property];
}

function compareRecords(left, right, property, direction) {
  const leftWireValue = wireValue(left, property);
  const rightWireValue = wireValue(right, property);
  const leftValue = ["created_time", "last_run_at", "created_at", "updated_at"].includes(property) ? Date.parse(leftWireValue) : leftWireValue;
  const rightValue = ["created_time", "last_run_at", "created_at", "updated_at"].includes(property) ? Date.parse(rightWireValue) : rightWireValue;
  const compared = typeof leftValue === "number" && typeof rightValue === "number"
    ? leftValue - rightValue
    : String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
  return compared * (direction === "descending" ? -1 : 1);
}

function guard(c, domain, capability = "interact:agents") {
  const auth = c.get("authUser");
  const actor = auth ? domain.userByLogin(auth.login) : null;
  if (!actor || domain.isMcpToken(c.get("authToken"))) return { response: notionError(c, 401, "unauthorized", "API token is invalid.") };
  if (c.req.header("Notion-Version") !== NOTION_VERSION) return { response: notionError(c, 400, "validation_error", `Notion-Version must be ${NOTION_VERSION}.`) };
  const scopes = c.get("authScopes") ?? [];
  if (!scopes.includes(capability) && !scopes.includes("interact:agents")) return { response: notionError(c, 403, "restricted_resource", "Token does not have the Interact with agents capability.") };
  return { actor };
}

function validation(c, message) { return notionError(c, 400, "validation_error", message); }
function missing(c, name) { return notionError(c, 404, "object_not_found", `Could not find ${name}.`); }

function publicAgent(record, { verbose = false, current = false } = {}) {
  const response = {
    object: "agent",
    id: record.notion_id,
    agent_type: record.agent_type,
    name: record.name,
    description: record.description ?? null,
    instructions_page_id: record.instructions_page_id ?? null,
    icon: structuredClone(record.icon ?? null),
    model: structuredClone(record.model ?? { mode: "auto" }),
    connections: structuredClone(record.connections ?? []),
    status: record.status,
    pause_reason: record.pause_reason ?? null,
    created_by: record.created_by ? { type: "user", id: record.created_by } : null,
    agent_version: record.agent_version ? structuredClone(record.agent_version) : null,
    created_time: record.created_time ?? null,
    last_edited_time: record.last_edited_time ?? null,
    last_run_at: record.last_run_at ?? null,
    credit_limit: record.credit_limit ?? null,
    triggers: structuredClone(record.triggers ?? []),
  };
  if (current) Object.assign(response, {
    created_by: record.created_by ? { object: "user", type: "user", id: record.created_by } : null,
    version: record.agent_version ? structuredClone(record.agent_version) : null,
    has_unpublished_changes: Boolean(record.has_unpublished_changes),
    last_run_time: record.last_run_at ?? null,
  });
  if (verbose) response.instructions = record.instructions ?? null;
  return response;
}

function agentMatches(record, filter, actor) {
  if (!filter) return true;
  if (Array.isArray(filter.and)) return filter.and.every((item) => agentMatches(record, item, actor));
  if (Array.isArray(filter.or)) return filter.or.some((item) => agentMatches(record, item, actor));
  if (filter.property === "id") return record.notion_id === normalizeId(filter.id?.equals);
  if (filter.property === "agent_type") return record.agent_type === filter.string?.equals;
  if (filter.property === "created_by") return record.created_by === normalizeId(filter.people?.contains === "me" ? actor.notion_id : filter.people?.contains);
  if (filter.property === "created_time") return dateMatches(record.created_time, filter.date);
  if (filter.property === "favorited") return Boolean(record.favorited_by?.includes(actor.notion_id)) === filter.checkbox?.equals;
  if (filter.property === "connections") return record.connections?.some((item) => ["mcp_server", "custom_mcp_server"].includes(item.type) && item.name === filter.mcp_server?.contains);
  if (filter.property === "status") return filter.status?.in?.includes(record.status);
  if (filter.property === "model_mode") return record.model?.mode === filter.select?.equals;
  if (filter.property === "agent_version") return record.agent_version?.number === filter.number?.equals;
  if (filter.property === "last_run_at") return dateMatches(record.last_run_at, filter.date);
  return false;
}

function publicSession(record, detailed = true) {
  const result = {
    object: "session", id: record.notion_id, agent_id: record.agent_id, title: record.title,
    status: record.status, created_at: wireValue(record, "created_at"), updated_at: wireValue(record, "updated_at"),
  };
  if (detailed) Object.assign(result, {
    created_by: { id: record.created_by, type: record.created_by_type ?? "user" },
    agent_version: structuredClone(record.agent_version ?? null), models: structuredClone(record.models ?? { type: "auto" }),
    trigger_type: record.trigger_type ?? "chat", type_labels: structuredClone(record.type_labels ?? ["chat"]),
    chat_user_emails: structuredClone(record.chat_user_emails ?? []), tool_types: structuredClone(record.tool_types ?? []),
    tool_call_count: record.tool_call_count ?? 0, credits_used: record.credits_used ?? 0,
    runs_completed: record.runs_completed ?? 1, message_count: record.message_count ?? 0,
  });
  if (record.required_actions?.length) result.required_actions = structuredClone(record.required_actions);
  if (record.error) result.error = structuredClone(record.error);
  return result;
}

function sessionMatches(record, filter) {
  if (!filter) return true;
  if (Array.isArray(filter.and)) return filter.and.every((item) => sessionMatches(record, item));
  if (Array.isArray(filter.or)) return filter.or.some((item) => sessionMatches(record, item));
  if (filter.property === "id") return record.notion_id === normalizeId(filter.string?.equals);
  if (filter.property === "agent_id") return record.agent_id === normalizeId(filter.string?.equals);
  if (filter.property === "status") return filter.status?.equals ? record.status === filter.status.equals : filter.status?.in?.includes(record.status);
  if (["created_at", "updated_at"].includes(filter.property)) {
    return dateMatches(wireValue(record, filter.property), filter.timestamp);
  }
  return false;
}

function eventMatches(record, filter) {
  if (!filter) return true;
  if (Array.isArray(filter.and)) return filter.and.every((item) => eventMatches(record, item));
  if (Array.isArray(filter.or)) return filter.or.some((item) => eventMatches(record, item));
  if (filter.property === "id") return record.notion_id === normalizeId(filter.string?.equals);
  if (filter.property === "type") {
    const condition = filter.event_type ?? filter.select ?? {};
    return condition.equals !== undefined ? record.type === condition.equals : condition.in?.includes(record.type) ?? false;
  }
  if (filter.property === "created_at") return dateMatches(wireValue(record, "created_at"), filter.timestamp, { equals: true });
  if (filter.property === "sequence") return numberMatches(record.sequence, filter.number);
  return false;
}

function publicEvent(record) {
  const { id: _storeId, notion_id, accessible_by: _access, created_at: _storeCreatedAt, updated_at: _storeUpdatedAt, event_created_at, ...rest } = structuredClone(record);
  return { object: "session_event", id: notion_id, ...rest, created_at: event_created_at ?? _storeCreatedAt };
}

export function createNotionAgentDomain(store, baseUrl) {
  const agents = collection(store, "notion_agents", ["notion_id", "created_by", "status"]);
  const sessions = collection(store, "notion_agent_sessions", ["notion_id", "agent_id", "created_by", "status"]);
  const events = collection(store, "notion_agent_session_events", ["notion_id", "session_id", "sequence", "type"]);
  const findAgent = (value, actor) => {
    const normalized = value === "notion_ai" ? PERSONAL_AGENT_ID : normalizeId(value);
    const record = agents.findOneBy("notion_id", normalized);
    return canRead(record, actor) ? record : null;
  };
  const findSession = (value, actor) => {
    const record = sessions.findOneBy("notion_id", normalizeId(value));
    return canRead(record, actor) ? record : null;
  };
  const createEvent = (session, type, fields = {}) => {
    const notionId = nextId(store, "session_event", "b1000000");
    return events.insert({ notion_id: notionId, session_id: session.notion_id, sequence: events.findBy("session_id", session.notion_id).length + 1, event_created_at: timestamp(store), type, accessible_by: structuredClone(session.accessible_by), ...structuredClone(fields) });
  };
  const agentUrl = (record) => `${baseUrl}/notion/agent/${record.notion_id.replaceAll("-", "")}`;
  const sessionUrl = (record) => `${baseUrl}/notion/session/${record.notion_id.replaceAll("-", "")}`;
  const agentResult = (record, options) => ({ ...publicAgent(record, options), url: agentUrl(record) });
  const sessionResult = (record) => ({ ...publicSession(record), url: sessionUrl(record) });
  const page = (records, cursor, limit, render, maximum = 100) => {
    const size = Math.min(maximum, Math.max(1, limit ?? 20));
    const selected = paginate(records, cursor, size);
    if (selected.invalid_cursor) return null;
    return { results: selected.selected.map(render), has_more: selected.next_cursor !== null, next_cursor: selected.next_cursor };
  };

  function mcpListAgents(args, actor) {
    let found = agents.all().filter((item) => canRead(item, actor) && item.status !== "deleted");
    if (args.name) found = found.filter((item) => item.name.toLowerCase().includes(String(args.name).toLowerCase()));
    if (args.agent_type?.length) found = found.filter((item) => args.agent_type.includes(item.agent_type));
    if (args.agent_ids?.length) { const ids = args.agent_ids.map((item) => item === "notion_ai" ? PERSONAL_AGENT_ID : normalizeId(item)); found = found.filter((item) => ids.includes(item.notion_id)); }
    if (args.created_by?.length) { const ids = args.created_by.map((item) => item === "me" ? actor.notion_id : normalizeId(item)); found = found.filter((item) => ids.includes(item.created_by)); }
    const result = page(found, args.start_cursor, args.page_size ?? 100, (item) => agentResult(item, { verbose: args.verbose }));
    return result && { object: "list", type: "agent", ...result };
  }
  function mcpSearchAgents(args, actor) {
    let found = agents.all().filter((item) => canRead(item, actor) && item.status === "active");
    if (args.scope === "favorites") found = found.filter((item) => item.favorited_by?.includes(actor.notion_id));
    if (args.query) {
      const query = args.query.toLowerCase();
      found = found.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(query));
    } else if (args.scope === "workspace") found.sort((a, b) => String(b.created_time).localeCompare(String(a.created_time)));
    return page(found, args.cursor, args.limit ?? 20, (item) => agentResult(item), 200);
  }
  function mcpQuerySessions(args, actor) {
    let found = sessions.all().filter((item) => canRead(item, actor) && sessionMatches(item, args.filter));
    if (args.query) found = found.filter((item) => item.title.toLowerCase().includes(args.query.toLowerCase()));
    for (const sort of [...(args.sorts ?? [])].reverse()) found.sort((a, b) => String(a[sort.property]).localeCompare(String(b[sort.property])) * (sort.direction === "descending" ? -1 : 1));
    const result = page(found, args.start_cursor, args.page_size ?? 100, sessionResult);
    return result && { object: "list", type: "session", ...result };
  }
  function mcpSearchSessions(args, actor) {
    const query = args.query.toLowerCase();
    const found = sessions.all().filter((item) => {
      if (!canRead(item, actor)) return false;
      const eventText = events.findBy("session_id", item.notion_id).flatMap((event) => event.content ?? []).map((part) => part.text ?? "").join(" ");
      return `${item.title} ${eventText}`.toLowerCase().includes(query);
    }).slice(0, 20);
    return { results: found.map((item) => ({ id: item.notion_id, title: item.title, url: sessionUrl(item), status: item.status })), warning: null };
  }
  function mcpSpawnSession(args, actor) {
    const agent = findAgent(args.agent_url ?? args.agent_id, actor);
    if (!agent || agent.status !== "active") return null;
    const id = nextId(store, "agent_session", "a1000000");
    const created = timestamp(store);
    let session = sessions.insert({ notion_id: id, agent_id: agent.notion_id, title: args.message.slice(0, 80), status: "in_progress", session_created_at: created, session_updated_at: created, created_by: actor.notion_id, created_by_type: "user", agent_version: structuredClone(agent.agent_version), models: agent.model?.mode === "pinned" ? { type: "pinned", ids: [agent.model.id] } : { type: "auto" }, accessible_by: structuredClone(agent.accessible_by), chat_user_emails: [actor.email], message_count: 1, runs_completed: 0 });
    createEvent(session, "user.message", { content: [{ type: "text", text: args.message }], created_by: { id: actor.notion_id, type: "user" } });
    createEvent(session, "session.status", { status: "in_progress" });
    session = sessions.findOneBy("notion_id", id);
    return { session: sessionResult(session), poll_after_seconds: 1 };
  }
  function mcpGetSessionStatus(args, actor) {
    const session = findSession(args.session_id, actor);
    return session ? { session: sessionResult(session) } : null;
  }
  function mcpWaitSession(args, actor) {
    let session = findSession(args.session_id, actor);
    if (!session) return null;
    if (["queued", "in_progress"].includes(session.status)) {
      const agent = findAgent(session.agent_id, actor);
      if (agent?.default_response) createEvent(session, "agent.message", { content: [{ type: "text", text: agent.default_response }], created_by: { id: agent.notion_id, type: "bot" } });
      createEvent(session, "session.status", { status: "completed" });
      session = sessions.update(session.id, { status: "completed", session_updated_at: timestamp(store), runs_completed: (session.runs_completed ?? 0) + 1, message_count: events.findBy("session_id", session.notion_id).filter((item) => item.type.endsWith(".message")).length });
      if (agent) agents.update(agent.id, { last_run_at: timestamp(store), runs_completed: (agent.runs_completed ?? 0) + 1 });
    }
    return { session: sessionResult(session) };
  }
  function mcpStopSession(args, actor) {
    const session = findSession(args.session_id, actor);
    if (!session) return null;
    if (["completed", "failed", "canceled", "terminated"].includes(session.status)) return { session: sessionResult(session), stopped: false };
    createEvent(session, "session.status", { status: "canceled" });
    const updated = sessions.update(session.id, { status: "canceled", session_updated_at: timestamp(store) });
    return { session: sessionResult(updated), stopped: true };
  }
  function mcpSendMessageToSession(args, actor) {
    let session = findSession(args.session_id, actor);
    if (!session) return null;
    createEvent(session, "user.message", { content: [{ type: "text", text: args.message }], created_by: { id: actor.notion_id, type: "user" } });
    createEvent(session, "session.status", { status: "in_progress" });
    session = sessions.update(session.id, { status: "in_progress", session_updated_at: timestamp(store), message_count: (session.message_count ?? 0) + 1 });
    return { session: sessionResult(session), accepted: true };
  }
  function mcpListSessionEvents(args, actor) {
    const session = findSession(args.session_id, actor);
    if (!session) return null;
    let found = events.findBy("session_id", session.notion_id);
    if (args.after_sequence !== undefined) found = found.filter((item) => item.sequence > args.after_sequence);
    if (args.before_sequence !== undefined) found = found.filter((item) => item.sequence < args.before_sequence);
    if (args.before_sequence !== undefined) found = found.slice(-(args.page_size ?? 100));
    const result = page(found, undefined, args.page_size ?? 100, (item) => {
      const event = publicEvent(item); const preview = (event.content ?? []).map((part) => part.text ?? "").join(" ").slice(0, 300);
      return { id: event.id, type: event.type, sequence: event.sequence, created_at: wireValue(event, "created_at"), preview };
    });
    return result && { session_id: session.notion_id, ...result };
  }
  function mcpReadSessionEvent(args, actor) {
    const session = findSession(args.session_id, actor);
    if (!session) return null;
    const event = args.sequence === undefined
      ? events.findOneBy("notion_id", normalizeId(args.event_id))
      : events.findBy("session_id", session.notion_id).find((item) => item.sequence === args.sequence);
    return event?.session_id === session.notion_id && canRead(event, actor) ? publicEvent(event) : null;
  }
  return { mcpListAgents, mcpSearchAgents, mcpQuerySessions, mcpSearchSessions, mcpSpawnSession, mcpGetSessionStatus, mcpWaitSession, mcpStopSession, mcpSendMessageToSession, mcpListSessionEvents, mcpReadSessionEvent };
}

export function registerAgentRoutes(app, store, baseUrl) {
  const domain = createNotionDomain(store, baseUrl);
  const agents = collection(store, "notion_agents", ["notion_id", "created_by", "status"]);
  const sessions = collection(store, "notion_agent_sessions", ["notion_id", "agent_id", "created_by", "status"]);
  const events = collection(store, "notion_agent_session_events", ["notion_id", "session_id", "sequence", "type"]);
  const tasks = collection(store, "notion_async_tasks", ["notion_id", "actor_id"]);

  const findAgent = (id, actor) => {
    const normalized = id === "notion_ai" ? PERSONAL_AGENT_ID : normalizeId(id);
    const record = agents.findOneBy("notion_id", normalized);
    return canRead(record, actor) ? record : null;
  };
  const findSession = (id, actor) => {
    const record = sessions.findOneBy("notion_id", normalizeId(id));
    return canRead(record, actor) ? record : null;
  };

  app.post("/v1/agents/query", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const size = pageSize(input.page_size); if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    let found = agents.all().filter((item) => canRead(item, auth.actor) && (input.include_deleted || item.status !== "deleted") && agentMatches(item, input.filter, auth.actor));
    if (input.query) found = found.filter((item) => `${item.name} ${item.description ?? ""}`.toLowerCase().includes(String(input.query).toLowerCase()));
    for (const sort of [...(input.sorts ?? [])].reverse()) found.sort((a, b) => compareRecords(a, b, sort.property, sort.direction));
    const page = paginate(found, input.start_cursor, size); if (page.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return c.json({ object: "list", type: "agent", results: page.selected.map((item) => publicAgent(item, { verbose: input.verbose })), has_more: page.next_cursor !== null, next_cursor: page.next_cursor });
  });

  app.get("/v1/agents/:id/insights", (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findAgent(c.req.param("id"), auth.actor); if (!record) return missing(c, "agent");
    return c.json({ object: "agent_insights", id: record.notion_id, name: record.name, agent_type: record.agent_type, status: record.status, pause_reason: record.pause_reason ?? null, created_by: record.created_by ? { id: record.created_by, type: "user" } : null, total_credits_used: record.total_credits_used ?? 0, credit_limit: canEdit(record, auth.actor) ? record.credit_limit ?? null : "hidden", runs_completed: record.runs_completed ?? 0 });
  });

  app.patch("/v1/agents/:id/credit_limit", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findAgent(c.req.param("id"), auth.actor); if (!record || !canEdit(record, auth.actor)) return missing(c, "agent");
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (input.credit_limit !== null && (!Number.isInteger(input.credit_limit) || input.credit_limit < 0)) return validation(c, "credit_limit must be a non-negative integer or null.");
    const edited = timestamp(store); agents.update(record.id, { credit_limit: input.credit_limit, last_edited_time: edited });
    return c.json({ agent_id: record.notion_id, credit_limit: input.credit_limit, last_edited_time: edited });
  });

  app.patch("/v1/agents/:id/status", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findAgent(c.req.param("id"), auth.actor); if (!record || !canEdit(record, auth.actor)) return missing(c, "agent");
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!["active", "disabled"].includes(input.status)) return validation(c, "status must be active or disabled.");
    const edited = timestamp(store); const pause = input.status === "disabled" ? "disabled_from_api" : null;
    agents.update(record.id, { status: input.status, pause_reason: pause, last_edited_time: edited });
    return c.json({ agent_id: record.notion_id, status: input.status, pause_reason: pause, last_edited_time: edited });
  });

  app.delete("/v1/agents/:id", (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findAgent(c.req.param("id"), auth.actor); if (!record || !canEdit(record, auth.actor)) return missing(c, "agent");
    const deleted = timestamp(store); agents.update(record.id, { status: "deleted", pause_reason: null, deleted_at: deleted, last_edited_time: deleted });
    return c.json({ agent_id: record.notion_id, status: "deleted", deleted_at: deleted });
  });

  app.post("/v1/agents/batch", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) return validation(c, "operations must contain from 1 through 100 items.");
    for (const operation of input.operations) {
      const record = findAgent(operation.agent_id, auth.actor); if (!record || !canEdit(record, auth.actor)) return missing(c, "agent");
      if (operation.action === "update_status" && ["active", "disabled"].includes(operation.fields?.status)) agents.update(record.id, { status: operation.fields.status, pause_reason: operation.fields.status === "disabled" ? "disabled_from_api" : null, last_edited_time: timestamp(store) });
      else if (operation.action === "update_credit_limit" && (operation.fields?.credit_limit === null || Number.isInteger(operation.fields?.credit_limit) && operation.fields.credit_limit >= 0)) agents.update(record.id, { credit_limit: operation.fields.credit_limit, last_edited_time: timestamp(store) });
      else if (operation.action === "delete") agents.update(record.id, { status: "deleted", deleted_at: timestamp(store), last_edited_time: timestamp(store) });
      else return validation(c, "An agent batch operation is not valid.");
    }
    const id = nextId(store, "async_task", "70000000"); const created = timestamp(store);
    tasks.insert({ notion_id: id, object: "async_task", type: "agent_batch", status: "queued", created_time: created, last_edited_time: created, actor_id: auth.actor.notion_id, result: null });
    return c.json({ object: "async_task", id, status_url: `${baseUrl}/v1/async_tasks/${id}`, created_time: created, operation: { surface: "rest", name: "agent_batch" }, status: "queued", poll_after_seconds: 1 });
  });

  app.get("/v1/agents/:id", (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findAgent(c.req.param("id"), auth.actor); if (!record) return missing(c, "agent");
    return c.json(publicAgent(record, { verbose: c.req.query("verbose") === "true", current: true }));
  });

  function createEvent(session, type, fields) {
    const notionId = nextId(store, "session_event", "b1000000");
    return events.insert({ notion_id: notionId, session_id: session.notion_id, sequence: events.findBy("session_id", session.notion_id).length + 1, event_created_at: timestamp(store), type, accessible_by: structuredClone(session.accessible_by), ...structuredClone(fields) });
  }

  function updateSession(input, actor) {
    let session = input.session_id ? findSession(input.session_id, actor) : null;
    if (input.session_id && !session) return { not_found: true };
    if (!session) {
      if (typeof input.message !== "string" || !input.message.trim() || !input.agent_id) return { validation_error: "message and agent_id are required to create a session." };
      const agent = findAgent(input.agent_id, actor); if (!agent || agent.status !== "active") return { not_found: true };
      const id = nextId(store, "agent_session", "a1000000"); const created = timestamp(store);
      session = sessions.insert({ notion_id: id, agent_id: agent.notion_id, title: input.message.slice(0, 80), status: "in_progress", session_created_at: created, session_updated_at: created, created_by: actor.notion_id, created_by_type: "user", agent_version: structuredClone(agent.agent_version), models: agent.model?.mode === "pinned" ? { type: "pinned", ids: [agent.model.id] } : { type: "auto" }, accessible_by: structuredClone(agent.accessible_by), chat_user_emails: [actor.email], message_count: 0 });
    }
    const priorEventCount = events.findBy("session_id", session.notion_id).length;
    if (typeof input.message === "string" && input.message.trim()) {
      createEvent(session, "user.message", { content: [{ type: "text", text: input.message }], created_by: { id: actor.notion_id, type: "user" }, metadata: structuredClone(input.metadata ?? null) });
      const agent = findAgent(session.agent_id, actor); const response = agent?.default_response;
      if (typeof response === "string" && response.trim()) createEvent(session, "agent.message", { content: [{ type: "text", text: response }], created_by: { id: agent.notion_id, type: "bot" }, metadata: { model: agent.model?.id ?? "auto" } });
      createEvent(session, "session.status", { status: "completed" });
      session = sessions.update(session.id, { status: "completed", session_updated_at: timestamp(store), message_count: events.findBy("session_id", session.notion_id).filter((item) => item.type.endsWith(".message")).length, runs_completed: (session.runs_completed ?? 0) + 1, last_run_at: timestamp(store) });
      if (agent) agents.update(agent.id, { last_run_at: timestamp(store), runs_completed: (agent.runs_completed ?? 0) + 1 });
    } else if (Array.isArray(input.actions)) {
      session = sessions.update(session.id, { status: "completed", required_actions: [], session_updated_at: timestamp(store) });
      createEvent(session, "session.status", { status: "completed" });
    } else if (typeof input.continue_from !== "string") return { validation_error: "The session update body is not valid." };
    return { session, newEvents: events.findBy("session_id", session.notion_id).slice(priorEventCount) };
  }

  app.post("/v1/sessions", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const result = updateSession(input, auth.actor);
    if (result.validation_error) return validation(c, result.validation_error); if (result.not_found) return missing(c, "agent or session");
    if ((c.req.header("Accept") ?? "").includes("text/event-stream")) {
      const snapshot = { type: "session.snapshot", session: publicSession(result.session, false) };
      const frames = [snapshot, ...result.newEvents.map((item) => ({ type: "event.committed", event: publicEvent(item) })), { type: "stream.end", session_id: result.session.notion_id, status: result.session.status, last_sequence: result.newEvents.at(-1)?.sequence ?? 0 }];
      return new Response(frames.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    return c.json(publicSession(result.session, false));
  });

  app.get("/v1/sessions/:id", (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findSession(c.req.param("id"), auth.actor); return record ? c.json(publicSession(record)) : missing(c, "session");
  });

  app.post("/v1/sessions/query", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const size = pageSize(input.page_size); if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    let found = sessions.all().filter((item) => canRead(item, auth.actor) && sessionMatches(item, input.filter));
    if (input.query) found = found.filter((item) => item.title.toLowerCase().includes(String(input.query).toLowerCase()));
    for (const sort of [...(input.sorts ?? [])].reverse()) found.sort((a, b) => compareRecords(a, b, sort.property, sort.direction));
    const page = paginate(found, input.start_cursor, size); if (page.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return c.json({ object: "list", type: "session", session: {}, results: page.selected.map((item) => publicSession(item)), has_more: page.next_cursor !== null, next_cursor: page.next_cursor });
  });

  app.post("/v1/sessions/:id/events/query", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const session = findSession(c.req.param("id"), auth.actor); if (!session) return missing(c, "session");
    const input = await body(c); if (!input) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    const size = pageSize(input.page_size); if (size === null) return validation(c, "page_size must be an integer from 1 through 100.");
    let found = events.findBy("session_id", session.notion_id).filter((item) => eventMatches(item, input.filter));
    for (const sort of [...(input.sorts ?? [])].reverse()) found.sort((a, b) => compareRecords(a, b, sort.property, sort.direction));
    const page = paginate(found, input.start_cursor, size); if (page.invalid_cursor) return validation(c, "start_cursor is not valid.");
    return c.json({ object: "list", type: "session_event", session_event: {}, results: page.selected.map(publicEvent), has_more: page.next_cursor !== null, next_cursor: page.next_cursor });
  });

  app.post("/v1/sessions/:id/cancel", async (c) => {
    const auth = guard(c, domain); if (auth.response) return auth.response;
    const record = findSession(c.req.param("id"), auth.actor); if (!record) return missing(c, "session");
    const input = await body(c); if (input === null) return notionError(c, 400, "invalid_json", "The request body is not valid JSON.");
    if (!STATUSES.has(record.status)) return validation(c, "Session status is not valid.");
    if (["completed", "failed", "canceled", "terminated"].includes(record.status)) return notionError(c, 409, "conflict_error", "The session is already in a terminal state.");
    const updated = sessions.update(record.id, { status: "canceled", session_updated_at: timestamp(store) }); createEvent(updated, "session.status", { status: "canceled" });
    return c.json(publicSession(updated, false));
  });
}

export function seedNotionAgents(store, config = {}) {
  const agents = collection(store, "notion_agents", ["notion_id", "created_by", "status"]);
  const sessions = collection(store, "notion_agent_sessions", ["notion_id", "agent_id", "created_by", "status"]);
  const events = collection(store, "notion_agent_session_events", ["notion_id", "session_id", "sequence", "type"]);
  for (const input of config.agents ?? []) agents.insert({
    notion_id: normalizeId(input.id), agent_type: input.agent_type ?? "custom_agent", name: input.name,
    description: input.description ?? null, instructions_page_id: input.instructions_page_id ? normalizeId(input.instructions_page_id) : null,
    instructions: input.instructions ?? null, icon: structuredClone(input.icon ?? null), model: structuredClone(input.model ?? { mode: "auto" }),
    connections: structuredClone(input.connections ?? [{ type: "notion", name: "Notion", account: null, permissions: [{ target: { type: "workspace" }, scopes: ["read"] }] }]),
    status: input.status ?? "active", pause_reason: input.pause_reason ?? null, created_by: normalizeId(input.created_by),
    agent_version: structuredClone(input.agent_version ?? { id: normalizeId(input.version_id ?? input.id), number: 1, published_at: input.created_time ?? DEFAULT_TIME }),
    created_time: input.created_time ?? DEFAULT_TIME, last_edited_time: input.last_edited_time ?? input.created_time ?? DEFAULT_TIME,
    last_run_at: input.last_run_at ?? null, credit_limit: input.credit_limit ?? null, triggers: structuredClone(input.triggers ?? []),
    accessible_by: (input.accessible_by ?? []).map(normalizeId), editable_by: (input.editable_by ?? [input.created_by]).map(normalizeId),
    favorited_by: (input.favorited_by ?? []).map(normalizeId),
    default_response: input.default_response ?? null, runs_completed: input.runs_completed ?? 0, total_credits_used: input.total_credits_used ?? 0,
  });
  for (const input of config.agent_sessions ?? []) {
    const { created_at, updated_at, ...record } = structuredClone(input);
    sessions.insert({ ...record, notion_id: normalizeId(input.id), agent_id: normalizeId(input.agent_id), created_by: normalizeId(input.created_by), accessible_by: (input.accessible_by ?? []).map(normalizeId), session_created_at: created_at ?? DEFAULT_TIME, session_updated_at: updated_at ?? created_at ?? DEFAULT_TIME });
  }
  for (const input of config.agent_session_events ?? []) {
    const { created_at, ...record } = structuredClone(input);
    events.insert({ ...record, notion_id: normalizeId(input.id), session_id: normalizeId(input.session_id), accessible_by: (input.accessible_by ?? []).map(normalizeId), event_created_at: created_at ?? DEFAULT_TIME });
  }
}
