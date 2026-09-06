// View data comes from selected runtime surfaces and measured provider results.
const PROVIDER_KEYS = { google: "gmail", http: "website" };

export function bindingGroupsFor(data, { surfaceId, query = "" } = {}) {
  const bindings = data.bindings ?? {};
  const metadata = data.bindingGroups ?? [];
  const surface = (data.surfaces ?? []).find((entry) => entry.id === surfaceId);
  const capabilities = new Set(surface?.capabilities ?? []);
  const related = metadata.filter((group) => group.id === surfaceId || group.capabilities?.some((profile) => capabilities.has(profile)));
  const selected = surfaceId === undefined ? null : new Set(surface?.bindingNames ?? related.flatMap((group) => group.bindings ?? []));
  const eligible = (name) => Object.hasOwn(bindings, name) && (selected === null || selected.has(name));
  const assigned = new Set();
  const groups = metadata.map((group) => {
    const names = [...new Set(group.bindings ?? [])].filter(eligible);
    names.forEach((name) => assigned.add(name));
    return { ...group, entries: names.map((name) => [name, bindings[name]]) };
  }).filter((group) => group.entries.length);
  const remaining = Object.keys(bindings).filter((name) => eligible(name) && !assigned.has(name));
  if (remaining.length) groups.push({ id: "unassigned-bindings", name: "Other bindings", capabilities: [],
    entries: remaining.map((name) => [name, bindings[name]]) });
  const text = query.trim().toLowerCase();
  return groups.map((group) => {
    const matchesGroup = [group.name, group.id, group.service, ...(group.capabilities ?? [])].some((value) => String(value ?? "").toLowerCase().includes(text));
    return { ...group, entries: matchesGroup ? group.entries : group.entries.filter(([name]) => name.toLowerCase().includes(text)) };
  }).filter((group) => group.entries.length);
}

export function surfaceRead(data, surface) {
  const key = PROVIDER_KEYS[surface.id] ?? surface.id;
  const provider = data.providers?.[key];
  const legacyError = provider?.status === undefined && (data.providers?.errors ?? []).find((entry) => [key, surface.id, surface.name].some((name) =>
    String(entry.provider).toLowerCase().startsWith(String(name).toLowerCase())));
  if (!provider || provider.status === "error" || provider.status === "not-selected" || provider.available === false || legacyError) {
    return { provider, available: false, error: provider?.error ?? legacyError?.message ?? "No resource read is available for this surface." };
  }
  return { provider, available: true, error: null };
}

export function collectionRead(provider, name) {
  const rows = Array.isArray(provider?.[name]) ? provider[name] : [];
  const state = provider?.collectionStatus?.[name];
  const status = !Array.isArray(provider?.[name]) ? "unavailable" : state?.status ??
    (provider?.status === undefined || provider.status === "ready" ? "complete" : "unavailable");
  return { rows, status, count: status === "complete" ? rows.length : null,
    error: state?.error ?? (status === "complete" ? null : "A complete collection read is unavailable.") };
}

const COLLECTIONS = {
  slack: [["channels", "Channels"], ["messageCount", "Messages"]],
  google: [["inbox.resultSizeEstimate", "Inbox messages", "estimate"], ["sent.resultSizeEstimate", "Sent messages", "estimate"]],
  mail: [["inbox.exists", "Inbox messages"], ["sent.exists", "Sent messages"]],
  github: [["repositories", "Repositories"], ["issues", "Issues"]],
  s3: [["details", "Buckets"]], notion: [["pages", "Pages"], ["databases", "Databases"]],
  stripe: [["customers", "Customers"], ["invoices", "Invoices"]],
  linear: [["teams", "Teams"], ["issues", "Issues"]], okta: [["users", "Users"], ["groups", "Groups"]],
  clerk: [["users", "Users"], ["organizations", "Organizations"]], twilio: [["phone_numbers", "Phone numbers"]],
  resend: [["emails", "Emails"], ["contactGroups", "Contact groups"]], vercel: [["projects", "Projects"], ["deployments", "Deployments"]],
  mongoatlas: [["projects", "Projects"]],
};

export function surfaceResources(data, surface) {
  const read = surfaceRead(data, surface);
  if (!read.available) return { ...read, resources: [] };
  if (surface.id === "domain") {
    const complete = read.provider.collectionStatus?.collections?.status === "complete";
    return { ...read, resources: (read.provider.collections ?? []).map(row => ({ label: row.name,
      count: complete ? row.count : null, status: complete ? "complete" : "unavailable" })) };
  }
  if (surface.id === "http") return typeof read.provider.preview === "string" && read.provider.preview !== "Unavailable"
    ? { ...read, resources: [{ label: "HTTP page reads", count: 1, status: "complete" }] }
    : { ...read, available: false, resources: [], error: "No HTTP page read is available." };
  const resources = (COLLECTIONS[surface.id] ?? []).map(([path, label, kind]) => {
    const value = path.split(".").reduce((node, field) => node?.[field], read.provider);
    const state = read.provider.collectionStatus?.[path] ?? read.provider.collectionStatus?.[path.split(".")[0]];
    const count = Array.isArray(value) ? value.length : typeof value === "number" && Number.isFinite(value) ? value : null;
    const unavailable = count === null || ["failed", "unavailable", "partial"].includes(state?.status);
    return { label, count: unavailable ? null : count, status: state?.status === "partial" ? "partial" : unavailable ? "unavailable" : kind ?? state?.status ?? "loaded", error: state?.error };
  });
  if (!resources.length) return { ...read, available: false, resources, error: "No resource reader is available for this surface." };
  return { ...read, resources };
}

export function resourceCountText(resource) {
  if (resource.count === null) return resource.status === "partial" ? "Unavailable · partial read" : "Unavailable";
  return `${resource.count} ${resource.status === "complete" ? "total" : resource.status === "estimate" ? "estimated" : "loaded"}`;
}

// These option values are outside the canonical organization ID syntax.
export const ALL_ORGANIZATIONS = "*";
export const NO_ORGANIZATION = "";

export function worldLabels(data) {
  const world = data.world ?? {};
  const identity = [world.id, world.version].filter(Boolean).join(":") || "Selected world";
  const title = world.title?.trim() || identity;
  const organization = world.organizationId ? world.company?.trim()
    || data.organizations?.find(entry => entry.id === world.organizationId)?.name?.trim()
    || world.organizationId : null;
  return { organization, heading: organization ?? title,
    detail: organization && title !== identity ? `${title} · ${identity}` : identity };
}

export function peopleSelection(data, { organizationId = ALL_ORGANIZATIONS, query = "" } = {}) {
  const people = Array.isArray(data.people) ? data.people : [];
  const organizations = new Map((data.organizations ?? []).map((entry) => [entry.id, entry.name?.trim() || entry.id]));
  for (const person of people) {
    const id = person.organization_id ?? NO_ORGANIZATION;
    if (!organizations.has(id)) organizations.set(id, person.organization_name?.trim() || id || "No organization");
  }
  const scope = organizationId === ALL_ORGANIZATIONS ? people : people.filter((person) => (person.organization_id ?? NO_ORGANIZATION) === organizationId);
  const text = query.trim().toLowerCase();
  const organization = worldLabels(data).organization;
  const worldPeople = data.world?.worldPeople ?? people.length;
  const organizationPeople = organization === null ? null : data.world?.organizationPeople
    ?? people.filter((person) => person.organization_id === data.world?.organizationId).length;
  const organizationSummary = organization === null ? "No primary organization declared" : `${organizationPeople} in ${organization}`;
  return { organizations: [...organizations].map(([id, name]) => ({ id, name })), scope,
    people: scope.filter((person) => [person.name, person.id, person.role, person.email, person.organization_name].some((value) => String(value ?? "").toLowerCase().includes(text))),
    worldPeople, organizationPeople, organizationSummary,
    summary: `${organization === null ? "" : `${organizationSummary} · `}${worldPeople} in the world` };
}

export function overviewExamples(data) {
  const examples = [];
  const selected = (id, profile) => (data.surfaces ?? []).some((surface) => surface.id === id &&
    (surface.capabilities === undefined || surface.capabilities.includes(profile)));
  const previewPath = data.providers?.website?.previewPath;
  if (selected("http", "http.public-site.v1") && data.bindings?.SITE_BASE_URL && typeof previewPath === "string" && previewPath.startsWith("/")) examples.push({ surface: "http", name: "Read the selected website",
    command: 'eval "$(npx worldfixture env)"\ncurl --fail -sS "${SITE_BASE_URL%/}"' + `'${previewPath.replaceAll("'", "'\\''")}'` });
  if (selected("slack", "slack.messaging.v1") && data.bindings?.SLACK_BASE_URL && data.bindings?.SLACK_TOKEN) examples.push({ surface: "slack", name: "Read Slack channels",
    command: 'eval "$(npx worldfixture env)"\ncurl --fail -sS -X POST "$SLACK_BASE_URL/api/conversations.list" \\\n  -H "Authorization: Bearer $SLACK_TOKEN" \\\n  -H "Content-Type: application/x-www-form-urlencoded" --data \'limit=100\'' });
  if (!examples.length) examples.push({ name: "Read this run's connection settings", command: "npx worldfixture env --json" });
  return examples;
}
