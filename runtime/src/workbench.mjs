import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveToken } from "./bindings.mjs";
import { submit } from "./commands.mjs";
import { inbox } from "./imap.mjs";
import { probe } from "./readiness.mjs";
import { send as sendMail } from "./smtp.mjs";
import { appendEvent, eventsAfter, latestEvents } from "./state.mjs";
import { contents, primaryOrganization, readWorld } from "./world.mjs";
import {
  connectorPrompt,
  connectorStatus,
  deliverConnectorEvent,
  discoverConnector,
  planConnector,
  resetConnector,
  seedConnector,
  connectorWorld,
} from "./connector.mjs";
import { SCALE_PRESETS, ScaleError, parseLimits, parseScale } from "./scale.mjs";
import { connectorEventFromWorldEvent, observedKinds, selectWorldEvent } from "./replay.mjs";

const UI_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../workbench-ui/dist");
const MIME = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png" };

const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
};

async function body(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 128 * 1024) throw new Error("request is too large");
  }
  return text ? JSON.parse(text) : {};
}

async function providerJson(url, token, options = {}) {
  const headers = { accept: "application/json", ...(options.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 180)}`);
  const result = text ? JSON.parse(text) : {};
  if (result.ok === false) throw new Error(result.error ?? "provider refused the request");
  return result;
}

function safe(value, fallback) {
  return value.status === "fulfilled" ? value.value : fallback;
}

function projection(artifactPath, name, fallback = {}) {
  try { return JSON.parse(readFileSync(join(artifactPath, `projections/${name}.json`), "utf8")); }
  catch { return fallback; }
}

function xmlValue(text, name) {
  return text.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";
}

function s3Objects(xml) {
  return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => ({
    key: xmlValue(match[1], "Key"), size: Number(xmlValue(match[1], "Size") || 0),
  }));
}

async function s3Overview(bindings, artifactPath) {
  const accepted = projection(artifactPath, "aws").s3?.buckets ?? [];
  return Promise.all(accepted.map(async ({ name }) => {
    const response = await fetch(`${bindings.S3_BASE_URL}/${encodeURIComponent(name)}/?list-type=2`);
    const xml = await response.text();
    if (!response.ok) throw new Error(`S3 returned ${response.status}`);
    return { name, objects: s3Objects(xml) };
  }));
}

function gmailHeaders(message) {
  const headers = Object.fromEntries((message.payload?.headers ?? []).map((entry) => [entry.name.toLowerCase(), entry.value]));
  return { id: message.id, threadId: message.threadId, subject: headers.subject, from: headers.from, to: headers.to,
    date: headers.date, internalDate: message.internalDate, messageId: headers["message-id"], labels: message.labelIds ?? [] };
}

function newestFirst(messages, dateOf) {
  return [...messages].sort((left, right) => dateOf(right) - dateOf(left));
}

async function gmailFolder(bindings, label) {
  const query = new URLSearchParams({ maxResults: "20", labelIds: label });
  const list = await providerJson(`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages?${query}`, bindings.GOOGLE_TOKEN);
  const messages = await Promise.all((list.messages ?? []).slice(0, 20).map((message) =>
    providerJson(`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${message.id}?format=metadata`, bindings.GOOGLE_TOKEN)
      .then(gmailHeaders).catch(() => ({ id: message.id, threadId: message.threadId }))));
  return { messages: newestFirst(messages, (message) => Number(message.internalDate) || Date.parse(message.date) || 0),
    resultSizeEstimate: list.resultSizeEstimate ?? messages.length };
}

async function gmailOverview(bindings) {
  const [inboxFolder, sentFolder] = await Promise.all([gmailFolder(bindings, "INBOX"), gmailFolder(bindings, "SENT")]);
  return { inbox: inboxFolder, sent: sentFolder, messages: inboxFolder.messages,
    resultSizeEstimate: inboxFolder.resultSizeEstimate + sentFolder.resultSizeEstimate };
}

async function githubOverview(bindings, world) {
  let repositories;
  try {
    const identity = await providerJson(`${bindings.GITHUB_BASE_URL}/user`, bindings.GITHUB_TOKEN);
    const visible = await providerJson(`${bindings.GITHUB_BASE_URL}/users/${encodeURIComponent(identity.login)}/repos`, bindings.GITHUB_TOKEN);
    if (Array.isArray(visible) && visible.length) repositories = visible;
  } catch {
    /* Use accepted world resource names only to select provider API reads. */
  }
  if (!repositories) {
    const organizations = new Map(world.organizations.map((entry) => [entry.id, entry.slug ?? entry.id]));
    repositories = await Promise.all((world.software?.repositories ?? []).map((repository) =>
      providerJson(`${bindings.GITHUB_BASE_URL}/repos/${organizations.get(repository.owner_id)}/${repository.name}`, bindings.GITHUB_TOKEN)));
  }
  const issueLists = await Promise.all(repositories.map((repository) =>
    providerJson(`${bindings.GITHUB_BASE_URL}/repos/${repository.full_name}/issues?state=open&per_page=30`, bindings.GITHUB_TOKEN)
      .catch(() => [])));
  return { repositories, issues: issueLists.flat().filter((issue) => !issue.pull_request) };
}

// SLACK MESSAGES CARRY AN ID, NOT A NAME.
//
// `conversations.history` returns `{type, user, text, ts}` and no `user_name`,
// so the Chat screen printed the raw id as the author and made an avatar out of
// its first letters: every one of the 1,517 messages in
// business.saas-company.v3 was attributed to something like "U6070E88FB".
//
// The world cannot supply the missing name. `world.people[].slack_id` holds
// U000000001-style ids; the emulator issues ids like UF474D2E90, and zero of
// the 99 ids that authored those messages appear in the world's map. The
// provider answers the question itself: `users.list` returns 100 members and
// resolves all 99 authors.
//
// It is read once per base URL and refreshed only when a lookup misses, because
// the workspace token is metered at 5,000 requests an hour and a name lookup
// must not be charged per screen refresh.
const slackNames = new Map();

async function slackUserNames(bindings, { refresh = false } = {}) {
  const key = bindings.SLACK_BASE_URL;
  if (!refresh && slackNames.has(key)) return slackNames.get(key);
  const names = new Map();
  let cursor = "";
  do {
    const page = await providerJson(`${bindings.SLACK_BASE_URL}/api/users.list`, bindings.SLACK_TOKEN, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ limit: "1000", ...(cursor ? { cursor } : {}) }),
    });
    for (const member of page.members ?? []) {
      // `||`, not `??`: a member with no display name arrives with these fields
      // present and empty, and an empty string is not a name.
      names.set(member.id, member.profile?.real_name || member.real_name || member.name);
    }
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  slackNames.set(key, names);
  return names;
}

// Names are a display nicety: a Slack that refuses `users.list` must still show
// its history, so a failed read leaves the ids in place and is not cached.
async function slackUserNamesOrEmpty(bindings, options) {
  return slackUserNames(bindings, options).catch(() => new Map());
}

// `||`, not `??`. The emulator always emits `topic` as an object, so a channel
// with no topic arrives as `{value: ""}` and `??` keeps the empty string. The
// declared topic behind it is a live fallback and not a dead branch: all 28
// channel names in business.saas-company.v3 match the world's own channel
// names. The middle `?? channel.topic` branch is gone -- `topic` is always the
// object, so that branch could only ever have rendered "[object Object]".
export function slackChannelTopic(channel = {}, declared) {
  return channel.topic?.value || declared?.topic;
}

async function slackOverview(bindings, world) {
  const listed = await providerJson(`${bindings.SLACK_BASE_URL}/api/conversations.list`, bindings.SLACK_TOKEN, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ limit: "100", types: "public_channel,private_channel,mpim,im" }),
  });
  const histories = await Promise.all((listed.channels ?? []).map((channel) =>
    providerJson(`${bindings.SLACK_BASE_URL}/api/conversations.history`, bindings.SLACK_TOKEN, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel: channel.id, limit: "100" }),
    }).catch(() => ({ messages: [] }))));
  const worldChannels = new Map((world.communication?.channels ?? []).map((channel) => [channel.name, channel]));
  // The world's `slack_id` values cannot name a direct message either: they are
  // U000000001-style ids the emulator never issues. The provider's own member
  // list is the only source that resolves the ids Slack actually returns.
  const people = await slackUserNamesOrEmpty(bindings);
  const channels = (listed.channels ?? []).map((channel, index) => ({
    ...channel,
    messageCount: histories[index]?.messages?.length ?? 0,
    latestTs: Math.max(0, ...(histories[index]?.messages ?? []).map((message) => Number(message.ts) || Date.parse(message.timestamp) / 1000 || 0)),
    displayName: channel.is_im ? people.get(channel.user) : channel.name,
    topic: slackChannelTopic(channel, worldChannels.get(channel.name)),
  }));
  return { channels, messageCount: histories.reduce((total, history) => total + (history.messages?.length ?? 0), 0) };
}

export function providerBrowserUrl(value, publicBaseUrl) {
  if (!value || !publicBaseUrl) return value;
  try {
    const source = new URL(value);
    const target = new URL(publicBaseUrl);
    target.pathname = source.pathname;
    target.search = source.search;
    target.hash = source.hash;
    return target.toString();
  } catch {
    return value;
  }
}

async function notionOverview(bindings, artifactPath, publicBaseUrl = bindings.NOTION_BASE_URL) {
  const headers = { "Notion-Version": "2026-03-11", "content-type": "application/json" };
  const configured = projection(artifactPath, "emulator-overlay").notion ?? projection(artifactPath, "notion", {});
  const readAll = async (path, inputs = []) => (await Promise.all(inputs.map((input) =>
    providerJson(`${bindings.NOTION_BASE_URL}${path}/${encodeURIComponent(input.id)}`, bindings.NOTION_TOKEN, { headers })
      .catch(() => null)))).filter(Boolean);
  const [users, search, uploads, agents, sessions] = await Promise.all([
    providerJson(`${bindings.NOTION_BASE_URL}/v1/users`, bindings.NOTION_TOKEN, { headers }),
    providerJson(`${bindings.NOTION_BASE_URL}/v1/search`, bindings.NOTION_TOKEN, {
      method: "POST", headers, body: JSON.stringify({ page_size: 100 }),
    }),
    providerJson(`${bindings.NOTION_BASE_URL}/v1/file_uploads?page_size=100`, bindings.NOTION_TOKEN, { headers })
      .catch(() => ({ results: [] })),
    providerJson(`${bindings.NOTION_BASE_URL}/v1/agents/query`, bindings.NOTION_TOKEN, {
      method: "POST", headers, body: JSON.stringify({ page_size: 100, include_deleted: true, verbose: true }),
    }).catch(() => ({ results: [] })),
    providerJson(`${bindings.NOTION_BASE_URL}/v1/sessions/query`, bindings.NOTION_TOKEN, {
      method: "POST", headers, body: JSON.stringify({ page_size: 100, sorts: [{ property: "updated_at", direction: "descending" }] }),
    }).catch(() => ({ results: [] })),
  ]);
  const pageResults = (search.results ?? []).filter((entry) => entry.object === "page");
  const listedComments = await Promise.all(pageResults.map((page) =>
    providerJson(`${bindings.NOTION_BASE_URL}/v1/comments?block_id=${encodeURIComponent(page.id)}&page_size=100`, bindings.NOTION_TOKEN, { headers })
      .then((result) => result.results ?? []).catch(() => [])));
  const discoveredSources = (search.results ?? []).filter((entry) => entry.object === "data_source");
  const sourceInputs = [...new Map([...(configured.data_sources ?? []), ...discoveredSources].map((entry) => [entry.id, entry])).values()];
  const dataSources = await readAll("/v1/data_sources", sourceInputs);
  const databaseInputs = [...new Map([
    ...(configured.databases ?? []),
    ...dataSources.map((source) => ({ id: source.parent?.database_id })).filter((entry) => entry.id),
  ].map((entry) => [entry.id, entry])).values()];
  const databases = await readAll("/v1/databases", databaseInputs);
  const listedViews = await Promise.all(databases.map((database) =>
    providerJson(`${bindings.NOTION_BASE_URL}/v1/views?database_id=${encodeURIComponent(database.id)}&page_size=100`, bindings.NOTION_TOKEN, { headers })
      .then((result) => result.results ?? []).catch(() => [])));
  const viewInputs = [...new Map(listedViews.flat().map((entry) => [entry.id, entry])).values()];
  const views = await readAll("/v1/views", viewInputs);
  const mcp = await providerJson(`${bindings.NOTION_BASE_URL}/__worldfixture/mcp-observability`, bindings.NOTION_TOKEN)
    .catch(() => ({ sessions: [], calls: [], changes: [], asyncTasks: [] }));
  const admin = sanitizeNotionInspection(await providerJson(`${bindings.NOTION_BASE_URL}/__worldfixture/notion-admin`, bindings.NOTION_TOKEN)
    .catch(() => ({ connections: [], tokens: [], webhook_subscriptions: [], webhook_deliveries: [], live_webhook_delivery: false })));
  const adminHeaders = { "Notion-Version": "2026-06-01", "content-type": "application/json" };
  const adminBaseUrl = bindings.NOTION_ADMIN_BASE_URL ?? bindings.NOTION_BASE_URL;
  const adminToken = bindings.NOTION_ADMIN_TOKEN;
  const spaceId = configured.workspace?.id;
  const enterprise = !adminToken || !spaceId ? {} : await Promise.all([
    providerJson(`${adminBaseUrl}/admin/v1/legal_holds`, adminToken, { headers: adminHeaders }).catch(() => ({ legal_holds: [] })),
    providerJson(`${adminBaseUrl}/admin/v1/spaces/${encodeURIComponent(spaceId)}/groups`, adminToken, { headers: adminHeaders }).catch(() => ({ results: [] })),
    providerJson(`${adminBaseUrl}/admin/v1/spaces/${encodeURIComponent(spaceId)}/agents`, adminToken, { headers: adminHeaders }).catch(() => ({ results: [] })),
    providerJson(`${adminBaseUrl}/admin/v1/spaces/${encodeURIComponent(spaceId)}/personal_access_tokens`, adminToken, { headers: adminHeaders }).catch(() => ({ results: [] })),
    providerJson(`${adminBaseUrl}/admin/v1/mcp_client_connections?workspace_id=${encodeURIComponent(spaceId)}`, adminToken, { headers: adminHeaders }).catch(() => ({ results: [] })),
  ]).then(([legalHolds, groups, adminAgents, personalAccessTokens, mcpClientConnections]) => ({ legalHolds: legalHolds.legal_holds ?? [], groups: groups.results ?? [], adminAgents: adminAgents.results ?? [], personalAccessTokens: personalAccessTokens.results ?? [], mcpClientConnections: mcpClientConnections.results ?? [] }));
  return { users: users.results ?? [], pages: pageResults.map((page) => ({ ...page, url: providerBrowserUrl(page.url, publicBaseUrl) })),
    databases, dataSources, views, comments: listedComments.flat(), fileUploads: uploads.results ?? [], agents: agents.results ?? [], agentSessions: sessions.results ?? [],
    asyncTasks: mcp.asyncTasks ?? [], changes: mcp.changes ?? [],
    mcpUrl: `${bindings.NOTION_BASE_URL}/mcp`, mcpSessions: mcp.sessions ?? [], mcpCalls: mcp.calls ?? [],
    connections: admin.connections ?? [], connectionTokens: admin.tokens ?? [], webhookSubscriptions: admin.webhook_subscriptions ?? [],
    webhookDeliveries: admin.webhook_deliveries ?? [], liveWebhookDelivery: Boolean(admin.live_webhook_delivery), ...enterprise, spaceId, available: true };
}

function resultList(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of ["data", "results", "items", "value", ...keys]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

async function optionalProviderList(baseUrl, token, path, ...keys) {
  if (!baseUrl) return [];
  return resultList(await providerJson(`${baseUrl}${path}`, token), ...keys);
}

// These reads make the Workbench show the state that an application sees. The
// accepted projections are only used where a provider has no list operation.
// One failed product read is settled separately in providerOverview, so a
// broken optional surface cannot hide the rest of the world.
async function stripeOverview(bindings) {
  const read = (path) => optionalProviderList(bindings.STRIPE_BASE_URL, bindings.STRIPE_TOKEN, path);
  const [customers, products, prices, paymentIntents, charges, rawSubscriptions, rawInvoices] = await Promise.all([
    read("/v1/customers?limit=100"), read("/v1/products?limit=100"), read("/v1/prices?limit=100"),
    read("/v1/payment_intents?limit=100"), read("/v1/charges?limit=100"),
    read("/v1/subscriptions?limit=100&status=all"), read("/v1/invoices?limit=100"),
  ]);
  const subscriptions = rawSubscriptions.map((subscription) => {
    const customer = customers.find((entry) => entry.id === subscription.customer);
    const price = subscription.items?.data?.[0]?.price;
    const product = products.find((entry) => entry.id === price?.product);
    return { ...subscription, customer_id: subscription.customer, customer: customer?.name ?? subscription.customer,
      product: product?.name ?? price?.product ?? "Plan", amount_cents: price?.unit_amount ?? 0, currency: price?.currency ?? subscription.currency };
  });
  const invoices = rawInvoices.map((invoice) => ({ ...invoice, amount_cents: invoice.amount_due,
    due_on: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().slice(0, 10) : null }));
  return { customers, products, prices, paymentIntents, charges, subscriptions, invoices };
}

async function oktaOverview(bindings) {
  const read = (path) => optionalProviderList(bindings.OKTA_BASE_URL, bindings.OKTA_TOKEN, path);
  const [users, groups, applications] = await Promise.all([
    read("/api/v1/users?per_page=100"), read("/api/v1/groups?per_page=100"), read("/api/v1/apps?per_page=100"),
  ]);
  return { users, groups, applications };
}

async function clerkOverview(bindings) {
  const read = (path) => optionalProviderList(bindings.CLERK_BASE_URL, bindings.CLERK_TOKEN, path);
  const [users, organizations, sessions] = await Promise.all([
    read("/v1/users?limit=200"), read("/v1/organizations?limit=100"), read("/v1/sessions?limit=100"),
  ]);
  return { users, organizations, sessions };
}

async function vercelOverview(bindings) {
  const read = (path, ...keys) => optionalProviderList(bindings.VERCEL_BASE_URL, bindings.VERCEL_TOKEN, path, ...keys);
  const teams = await read("/v2/teams?limit=100", "teams");
  const scopes = teams.length ? teams : [{ id: null }];
  const scoped = await Promise.all(scopes.map(async (team) => {
    const query = team.id ? `?teamId=${encodeURIComponent(team.id)}&limit=100` : "?limit=100";
    const [projects, deployments] = await Promise.all([
      read(`/v10/projects${query}`, "projects"), read(`/v6/deployments${query}`, "deployments"),
    ]);
    return { projects, deployments };
  }));
  const projects = scoped.flatMap((entry) => entry.projects);
  const deployments = scoped.flatMap((entry) => entry.deployments);
  return { projects, teams, deployments };
}

async function resendOverview(bindings) {
  const read = (path, ...keys) => optionalProviderList(bindings.RESEND_BASE_URL, bindings.RESEND_TOKEN, path, ...keys);
  const [emails, domains, audiences] = await Promise.all([
    read("/emails", "emails"), read("/domains", "domains"), read("/audiences", "audiences"),
  ]);
  const contactGroups = await Promise.all(audiences.map(async (audience) => ({
    audience,
    contacts: await read(`/audiences/${encodeURIComponent(audience.id)}/contacts`, "contacts"),
  })));
  return { emails, domains, audiences, contactGroups };
}

async function mongoAtlasOverview(bindings) {
  const read = (path, ...keys) => optionalProviderList(bindings.MONGOATLAS_BASE_URL, bindings.MONGOATLAS_TOKEN, path, ...keys);
  const projects = await read("/api/atlas/v2/groups", "results");
  const projectDetails = await Promise.all(projects.map(async (project) => {
    const id = project.id ?? project.groupId;
    const [clusters, databaseUsers] = await Promise.all([
      read(`/api/atlas/v2/groups/${encodeURIComponent(id)}/clusters`, "results"),
      read(`/api/atlas/v2/groups/${encodeURIComponent(id)}/databaseUsers`, "results"),
    ]);
    const databases = (await Promise.all(clusters.map(async (cluster) => {
      const rows = await read(`/api/atlas/v2/groups/${encodeURIComponent(id)}/clusters/${encodeURIComponent(cluster.name)}/databases`, "results", "databases");
      return rows.map((database) => ({ ...database, cluster: cluster.name }));
    }))).flat();
    return { project, clusters, databaseUsers, databases };
  }));
  return { projects, projectDetails };
}

export function publicTwilioProjection(twilio = {}) {
  return {
    account: twilio.account ? { sid: twilio.account.sid, friendly_name: twilio.account.friendly_name } : null,
    phone_numbers: twilio.phone_numbers ?? [], messaging_services: twilio.messaging_services ?? [],
    verify_services: (twilio.verify_services ?? []).map(({ code: _code, ...service }) => service),
  };
}

async function projectedProviderOverview(bindings, artifactPath) {
  const result = {};
  if (bindings.LINEAR_BASE_URL) result.linear = projection(artifactPath, "linear", {});
  if (bindings.TWILIO_BASE_URL) {
    const twilio = projection(artifactPath, "twilio", {});
    result.twilio = publicTwilioProjection(twilio);
  }
  if (bindings.MICROSOFT_BASE_URL) result.microsoft = projection(artifactPath, "microsoft", {});
  return result;
}

async function providerOverview(bindings, artifactPath, world, activity = [], browserBindings = bindings) {
  const requests = await Promise.allSettled([
    slackOverview(bindings, world),
    githubOverview(bindings, world),
    gmailOverview(bindings),
    inbox(bindings.IMAP_HOST_PORT, { login: bindings.IMAP_USERNAME, password: bindings.IMAP_PASSWORD, limit: 20 }),
    inbox(bindings.IMAP_HOST_PORT, { login: bindings.IMAP_USERNAME, password: bindings.IMAP_PASSWORD, mailbox: "Sent", limit: 20 }),
    s3Overview(bindings, artifactPath),
    notionOverview(bindings, artifactPath, browserBindings.NOTION_BASE_URL),
    fetch(`${bindings.SITE_BASE_URL}/`).then(async (response) => {
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP target returned ${response.status}`);
      return text;
    }),
    stripeOverview(bindings, world, activity),
    oktaOverview(bindings),
    clerkOverview(bindings),
    vercelOverview(bindings),
    resendOverview(bindings),
    mongoAtlasOverview(bindings),
  ]);
  const slack = safe(requests[0], { channels: [] });
  const github = safe(requests[1], { repositories: [], issues: [] });
  const gmail = safe(requests[2], { messages: [], resultSizeEstimate: 0 });
  const mailInbox = safe(requests[3], { mailbox: "INBOX", exists: 0, messages: [] });
  const mailSent = safe(requests[4], { mailbox: "Sent", exists: 0, messages: [] });
  const orderMail = (mailbox) => ({ ...mailbox, messages: [...(mailbox.messages ?? [])].sort((left, right) => right.seq - left.seq) });
  const mail = { ...orderMail(mailInbox), inbox: orderMail(mailInbox), sent: orderMail(mailSent) };
  const s3 = safe(requests[5], []);
  const notion = safe(requests[6], { users: [], pages: [], databases: [], dataSources: [], views: [], comments: [], fileUploads: [], agents: [], agentSessions: [], asyncTasks: [], changes: [],
    mcpUrl: bindings.NOTION_BASE_URL ? `${bindings.NOTION_BASE_URL}/mcp` : null, mcpSessions: [], mcpCalls: [], connections: [], connectionTokens: [], webhookSubscriptions: [], webhookDeliveries: [], liveWebhookDelivery: false, available: false });
  const projected = await projectedProviderOverview(bindings, artifactPath);
  return {
    slack: { channels: slack.channels ?? [], messageCount: slack.messageCount ?? 0 }, github, gmail, mail,
    s3: { details: s3 }, notion, website: { preview: safe(requests[7], "Unavailable").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) },
    stripe: safe(requests[8], { customers: [], products: [], prices: [], paymentIntents: [], charges: [], subscriptions: [], invoices: [] }),
    okta: safe(requests[9], { users: [], groups: [], applications: [] }),
    clerk: safe(requests[10], { users: [], organizations: [], sessions: [] }),
    vercel: safe(requests[11], { projects: [], teams: [], deployments: [] }),
    resend: safe(requests[12], { emails: [], domains: [], audiences: [], contactGroups: [] }),
    mongoatlas: safe(requests[13], { projects: [], projectDetails: [] }),
    ...projected,
    errors: requests.map((result, index) => result.status === "rejected"
      ? { provider: ["Slack", "GitHub", "Gmail", "Mail inbox", "Mail sent", "S3", "Notion", "Website", "Stripe", "Okta", "Clerk", "Vercel", "Resend", "MongoDB Atlas"][index], message: result.reason.message }
      : null).filter(Boolean),
  };
}

function readiness(instance) {
  return instance.lock.services.map((service) => {
    const result = instance.readiness.get(service.name);
    return { name: service.name, surface: service.name === "s3" ? "SeaweedFS S3" : service.name,
      kind: service.provides?.map((entry) => entry.profile).join(", "),
      state: instance.serviceStates.get(service.name) ?? "stopped", ready: Boolean(result?.ready), checks: result?.proven ?? 0 };
  });
}

const SURFACE_NAMES = { apple: "Apple", clerk: "Clerk", github: "GitHub", google: "Google", linear: "Linear",
  microsoft: "Microsoft Teams", mongoatlas: "MongoDB Atlas", notion: "Notion", okta: "Okta", resend: "Resend", slack: "Slack",
  stripe: "Stripe", twilio: "Twilio", vercel: "Vercel", mail: "Mail", s3: "Object storage", http: "HTTP targets" };

function surfaceReadiness(instance) {
  const surfaces = [];
  for (const service of instance.lock.services) {
    const state = instance.serviceStates.get(service.name) ?? "stopped";
    const result = instance.readiness.get(service.name);
    const live = result?.checks?.filter((check) => check.kind === "protocol") ?? [];
    if (service.name === "emulate") {
      for (const check of live) surfaces.push({ id: check.port, name: SURFACE_NAMES[check.port] ?? check.port,
        implementation: "emulate", version: "0.10.0", state: state === "running" && check.ok ? "ready" : state,
        service: service.name, checks: [check] });
      continue;
    }
    const id = service.name === "http-targets" ? "http" : service.name;
    const implementation = service.name === "mail" ? "Cyrus IMAP" : service.name === "s3" ? "SeaweedFS" : "WorldFixture";
    const version = service.name === "mail" ? "3.6.1" : service.name === "s3" ? "4.41" : service.version;
    surfaces.push({ id, name: SURFACE_NAMES[id] ?? service.name, implementation, version,
      state: state === "running" && live.every((check) => check.ok) ? "ready" : state, service: service.name, checks: live });
  }
  return surfaces;
}

async function probeApplicationSurfaces(instance) {
  const surfaces = surfaceReadiness(instance);
  return Promise.all(surfaces.map(async (surface) => {
    const started = performance.now();
    const results = await Promise.all(surface.checks.map((check) => probe(check, instance.addressOf(surface.service, check.port))));
    return { id: surface.id, name: surface.name, ready: results.length > 0 && results.every((result) => result.ok),
      latency_ms: Math.max(1, Math.round(performance.now() - started)), detail: results.map((result) => result.detail).join(" · ") };
  }));
}

function overlayTokens(artifactPath) {
  return projection(artifactPath, "emulator-overlay").tokens ?? {};
}

function personBindings(bindings, artifactPath, person) {
  const result = { ...bindings };
  const slack = resolveToken(artifactPath, { profile: "slack.workspace.v1", person: person.id });
  if (slack.scope === "person") result.SLACK_TOKEN = slack.value;
  return result;
}

function requireProviderIdentity(artifactPath, provider, person) {
  const tokens = overlayTokens(artifactPath);
  if (provider === "slack" && tokens[`slack_token_${person.id}`]) return;
  if (provider === "github" && tokens.github_token?.login === person.github_login) return;
  if (provider === "google" && tokens.demo_token?.login === person.email) return;
  throw new Error(`${person.name} has no ${provider} action credential in this world`);
}

function recordProviderEvent(instance, { type, source, actorId, evidence }) {
  const event = { id: `evt_${randomUUID().replaceAll("-", "").slice(0, 24)}`, type, actor_id: actorId,
    source, occurred_at: new Date().toISOString(), provider_evidence: evidence };
  appendEvent(instance.state, event);
  return event;
}

export function sanitizePublicBindings(bindings = {}) {
  return Object.fromEntries(Object.entries(bindings).filter(([name, value]) =>
    typeof value === "string"
    && /(?:_BASE_URL|_HOST_PORT|_USERNAME|_URL)$/i.test(name)
    && !/(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)/i.test(name)));
}

function publicBindings(stateDir, fallback) {
  try { return sanitizePublicBindings(JSON.parse(readFileSync(join(stateDir, "host-bindings.json"), "utf8"))); }
  catch { return sanitizePublicBindings(fallback); }
}

function connectorFile(stateDir) {
  return join(stateDir, "application-connector.json");
}

function connectorTarget(stateDir) {
  try { return JSON.parse(readFileSync(connectorFile(stateDir), "utf8")); }
  catch { return null; }
}

// In the product image, the Workbench server runs inside Docker while the
// target application usually runs on the host. Keep the URL a person entered
// for display and agent instructions, but use Docker's host address for calls.
function connectorTransportUrl(displayUrl) {
  const url = new URL(displayUrl);
  if (process.env.WORLDFIXTURE_SINGLE_CONTAINER === "1" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

// What the Workbench needs to offer a slice: the presets, and the collections
// this world actually has. The collection list comes from the artifact rather
// than a constant, so the control is right for whichever world is running
// instead of right for the one it was written against.
function scaleChoices(artifactPath) {
  try {
    const world = connectorWorld(artifactPath, { scale: "full" });
    return {
      presets: Object.entries(SCALE_PRESETS).map(([name, preset]) => ({ name, summary: preset.summary })),
      collections: world.scale.collections
        .filter((entry) => entry.total > 0)
        .map((entry) => ({ collection: entry.collection, total: entry.total })),
    };
  } catch {
    return null;
  }
}

async function connectorOverview(instance, stateDir, artifactPath) {
  const target = connectorTarget(stateDir);
  if (!target) return { state: "disconnected" };
  try {
    const discovery = await discoverConnector(target.transport_url);
    let status = null;
    if (discovery.capabilities.status) {
      status = await connectorStatus(target.transport_url, { token: instance.runtimeToken });
    }
    return {
      state: "connected",
      url: target.url,
      discovery,
      status,
      scales: scaleChoices(artifactPath),
      // The kinds this world has PRODUCED, not a list written into the UI.
      //
      // The event form offered four hard-coded kinds, and not one of the five
      // connectors built against this contract accepted any of them -- so the
      // product's headline demo was unreachable from the Workbench while the
      // world was emitting other kinds the whole time.
      kinds: observedKinds(latestEvents(instance.state, 500)),
    };
  } catch (error) {
    // Three different failures used to arrive as "Application is not reachable",
    // and only one of them was. A connector that answers discovery and then
    // refuses the token is running, reachable, and wrong about exactly one
    // thing, and telling its author to check whether their app is started sends
    // them to look at the one part that is working.
    const status = error.detail?.status;
    const state = status === 404 ? "missing" : (status === 401 || status === 403) ? "unauthorized" : "unreachable";
    return { state, url: target.url, error: error.message, prompt: connectorPrompt(target.url) };
  }
}

export function sanitizeNotionInspection(admin = {}) {
  const { webhook_verification_deliveries: _verificationDeliveries, ...publicAdmin } = admin;
  return {
    ...publicAdmin,
    webhook_subscriptions: (admin.webhook_subscriptions ?? []).map(({ verification_token: _secret, ...subscription }) => subscription),
    webhook_deliveries: (admin.webhook_deliveries ?? []).map(({ signature, headers = {}, ...delivery }) => {
      const publicHeaders = Object.fromEntries(Object.entries(headers)
        .filter(([name]) => name.toLowerCase() !== "x-notion-signature"));
      return {
        ...delivery,
        headers: publicHeaders,
        ...(signature ? { signature_fingerprint: `${signature.slice(0, 15)}…${signature.slice(-8)}` } : {}),
      };
    }),
  };
}

export function workbenchWebhookSecretRevealEnabled(value = process.env.WORLDFIXTURE_WORKBENCH_REVEAL_WEBHOOK_SECRETS) {
  return value === "1";
}

export function selectNotionWebhookReveal(admin = {}, { kind, id } = {}) {
  if (kind === "verification_token") {
    const subscription = (admin.webhook_subscriptions ?? []).find((entry) => entry.notion_id === id);
    if (!subscription?.verification_token) return null;
    return { kind, id, verification_token: subscription.verification_token };
  }
  if (kind === "delivery") {
    const delivery = [
      ...(admin.webhook_verification_deliveries ?? []),
      ...(admin.webhook_deliveries ?? []),
    ].find((entry) => entry.notion_id === id);
    if (!delivery) return null;
    return {
      kind,
      id,
      headers: delivery.headers ?? {},
      raw_body: delivery.raw_body,
      payload: delivery.payload,
    };
  }
  return null;
}


function personFor(world, id) {
  const person = world.people.find((entry) => entry.id === id);
  if (!person) throw new Error(`person ${JSON.stringify(id)} is not in this world`);
  return person;
}

async function slackHistory(bindings, channel) {
  const result = await providerJson(`${bindings.SLACK_BASE_URL}/api/conversations.history`, bindings.SLACK_TOKEN, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ channel, limit: "20" }),
  });
  const messages = [...(result.messages ?? [])].sort((left, right) => Number(right.ts) - Number(left.ts)).slice(0, 20);
  // The Chat screen reads `user_name`, which Slack does not send. Resolve it
  // here so the browser never has to hold a provider credential to learn who
  // wrote a message. A cached member list that has not seen an author is one
  // refresh behind a person who joined during the run, so miss once and re-read.
  let names = await slackUserNamesOrEmpty(bindings);
  if (messages.some((message) => message.user && !names.has(message.user))) {
    names = await slackUserNamesOrEmpty(bindings, { refresh: true });
  }
  return { ...result, messages: messages.map((message) => ({ ...message,
    user_name: message.user_name ?? names.get(message.user) })) };
}

async function sendGmail(bindings, input) {
  const replyHeaders = input.in_reply_to ? `In-Reply-To: ${input.in_reply_to}\r\nReferences: ${input.in_reply_to}\r\n` : "";
  const raw = Buffer.from(`To: ${input.to}\r\nSubject: ${input.subject}\r\n${replyHeaders}Content-Type: text/plain; charset=utf-8\r\n\r\n${input.text}\r\n`).toString("base64url");
  return providerJson(`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/send`, bindings.GOOGLE_TOKEN, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw, ...(input.thread_id ? { threadId: input.thread_id } : {}) }),
  });
}

function serveUi(url, response) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = normalize(join(UI_ROOT, requested));
  if (!path.startsWith(`${UI_ROOT}/`) && path !== join(UI_ROOT, "index.html")) return false;
  const file = existsSync(path) ? path : join(UI_ROOT, "index.html");
  if (!existsSync(file)) {
    response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    response.end("Workbench UI is not built. Run `npm run build` in runtime/workbench-ui.\n");
    return true;
  }
  const extension = file.slice(file.lastIndexOf("."));
  response.writeHead(200, { "content-type": MIME[extension] ?? "application/octet-stream", "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable" });
  response.end(readFileSync(file));
  return true;
}

export async function startWorkbench(instance, {
  artifactPath,
  stateDir,
  port = 0,
  host = "127.0.0.1",
  revealWebhookSecrets = workbenchWebhookSecretRevealEnabled(),
}) {
  const world = readWorld(artifactPath);
  const held = contents(world);
  const company = primaryOrganization(world);
  const acceptedProof = `${held.slack_messages} Slack messages and ${held.mail_messages} authored emails are present; the observed event ledger is empty.`;
  const allowWebhookSecretReveal = revealWebhookSecrets === true;
  const liveClients = new Set();
  let revision = 0;
  const notify = (kind = "refresh") => {
    revision += 1;
    const message = `event: ${kind}\ndata: ${JSON.stringify({ revision, at: new Date().toISOString() })}\n\n`;
    for (const client of liveClients) client.write(message);
  };

  // THE WORKBENCH HAS ITS OWN LOGIN.
  //
  // It used to read Slack with `bindings.SLACK_TOKEN`, which resolves to a named
  // person -- `slack_token_maya-chen`. Two things were wrong with that. It is a
  // modelling error: the inspector is not Maya, and the design says privileged
  // views use explicit inspection credentials. And it is a budget error: the
  // composer meters 5,000 requests per token per hour, so a background screen
  // refresh was spending a world person's allowance, and her own scheduled
  // messages were then refused with a rate limit.
  //
  // The workspace-shared token is a different token string, so it carries its
  // own counter. Person-scoped WRITES still use that person's own token: acting
  // as somebody is exactly what must not be done with a shared credential.
  const inspector = resolveToken(artifactPath, { profile: "slack.workspace.v1" });
  const asInspector = (bindings) => (inspector.value ? { ...bindings, SLACK_TOKEN: inspector.value } : bindings);

  // AND IT ASKS SLACK ONLY WHEN SOMETHING HAPPENED.
  //
  // This was a blind 1,500ms pulse that told every browser to re-fetch the
  // overview. One overview costs `conversations.list` plus one
  // `conversations.history` per channel: 4 requests for the small world and 29
  // for the large one -- about 70,000 an hour against a 5,000 budget, growing
  // with the world.
  //
  // The runtime event ledger already records every fact the runtime observed, so
  // it is the change signal. Reading its highest sequence is a local SQLite
  // query against a file in this container; it costs no provider request, and a
  // quiet world now produces no refreshes at all.
  const highestSeq = () => {
    try {
      return instance.state.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get().seq;
    } catch {
      return null;
    }
  };
  let lastSeq = highestSeq();
  const liveTimer = setInterval(() => {
    const seq = highestSeq();
    if (seq === null || seq === lastSeq) return;
    lastSeq = seq;
    notify("refresh");
  }, 1500);
  liveTimer.unref();

  // A comment line, not an event: it holds the connection open through a proxy
  // without asking any browser to re-read anything.
  const keepAlive = setInterval(() => {
    for (const client of liveClients) client.write(": keep-alive\n\n");
  }, 20_000);
  keepAlive.unref();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://worldfixture.local");
      const bindings = instance.applicationBindings ?? instance.bindings();
      if (request.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/readyz") {
        if (serveUi(url, response)) return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") return json(response, 200, { ready: true });
      if (request.method === "GET" && url.pathname === "/api/live") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.write(`event: ready\ndata: ${JSON.stringify({ revision, at: new Date().toISOString() })}\n\n`);
        liveClients.add(response);
        request.on("close", () => liveClients.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const browserBindings = publicBindings(stateDir, bindings);
        const providers = await providerOverview(asInspector(bindings), artifactPath, world, latestEvents(instance.state, 500), browserBindings);
        providers.notion.webhookSecretRevealEnabled = allowWebhookSecretReveal;
        const organizations = new Map(world.organizations.map((entry) => [entry.id, entry.name]));
        return json(response, 200, {
          world: { id: world.id, version: world.version, title: world.title, description: world.scenario?.title ?? company.summary,
            company: company.name, people: held.people, slackMessages: held.slack_messages, mailMessages: held.mail_messages },
          organizations: world.organizations.map(({ id, name, summary, domain }) => ({ id, name, summary, domain })),
          people: world.people.map(({ id, name, role, organization_id, email, slack_id, github_login }) => ({ id, name, role,
            organization_id, organization_name: organizations.get(organization_id), email, slack_id, github_login })),
          phase: instance.phase ?? "ready",
          bindings: browserBindings, providers, readiness: readiness(instance),
          surfaces: surfaceReadiness(instance).map(({ checks, ...surface }) => surface),
          activity: latestEvents(instance.state, 100).reverse(), acceptedProof,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/connector") {
        return json(response, 200, await connectorOverview(instance, stateDir, artifactPath));
      }
      if (request.method === "POST" && url.pathname === "/api/connector/connect") {
        const input = await body(request);
        let display;
        try {
          display = new URL(String(input.url));
          if (!["http:", "https:"].includes(display.protocol)) throw new Error("not HTTP");
        } catch {
          return json(response, 400, { error: "Enter an HTTP or HTTPS application URL." });
        }
        const target = {
          url: display.toString().replace(/\/$/, ""),
          transport_url: connectorTransportUrl(display),
        };
        writeFileSync(connectorFile(stateDir), `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
        return json(response, 200, await connectorOverview(instance, stateDir, artifactPath));
      }
      if (request.method === "POST" && url.pathname === "/api/connector/disconnect") {
        await body(request);
        rmSync(connectorFile(stateDir), { force: true });
        return json(response, 200, { state: "disconnected" });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/connector/")) {
        const action = url.pathname.split("/").at(-1);
        const input = await body(request);
        const target = connectorTarget(stateDir);
        if (!target) return json(response, 409, { error: "Connect an application first." });
        const options = { artifactPath, token: instance.runtimeToken };
        if (action === "prompt") return json(response, 200, { prompt: connectorPrompt(target.url) });

        // The browser asks for a slice by name; the runtime takes it. The
        // application never receives a scale it chose, and the browser never
        // receives the world it would have to slice itself.
        // Named `slice`, not `world`: this is the portion being sent, and calling
        // it `world` shadowed the instance's own world that `replay` resolves
        // channel and person names against.
        let slice = null;
        if (action === "plan" || action === "seed") {
          try {
            slice = connectorWorld(artifactPath, {
              scale: parseScale(input.scale),
              limits: typeof input.limits === "string" ? parseLimits(input.limits) : (input.limits ?? {}),
            });
          } catch (error) {
            if (error instanceof ScaleError) return json(response, 400, { error: error.message });
            throw error;
          }
        }

        if (action === "plan") {
          const result = await planConnector(target.transport_url, { ...options, world: slice });
          return json(response, 200, { ...result, scale: slice.scale, schema_errors: result.schema_errors ?? [] });
        }
        if (action === "seed") {
          const result = await seedConnector(target.transport_url, { ...options, world: slice, options: input.options });
          notify("connector-change");
          return json(response, 200, { ...result, scale: slice.scale, schema_errors: result.schema_errors ?? [] });
        }
        // Take something the world did and send it to the application. The
        // translation lives in `replay.mjs` so the Workbench and the CLI perform
        // the same operation rather than two similar ones.
        if (action === "replay") {
          const observed = latestEvents(instance.state, 500);
          let event;
          try {
            event = connectorEventFromWorldEvent(selectWorldEvent(observed, input.event), world);
          } catch (error) {
            return json(response, 400, { error: error.message });
          }
          const result = await deliverConnectorEvent(target.transport_url, event, options);
          notify("connector-change");
          return json(response, 200, { ...result, delivered: event, schema_errors: result.schema_errors ?? [] });
        }
        if (action === "event") {
          const result = await deliverConnectorEvent(target.transport_url, input, options);
          notify("connector-change");
          return json(response, 200, result);
        }
        if (action === "reset") {
          const result = await resetConnector(target.transport_url, options);
          notify("connector-change");
          return json(response, 200, result);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/probe") {
        await body(request);
        return json(response, 200, { surfaces: await probeApplicationSurfaces(instance) });
      }
      if (request.method === "GET" && url.pathname === "/api/provider/slack") {
        const channel = url.searchParams.get("channel");
        if (!channel) return json(response, 400, { error: "channel is required" });
        return json(response, 200, await slackHistory(asInspector(bindings), channel));
      }
      if (request.method === "GET" && url.pathname === "/api/inspect/events") {
        return json(response, 200, { events: eventsAfter(instance.state, Number(url.searchParams.get("after") ?? 0), 100) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/inspect/people/")) {
        const person = world.people.find((entry) => entry.id === decodeURIComponent(url.pathname.split("/").at(-1)));
        return person ? json(response, 200, person) : json(response, 404, { error: "person not found" });
      }
      if (request.method === "POST" && url.pathname === "/api/inspect/notion/webhook-value") {
        if (!allowWebhookSecretReveal) {
          return json(response, 403, { error: "webhook value reveal is disabled by WORLDFIXTURE_WORKBENCH_REVEAL_WEBHOOK_SECRETS" });
        }
        const input = await body(request);
        const inspection = await providerJson(`${bindings.NOTION_BASE_URL}/__worldfixture/notion-admin`, bindings.NOTION_TOKEN);
        const revealed = selectNotionWebhookReveal(inspection, input);
        if (!revealed) return json(response, 404, { error: "the selected webhook value is not available" });
        return json(response, 200, { ok: true, message: "The selected webhook value is visible until this page is refreshed.", result: revealed });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/slack") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        requireProviderIdentity(artifactPath, "slack", person);
        const personal = personBindings(bindings, artifactPath, person);
        const listed = await providerJson(`${personal.SLACK_BASE_URL}/api/conversations.list`, personal.SLACK_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "limit=100",
        });
        const providerChannel = listed.channels?.find((entry) => entry.id === input.channel);
        const channel = world.communication.channels.find((entry) => entry.name === providerChannel?.name);
        if (!channel) throw new Error("the selected Slack channel is not declared by this world");
        const result = await submit(instance.state,
          { baseUrl: personal.SLACK_BASE_URL, token: personal.SLACK_TOKEN, person, channel, text: String(input.text ?? "") },
          { world, rules: instance.lock.rules ?? [], bindings });
        const delivered = result.effects.reduce((total, effect) => total + (effect.delivered?.length ?? 0), 0);
        const consequence = delivered > 0
          ? `WorldFixture also delivered ${delivered} notification ${delivered === 1 ? "email" : "emails"} through SMTP.`
          : "No causal rule matched this message.";
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Slack accepted the message from ${result.identity.user}. ${consequence}`, event: result.event, effects: result.effects });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/gmail") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        requireProviderIdentity(artifactPath, "google", person);
        const result = await sendGmail(bindings, input);
        const event = recordProviderEvent(instance, { type: "mail.message.sent.v1", source: "google", actorId: person.id,
          evidence: { message_id: result.id, thread_id: result.threadId, to: input.to, subject: input.subject } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Gmail accepted message ${result.id}.`, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/mail") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const [local, domain] = person.email.split("@");
        const sentCopy = `${local}+Sent@${domain}`;
        const accepted = await sendMail(bindings.SMTP_HOST_PORT, { from: person.email, to: [input.to, sentCopy],
          subject: input.subject, body: input.text, headers: input.in_reply_to ? { "In-Reply-To": input.in_reply_to } : {} });
        const event = recordProviderEvent(instance, { type: "mail.message.sent.v1", source: "smtp", actorId: person.id,
          evidence: { accepted, from: person.email, to: input.to, subject: input.subject } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `SMTP accepted mail from ${person.email}. It is available through IMAP.`, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/github-issue") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        requireProviderIdentity(artifactPath, "github", person);
        const result = await providerJson(`${bindings.GITHUB_BASE_URL}/repos/${input.repository}/issues`, bindings.GITHUB_TOKEN, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: input.title, body: input.text }),
        });
        const event = recordProviderEvent(instance, { type: "github.issue.created.v1", source: "github", actorId: person.id,
          evidence: { repository: input.repository, issue_number: result.number, issue_id: result.id } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `GitHub accepted issue #${result.number}.`, event, issue: result });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/s3") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const acceptedBuckets = new Set((projection(artifactPath, "aws").s3?.buckets ?? []).map((entry) => entry.name));
        if (!acceptedBuckets.has(input.bucket)) throw new Error("the selected S3 bucket is not declared by this world");
        const target = `${bindings.S3_BASE_URL}/${encodeURIComponent(input.bucket)}/${String(input.key).split("/").map(encodeURIComponent).join("/")}`;
        const result = await fetch(target, { method: "PUT", headers: { "content-type": "text/plain; charset=utf-8" }, body: input.text });
        if (!result.ok) throw new Error(`S3 refused PutObject with ${result.status}: ${(await result.text()).slice(0, 180)}`);
        const event = recordProviderEvent(instance, { type: "object.created.v1", source: "s3", actorId: person.id,
          evidence: { bucket: input.bucket, key: input.key, etag: result.headers.get("etag") } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `SeaweedFS accepted s3://${input.bucket}/${input.key}.`, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-create-invoice") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const amount = Number(input.amount_cents);
        if (!Number.isInteger(amount) || amount < 50) return json(response, 400, { error: "Enter an amount of at least 50 cents." });
        const dueOn = String(input.due_on ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return json(response, 400, { error: "Enter a valid due date." });
        const description = String(input.description ?? "Service invoice").trim() || "Service invoice";
        const form = { customer: String(input.customer_id), description, collection_method: "send_invoice",
          due_date: String(Math.floor(new Date(`${dueOn}T00:00:00Z`).getTime() / 1000)) };
        const draft = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoices`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form),
        });
        await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoiceitems`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ customer: String(input.customer_id), invoice: draft.id, amount: String(amount),
            currency: String(input.currency ?? "usd").toLowerCase(), description }),
        });
        const invoice = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoices/${encodeURIComponent(draft.id)}/finalize`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
        });
        const event = recordProviderEvent(instance, { type: "stripe.invoice.created.v1", source: "stripe", actorId: person.id,
          evidence: { invoice_id: invoice.id, customer_id: invoice.customer, amount_cents: invoice.amount_due } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Stripe created invoice ${invoice.number}.`, invoice, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-pay-invoice") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const invoice = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoices/${encodeURIComponent(input.invoice_id)}/pay`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payment_method: "pm_card_visa" }),
        });
        const event = recordProviderEvent(instance, { type: "stripe.invoice.paid.v1", source: "stripe", actorId: person.id,
          evidence: { invoice_id: invoice.id, customer_id: invoice.customer, amount_cents: invoice.amount_paid } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Stripe paid invoice ${invoice.number}.`, invoice, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-payment") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const amount = Number(input.amount_cents);
        if (!Number.isInteger(amount) || amount < 50) return json(response, 400, { error: "Enter an amount of at least 50 cents." });
        const created = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/payment_intents`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ amount: String(amount), currency: String(input.currency ?? "usd"),
            customer: String(input.customer_id ?? ""), description: String(input.description ?? "Workbench payment"), payment_method: "pm_card_visa" }),
        });
        const payment = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/payment_intents/${encodeURIComponent(created.id)}/confirm`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payment_method: "pm_card_visa" }),
        });
        const event = recordProviderEvent(instance, { type: "stripe.payment.succeeded.v1", source: "stripe", actorId: person.id,
          evidence: { payment_intent_id: payment.id, customer_id: input.customer_id, invoice_id: input.invoice_id, amount_cents: amount, currency: payment.currency } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Stripe accepted ${payment.id}.`, payment, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-cancel-payment") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const payment = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/payment_intents/${encodeURIComponent(input.payment_intent_id)}/cancel`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
        });
        const event = recordProviderEvent(instance, { type: "stripe.payment.canceled.v1", source: "stripe", actorId: person.id,
          evidence: { payment_intent_id: payment.id } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Stripe canceled ${payment.id}.`, payment, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-cancel-subscription") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const subscription = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/subscriptions/${encodeURIComponent(input.subscription_id)}`, bindings.STRIPE_TOKEN, {
          method: "DELETE", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
        });
        const event = recordProviderEvent(instance, { type: "stripe.subscription.canceled.v1", source: "stripe", actorId: person.id,
          evidence: { subscription_id: subscription.id, customer_id: subscription.customer } });
        notify("provider-change");
        return json(response, 200, { ok: true, message: `Stripe canceled subscription ${subscription.id}.`, subscription, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/notion-admin") {
        const input = await body(request);
        const routes = {
          create_webhook: { path: "/__worldfixture/notion-admin/webhooks", method: "POST", payload: { url: input.url, event_types: input.event_types } },
          verify_webhook: { path: `/__worldfixture/notion-admin/webhooks/${encodeURIComponent(input.id)}/verify`, method: "POST" },
          delete_webhook: { path: `/__worldfixture/notion-admin/webhooks/${encodeURIComponent(input.id)}`, method: "DELETE" },
          revoke_tokens: { path: "/__worldfixture/notion-admin/tokens/revoke", method: "POST", payload: { client_id: input.client_id, user_id: input.user_id } },
          update_agent_status: { path: `/v1/agents/${encodeURIComponent(input.agent_id)}/status`, method: "PATCH", payload: { status: input.status }, currentApi: true },
          update_agent_credit: { path: `/v1/agents/${encodeURIComponent(input.agent_id)}/credit_limit`, method: "PATCH", payload: { credit_limit: input.credit_limit === "" || input.credit_limit === null ? null : Number(input.credit_limit) }, currentApi: true },
          create_admin_group: { path: `/admin/v1/spaces/${encodeURIComponent(input.space_id)}/groups`, method: "POST", payload: { name: input.name }, enterpriseAdmin: true },
          revoke_admin_pat: { path: `/admin/v1/spaces/${encodeURIComponent(input.space_id)}/personal_access_tokens/${encodeURIComponent(input.bot_id)}`, method: "DELETE", enterpriseAdmin: true },
          revoke_admin_mcp: { path: "/admin/v1/mcp_client_connections/revoke", method: "POST", payload: { client_key: input.client_key, user_id: input.user_id, workspace_id: input.space_id }, enterpriseAdmin: true },
        };
        const selected = routes[input.operation];
        if (!selected) throw new Error("unsupported Notion administration operation");
        const targetBase = selected.enterpriseAdmin ? bindings.NOTION_ADMIN_BASE_URL ?? bindings.NOTION_BASE_URL : bindings.NOTION_BASE_URL;
        const targetToken = selected.enterpriseAdmin ? bindings.NOTION_ADMIN_TOKEN : bindings.NOTION_TOKEN;
        let payload = selected.payload;
        if (input.operation === "verify_webhook") {
          const inspection = await providerJson(`${bindings.NOTION_BASE_URL}/__worldfixture/notion-admin`, bindings.NOTION_TOKEN);
          const subscription = inspection.webhook_subscriptions?.find((entry) => entry.notion_id === input.id);
          if (!subscription?.verification_token) throw new Error("the pending webhook verification token is not available");
          payload = { verification_token: subscription.verification_token };
        }
        const result = await providerJson(`${targetBase}${selected.path}`, targetToken, {
          method: selected.method, headers: { "content-type": "application/json", ...(selected.currentApi ? { "Notion-Version": "2026-03-11" } : {}), ...(selected.enterpriseAdmin ? { "Notion-Version": "2026-06-01" } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        notify("provider-change");
        const publicResult = input.operation === "create_webhook"
          ? (({ verification_token: _secret, ...value }) => value)(result)
          : result;
        return json(response, 200, { ok: true, message: `Notion ${input.operation.replaceAll("_", " ")} completed.`, result: publicResult });
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        await body(request);
        notify("reset-started");
        await instance.reset();
        notify("reset-completed");
        return json(response, 200, { ok: true, acceptedProof });
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, 500, { error: error.message, request_id: randomUUID() });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => {
    clearInterval(liveTimer);
    clearInterval(keepAlive);
    for (const client of liveClients) client.end();
    server.close(resolve);
  }) };
}
