const API_VERSION = "worldfixture.connector/v1";

function appRef(kind, id) {
  return `${kind}_${String(id).replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

function mappingPlan(packs) {
  const organizations = packs.identity?.organizations ?? [];
  const people = packs.identity?.people ?? [];
  const primary = organizations.find((entry) => entry.primary) ?? organizations[0];
  const members = people.filter((entry) => entry.organization_id === primary?.id);
  const customers = organizations.filter((entry) => entry.id !== primary?.id);
  const projects = packs.work?.projects ?? [];
  const tasks = packs.work?.tasks ?? [];
  return {
    primary,
    members,
    customers,
    projects,
    tasks,
    response: {
      api_version: "worldfixture.connector-plan/v1",
      summary: `Will fill Relay Digest with ${members.length} members, ${customers.length} accounts, ${projects.length} projects, and ${tasks.length} tasks.`,
      mappings: [
        { source: "identity.organizations[primary]", target: "workspace", status: primary ? "mapped" : "blocked", ...(!primary ? { reason: "no primary organization" } : {}) },
        { source: "identity.people", target: "members", status: "mapped" },
        { source: "identity.organizations[external]", target: "accounts", status: "mapped" },
        { source: "work.projects", target: "projects", status: "mapped" },
        { source: "work.tasks", target: "tasks", status: "mapped" },
        { source: "finance", target: "none", status: "skipped", reason: "Relay Digest reads finance data from Stripe" },
      ],
      counts: { workspaces: primary ? 1 : 0, members: members.length, accounts: customers.length, projects: projects.length, tasks: tasks.length },
      warnings: primary ? [] : ["The world has no primary organization."],
    },
  };
}

function referencesFor(plan) {
  const references = [];
  if (plan.primary) references.push({ worldfixture_ref: `organization/${plan.primary.id}`, application_ref: appRef("workspace", plan.primary.id) });
  for (const person of plan.members) references.push({ worldfixture_ref: `person/${person.id}`, application_ref: appRef("member", person.id) });
  for (const organization of plan.customers) references.push({ worldfixture_ref: `organization/${organization.id}`, application_ref: appRef("account", organization.id) });
  for (const project of plan.projects) references.push({ worldfixture_ref: `project/${project.id}`, application_ref: appRef("project", project.id) });
  for (const task of plan.tasks) references.push({ worldfixture_ref: `task/${task.id}`, application_ref: appRef("task", task.id) });
  return references;
}

export function createWorldFixtureConnector({ token, production = process.env.NODE_ENV === "production" } = {}) {
  const enabled = !production && typeof token === "string" && token.length > 0;
  const state = { phase: "empty", artifact: null, records: null, receipts: [], idempotency: new Map(), events: new Set() };

  function discovery() {
    return {
      api_version: API_VERSION,
      application: { id: "relay-digest", name: "Relay Digest" },
      capabilities: { plan: true, seed: true, event: true, status: true, reset: false },
      accepts: ["identity", "work", "support"],
    };
  }

  function authorized(authorization) {
    return authorization === `Bearer ${token}`;
  }

  async function handle({ method, path, authorization, input = {} }) {
    if (!enabled) return { status: 404, body: { error: "not found" } };
    if (method === "GET" && path === "/.well-known/worldfixture") return { status: 200, body: discovery() };
    if (!authorized(authorization)) return { status: 401, body: { error: { code: "not_authenticated", message: "WORLDFIXTURE_TOKEN is required" } } };

    if (method === "POST" && path === "/__worldfixture/plan") {
      const plan = mappingPlan(input.packs ?? {});
      return { status: 200, body: plan.response };
    }
    if (method === "POST" && path === "/__worldfixture/seed") {
      if (!input.idempotency_key) return { status: 400, body: { error: { code: "idempotency_required", message: "idempotency_key is required" } } };
      if (state.idempotency.has(input.idempotency_key)) {
        return { status: 200, body: { ...state.idempotency.get(input.idempotency_key), status: "already_applied" } };
      }
      const plan = mappingPlan(input.packs ?? {});
      if (!plan.primary) return { status: 422, body: { error: { code: "mapping_invalid", message: "the world has no primary organization" } } };
      const receipt = {
        api_version: "worldfixture.connector-receipt/v1",
        status: "applied",
        idempotency_key: input.idempotency_key,
        summary: plan.response.summary,
        counts: plan.response.counts,
        references: referencesFor(plan),
        warnings: plan.response.warnings,
      };
      state.phase = "seeded";
      state.artifact = input.world?.artifact_sha256 ?? null;
      state.records = plan;
      state.receipts.push(receipt);
      state.idempotency.set(input.idempotency_key, receipt);
      return { status: 200, body: receipt };
    }
    if (method === "POST" && path === "/__worldfixture/events") {
      if (!input.event_id) return { status: 400, body: { error: { code: "event_id_required", message: "event_id is required" } } };
      const repeated = state.events.has(input.event_id);
      if (!repeated) state.events.add(input.event_id);
      state.phase = "changed";
      const receipt = {
        api_version: "worldfixture.connector-receipt/v1",
        status: repeated ? "already_applied" : "applied",
        event_id: input.event_id,
        summary: repeated ? "Event was already applied." : `Applied ${input.kind}.`,
        counts: repeated ? {} : { events: 1 },
        references: [],
      };
      if (!repeated) state.receipts.push(receipt);
      return { status: 200, body: receipt };
    }
    if (method === "GET" && path === "/__worldfixture/status") return { status: 200, body: {
      api_version: "worldfixture.connector-status/v1", state: state.phase,
      ...(state.artifact ? { artifact_sha256: state.artifact } : {}), receipts: state.receipts.slice(-20),
    } };
    return { status: 404, body: { error: "not found" } };
  }

  return { enabled, handle };
}
