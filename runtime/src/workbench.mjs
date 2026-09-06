import { randomUUID } from "node:crypto";
import { s3Fetch } from "./s3-signing.mjs";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { collectionState, combineReads, notionPage, readPages, readRecords } from "./workbench-collection-reads.mjs";
import { readOktaOverview, readClerkOverview, readVercelOverview, readResendOverview, readMongoAtlasOverview, readTwilioOverview } from "./workbench-product-data.mjs";
import { readLinearOverview, readStripeOverview } from "./workbench-provider-data.mjs";
import { domainCollectionPath, readDomainOverview, validateDomainPage, validateDomainWorld } from "./workbench-domain-data.mjs";
import { resolveToken, resolveTokenReference } from "./bindings.mjs";
import { submit } from "./commands.mjs";
import { executeDomainOperation } from "./domain-operations.mjs";
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
const DOCS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../docs-site");
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
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), ...options, headers });
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

async function s3Overview(bindings) {
  const read = async path => {
    const response = await s3Fetch(`${bindings.S3_BASE_URL.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(30000) }, bindings);
    const xml = await response.text();
    if (!response.ok) throw new Error(`S3 returned ${response.status}`);
    return xml;
  };
  const listing = await read("/");
  if (!listing.includes("ListAllMyBucketsResult")) throw new Error("S3 returned an invalid bucket list");
  const names = [...listing.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)].map(match => xmlValue(match[1], "Name"));
  return Promise.all(names.map(async name => {
    const objects = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ "list-type": "2", ...(cursor ? { "continuation-token": cursor } : {}) });
      const xml = await read(`/${encodeURIComponent(name)}/?${query}`);
      if (!xml.includes("ListBucketResult")) throw new Error(`S3 returned an invalid object list for ${name}`);
      objects.push(...s3Objects(xml));
      if (xmlValue(xml, "IsTruncated") === "false") return { name, objects };
      const next = xmlValue(xml, "NextContinuationToken");
      if (!next || cursors.has(next)) throw new Error(`S3 returned an invalid continuation token for ${name}`);
      cursors.add(next); cursor = next;
    }
    throw new Error(`S3 object pagination exceeded its limit for ${name}`);
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
      .then(gmailHeaders)));
  return { messages: newestFirst(messages, (message) => Number(message.internalDate) || Date.parse(message.date) || 0),
    resultSizeEstimate: list.resultSizeEstimate ?? messages.length };
}

async function gmailOverview(bindings) {
  const [inboxFolder, sentFolder] = await Promise.all([gmailFolder(bindings, "INBOX"), gmailFolder(bindings, "SENT")]);
  return { inbox: inboxFolder, sent: sentFolder, messages: inboxFolder.messages,
    resultSizeEstimate: inboxFolder.resultSizeEstimate + sentFolder.resultSizeEstimate };
}

export async function githubOverview(bindings, world) {
  const read = path => providerJson(`${bindings.GITHUB_BASE_URL}${path}`, bindings.GITHUB_TOKEN);
  const list = path => readPages(async (page = 1) => {
    const rows = await read(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    return { rows, next: Array.isArray(rows) && rows.length === 100 ? page + 1 : null };
  }, { initial: 1 });
  const visible = await list("/user/repos?type=all");
  // The local API has no organization repository list. Declared names select
  // public detail reads; they never provide records or measured counts.
  const organizations = new Map((world.organizations ?? []).map(entry => [entry.id, entry.slug ?? entry.id]));
  const names = new Set(visible.rows.map(repository => repository.full_name));
  const declared = (world.software?.repositories ?? []).map(repository => ({
    full_name: `${organizations.get(repository.owner_id) ?? repository.owner_id}/${repository.name}`,
  })).filter(repository => !names.has(repository.full_name));
  const details = await readRecords(declared, repository => read(`/repos/${repository.full_name.split("/").map(encodeURIComponent).join("/")}`));
  const repositories = combineReads([visible, details]);
  const issueLists = await Promise.all(repositories.rows.map(repository =>
    list(`/repos/${repository.full_name.split("/").map(encodeURIComponent).join("/")}/issues?state=open`)));
  const issues = combineReads(issueLists, [repositories]);
  return { repositories: repositories.rows, issues: issues.rows.filter(issue => !issue.pull_request),
    collectionStatus: { repositories: { ...collectionState(repositories), scope: "Authenticated repositories and declared organization repositories" },
      issues: { ...collectionState(issues), scope: "Open issues in the returned repositories" } } };
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
const slackNameScopes = new WeakMap();

async function slackUserNames(bindings, { refresh = false } = {}) {
  const key = JSON.stringify([bindings.SLACK_BASE_URL, slackNameScopes.get(bindings) ?? "unmanaged"]);
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

// An explicit empty provider topic means the live topic was cleared. Use the
// source label only when the API omits the topic value entirely.
export function slackChannelTopic(channel = {}, declared) {
  return channel.topic?.value ?? declared?.topic;
}

export async function slackOverview(bindings, world) {
  const list = (method, key, input = {}) => readPages(async cursor => {
    const value = await providerJson(`${bindings.SLACK_BASE_URL}/api/${method}`, bindings.SLACK_TOKEN, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ limit: "100", ...input, ...(cursor ? { cursor } : {}) }),
    });
    const next = value.response_metadata?.next_cursor;
    if (typeof next !== "string" || (value.has_more === true && !next)) throw new Error(`${method} has incomplete pagination metadata`);
    return { rows: value[key], next };
  });
  const listed = await list("conversations.list", "channels", { types: "public_channel,private_channel,mpim,im" });
  const histories = await Promise.all(listed.rows.map(channel => list("conversations.history", "messages", { channel: channel.id })));
  const worldChannels = new Map((world.communication?.channels ?? []).map(channel => [channel.name, channel]));
  const people = await slackUserNamesOrEmpty(bindings);
  const channels = listed.rows.map((channel, index) => ({
    ...channel,
    messageCount: histories[index].status === "complete" ? histories[index].rows.length : null,
    historyStatus: collectionState(histories[index]),
    latestTs: Math.max(0, ...histories[index].rows.map(message => Number(message.ts) || Date.parse(message.timestamp) / 1000 || 0)),
    displayName: channel.is_im ? people.get(channel.user) : channel.name,
    topic: slackChannelTopic(channel, worldChannels.get(channel.name)),
  }));
  const messages = combineReads(histories, [listed]);
  return { channels, messageCount: messages.status === "complete" ? messages.rows.length : null,
    collectionStatus: { channels: collectionState(listed), messageCount: collectionState(messages) } };
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

export async function notionOverview(bindings, artifactPath, publicBaseUrl = bindings.NOTION_BASE_URL) {
  const headers = { "Notion-Version": "2026-03-11", "content-type": "application/json" };
  const configured = projection(artifactPath, "emulator-overlay").notion ?? projection(artifactPath, "notion", {});
  const collectionStatus = {};
  const remember = (name, result) => { collectionStatus[name] = collectionState(result); return result.rows; };
  const list = (path, { input, key = "results", admin = false, cursorOnly = false } = {}) => readPages(async cursor => {
    const base = admin ? bindings.NOTION_ADMIN_BASE_URL ?? bindings.NOTION_BASE_URL : bindings.NOTION_BASE_URL;
    const token = admin ? bindings.NOTION_ADMIN_TOKEN : bindings.NOTION_TOKEN;
    const requestHeaders = admin ? { ...headers, "Notion-Version": "2026-06-01" } : headers;
    const query = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const value = await providerJson(`${base}${path}${input ? "" : `${path.includes("?") ? "&" : "?"}${query}`}`, token,
      input ? { method: "POST", headers: requestHeaders, body: JSON.stringify({ ...input, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) }
        : { headers: requestHeaders });
    return notionPage(value, key, { cursorOnly });
  });
  const detail = (path, inputs) => readRecords(inputs, input =>
    providerJson(`${bindings.NOTION_BASE_URL}${path}/${encodeURIComponent(input.id)}`, bindings.NOTION_TOKEN, { headers }));
  const [users, search, uploads, agents, sessions] = await Promise.all([
    list("/v1/users"), list("/v1/search", { input: {} }), list("/v1/file_uploads"),
    list("/v1/agents/query", { input: { include_deleted: true, verbose: true } }),
    list("/v1/sessions/query", { input: { sorts: [{ property: "updated_at", direction: "descending" }] } }),
  ]);
  const pages = remember("pages", { ...search, rows: search.rows.filter(entry => entry.object === "page") });
  const comments = combineReads(await Promise.all(pages.map(page => list(`/v1/comments?block_id=${encodeURIComponent(page.id)}`))), [search]);
  // Data sources are discoverable through search. Databases have no list route;
  // their declared IDs and API parent references select actual detail reads.
  const sourceInputs = search.rows.filter(entry => entry.object === "data_source");
  const sources = combineReads([await detail("/v1/data_sources", sourceInputs)], [search]);
  const databaseInputs = [...new Map([...(configured.databases ?? []), ...sources.rows.map(source => ({ id: source.parent?.database_id })).filter(entry => entry.id)]
    .map(entry => [entry.id, entry])).values()];
  const databases = combineReads([await detail("/v1/databases", databaseInputs)], [sources]);
  const viewLists = combineReads(await Promise.all(databases.rows.map(database => list(`/v1/views?database_id=${encodeURIComponent(database.id)}`))), [databases]);
  const viewInputs = [...new Map(viewLists.rows.map(entry => [entry.id, entry])).values()];
  const views = combineReads([await detail("/v1/views", viewInputs)], [viewLists]);
  // These inspection endpoints return full snapshots, with no paging contract.
  // Validate each array separately so malformed/failed snapshots cannot be zero.
  const snapshot = async (path, fields, sanitize = value => value) => {
    let raw, value, error;
    try {
      raw = await providerJson(`${bindings.NOTION_BASE_URL}${path}`, bindings.NOTION_TOKEN);
      value = sanitize({ ...raw, ...Object.fromEntries(Object.values(fields).map(field => [field, Array.isArray(raw[field]) ? raw[field] : []])) });
    }
    catch (failure) { error = failure.message; }
    return Object.fromEntries(Object.entries(fields).map(([name, field]) => {
      const rows = Array.isArray(raw?.[field]) ? value?.[field] : undefined;
      collectionStatus[name] = Array.isArray(rows) ? { status: "complete" } : { status: "failed", error: error ?? `${path} has no ${field} array` };
      return [name, Array.isArray(rows) ? rows : []];
    }).concat([["liveWebhookDelivery", Boolean(value?.live_webhook_delivery)]]));
  };
  const [mcp, admin] = await Promise.all([
    snapshot("/__worldfixture/mcp-observability", { asyncTasks: "asyncTasks", changes: "changes", mcpSessions: "sessions", mcpCalls: "calls" }),
    snapshot("/__worldfixture/notion-admin", { connections: "connections", connectionTokens: "tokens", webhookSubscriptions: "webhook_subscriptions", webhookDeliveries: "webhook_deliveries" }, sanitizeNotionInspection),
  ]);
  const spaceId = configured.workspace?.id;
  const adminPaths = { legalHolds: "/admin/v1/legal_holds", groups: `/admin/v1/spaces/${encodeURIComponent(spaceId)}/groups`,
    adminAgents: `/admin/v1/spaces/${encodeURIComponent(spaceId)}/agents`, personalAccessTokens: `/admin/v1/spaces/${encodeURIComponent(spaceId)}/personal_access_tokens`,
    mcpClientConnections: `/admin/v1/mcp_client_connections?workspace_id=${encodeURIComponent(spaceId)}` };
  const enterprise = Object.fromEntries(await Promise.all(Object.entries(adminPaths).map(async ([name, path]) => {
    const value = !bindings.NOTION_ADMIN_TOKEN || !spaceId ? { rows: [], status: "unavailable", error: "Notion admin credential or workspace ID is unavailable" }
      : await list(path, { admin: true, ...(name === "legalHolds" ? { key: "legal_holds", cursorOnly: true } : {}) });
    return [name, remember(name, value)];
  })));
  return { users: remember("users", users), pages: pages.map(page => ({ ...page, url: providerBrowserUrl(page.url, publicBaseUrl) })),
    databases: remember("databases", databases), dataSources: remember("dataSources", sources), views: remember("views", views),
    comments: remember("comments", comments), fileUploads: remember("fileUploads", uploads), agents: remember("agents", agents), agentSessions: remember("agentSessions", sessions),
    ...mcp, ...admin, ...enterprise, mcpUrl: `${publicBaseUrl}/mcp`, spaceId, collectionStatus };
}

export async function stripeOverview(bindings) {
  const result = await readStripeOverview(path => providerJson(`${bindings.STRIPE_BASE_URL}${path}`, bindings.STRIPE_TOKEN));
  result.subscriptions = result.subscriptions.map(subscription => {
    const customerId = typeof subscription.customer === "object" ? subscription.customer?.id : subscription.customer;
    const customer = result.customers.find(entry => entry.id === customerId);
    const price = subscription.items?.data?.[0]?.price;
    const product = result.products.find(entry => entry.id === price?.product);
    return { ...subscription, customer_id: customerId, customer: customer?.name ?? customerId,
      product: product?.name ?? price?.product ?? null, amount_cents: price?.unit_amount ?? null,
      currency: price?.currency ?? subscription.currency };
  });
  result.invoices = result.invoices.map(invoice => ({ ...invoice, amount_cents: invoice.amount_due,
    due_on: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString().slice(0, 10) : null }));
  return result;
}

const productReader = (bindings, provider) => path => providerJson(`${bindings[`${provider}_BASE_URL`]}${path}`, bindings[`${provider}_TOKEN`]);
const oktaOverview = bindings => readOktaOverview(productReader(bindings, "OKTA"));
const clerkOverview = bindings => readClerkOverview(productReader(bindings, "CLERK"));
const vercelOverview = bindings => readVercelOverview(productReader(bindings, "VERCEL"));
const resendOverview = bindings => readResendOverview(productReader(bindings, "RESEND"));
const mongoAtlasOverview = bindings => readMongoAtlasOverview(productReader(bindings, "MONGOATLAS"));

export async function linearOverview(bindings) {
  return readLinearOverview(query => providerJson(`${bindings.LINEAR_BASE_URL}/graphql`, bindings.LINEAR_TOKEN, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  }));
}

export async function twilioOverview(bindings) {
  const sid = bindings.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${bindings.TWILIO_AUTH_TOKEN}`).toString("base64");
  return readTwilioOverview(path => providerJson(`${bindings.TWILIO_BASE_URL}${path}`, null, {
    headers: { authorization: `Basic ${auth}` },
  }), { accountSid: sid });
}

function httpTargetLinks(artifactPath, baseUrl) {
  if (!baseUrl) return [];
  const configured = projection(artifactPath, "http-targets", {});
  if (configured.api_version !== "worldfixture.http-targets/v1") return [];
  return [
    ...(configured.feeds ?? []).map((entry) => ({ kind: entry.kind ?? "RSS", name: entry.title ?? entry.path, path: entry.path })),
    ...(configured.pages ?? []).map((entry) => ({
      kind: entry.kind ?? (Array.isArray(entry.request_variants) && entry.request_variants.length ? "Changing page" : "Page"),
      name: entry.title ?? entry.heading ?? entry.path, path: entry.path,
    })),
    ...(configured.probes ?? []).map((entry) => ({ kind: entry.kind ?? `${entry.mode ?? "probe"} probe`, name: entry.name ?? entry.path, path: entry.path })),
    ...(configured.api?.openapi_path ? [{ kind: "OpenAPI", name: "OpenAPI document", path: configured.api.openapi_path }] : []),
    ...Object.keys(configured.api?.responses ?? {}).map((path) => ({ kind: "JSON API", name: path, path })),
    { kind: "Metrics", name: "Prometheus metrics", path: "/metrics" },
  ].map((entry) => ({ ...entry, url: `${baseUrl.replace(/\/$/, "")}${entry.path}` }));
}

export async function providerOverview(bindings, artifactPath, world, browserBindings = bindings) {
  const selected = (value, task, fallback) => value ? task() : Promise.resolve(fallback);
  const httpTargets = httpTargetLinks(artifactPath, browserBindings.SITE_BASE_URL);
  const pagePaths = new Set((projection(artifactPath, "http-targets").pages ?? []).map(page => page.path));
  const previewTarget = httpTargets.find(target => pagePaths.has(target.path)) ?? httpTargets[0];
  const emptyNotion = { users: [], pages: [], databases: [], dataSources: [], views: [], comments: [], fileUploads: [], agents: [], agentSessions: [], asyncTasks: [], changes: [],
    mcpUrl: browserBindings.NOTION_BASE_URL ? `${browserBindings.NOTION_BASE_URL}/mcp` : null, mcpSessions: [], mcpCalls: [], connections: [], connectionTokens: [], webhookSubscriptions: [], webhookDeliveries: [], liveWebhookDelivery: false, available: false };
  const requests = await Promise.allSettled([
    selected(bindings.SLACK_BASE_URL, () => slackOverview(bindings, world), { channels: [] }),
    selected(bindings.GITHUB_BASE_URL, () => githubOverview(bindings, world), { repositories: [], issues: [] }),
    selected(bindings.GOOGLE_BASE_URL, () => gmailOverview(bindings), { messages: [], resultSizeEstimate: 0 }),
    selected(bindings.IMAP_HOST_PORT, () => inbox(bindings.IMAP_HOST_PORT, { login: bindings.IMAP_USERNAME, password: bindings.IMAP_PASSWORD, limit: 20 }), { mailbox: "INBOX", exists: 0, messages: [] }),
    selected(bindings.IMAP_HOST_PORT, () => inbox(bindings.IMAP_HOST_PORT, { login: bindings.IMAP_USERNAME, password: bindings.IMAP_PASSWORD, mailbox: "Sent", limit: 20 }), { mailbox: "Sent", exists: 0, messages: [] }),
    selected(bindings.S3_BASE_URL, () => s3Overview(bindings), []),
    selected(bindings.NOTION_BASE_URL, () => notionOverview(bindings, artifactPath, browserBindings.NOTION_BASE_URL), emptyNotion),
    selected(bindings.SITE_BASE_URL, async () => {
      if (!previewTarget) throw new Error("No declared HTTP target is available for a preview");
      const response = await fetch(`${bindings.SITE_BASE_URL.replace(/\/$/, "")}${previewTarget.path}`, { signal: AbortSignal.timeout(30000), redirect: "manual" });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP target ${previewTarget.path} returned ${response.status}`);
      return text;
    }, "Unavailable"),
    selected(bindings.STRIPE_BASE_URL, () => stripeOverview(bindings), {}),
    selected(bindings.OKTA_BASE_URL, () => oktaOverview(bindings), {}),
    selected(bindings.CLERK_BASE_URL, () => clerkOverview(bindings), {}),
    selected(bindings.VERCEL_BASE_URL, () => vercelOverview(bindings), {}),
    selected(bindings.RESEND_BASE_URL, () => resendOverview(bindings), {}),
    selected(bindings.MONGOATLAS_BASE_URL, () => mongoAtlasOverview(bindings), {}),
    selected(bindings.LINEAR_BASE_URL, () => linearOverview(bindings), {}),
    selected(bindings.TWILIO_BASE_URL, () => twilioOverview(bindings), {}),
    selected(bindings.DOMAIN_BASE_URL, () => readDomainOverview(productReader(bindings, "DOMAIN")), { collections: [] }),
  ]);
  const slack = safe(requests[0], { channels: [] });
  const github = safe(requests[1], { repositories: [], issues: [] });
  const gmail = safe(requests[2], { messages: [], resultSizeEstimate: 0 });
  const mailInbox = safe(requests[3], { mailbox: "INBOX", exists: 0, messages: [] });
  const mailSent = safe(requests[4], { mailbox: "Sent", exists: 0, messages: [] });
  const orderMail = (mailbox) => ({ ...mailbox, messages: [...(mailbox.messages ?? [])].sort((left, right) => right.seq - left.seq) });
  const mail = { ...orderMail(mailInbox), inbox: orderMail(mailInbox), sent: orderMail(mailSent) };
  const s3 = safe(requests[5], []);
  const notion = safe(requests[6], emptyNotion);
  const result = {
    slack: { ...slack, channels: slack.channels ?? [], messageCount: slack.messageCount ?? (bindings.SLACK_BASE_URL ? null : 0) }, github, gmail, mail,
    s3: { details: s3 }, notion, website: { preview: safe(requests[7], "Unavailable").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
      previewPath: previewTarget?.path ?? null, previewUrl: previewTarget?.url ?? null, targets: httpTargets },
    stripe: safe(requests[8], { customers: [], products: [], prices: [], paymentIntents: [], charges: [], subscriptions: [], invoices: [] }),
    okta: safe(requests[9], { users: [], groups: [], applications: [] }),
    clerk: safe(requests[10], { users: [], organizations: [], sessions: [] }),
    vercel: safe(requests[11], { projects: [], teams: [], deployments: [] }),
    resend: safe(requests[12], { emails: [], domains: [], audiences: [], contactGroups: [] }),
    mongoatlas: safe(requests[13], { projects: [], projectDetails: [] }),
    linear: safe(requests[14], { organization: null, teams: [], issues: [] }),
    twilio: safe(requests[15], { account: null, phone_numbers: [], messaging_services: [], verify_services: [] }),
    domain: safe(requests[16], { collections: [] }),
    errors: [],
  };
  const sources = [
    ["slack", [0], bindings.SLACK_BASE_URL], ["github", [1], bindings.GITHUB_BASE_URL], ["gmail", [2], bindings.GOOGLE_BASE_URL],
    ["mail", [3, 4], bindings.IMAP_HOST_PORT], ["s3", [5], bindings.S3_BASE_URL], ["notion", [6], bindings.NOTION_BASE_URL],
    ["website", [7], bindings.SITE_BASE_URL], ["stripe", [8], bindings.STRIPE_BASE_URL], ["okta", [9], bindings.OKTA_BASE_URL],
    ["clerk", [10], bindings.CLERK_BASE_URL], ["vercel", [11], bindings.VERCEL_BASE_URL], ["resend", [12], bindings.RESEND_BASE_URL],
    ["mongoatlas", [13], bindings.MONGOATLAS_BASE_URL], ["linear", [14], bindings.LINEAR_BASE_URL], ["twilio", [15], bindings.TWILIO_BASE_URL],
    ["domain", [16], bindings.DOMAIN_BASE_URL],
  ];
  for (const [provider, indices, selected] of sources) {
    const failures = indices.flatMap(index => requests[index].status === "rejected" ? [requests[index].reason.message] : []);
    failures.push(...Object.entries(result[provider].collectionStatus ?? {}).flatMap(([name, value]) =>
      value.status !== "complete" ? [`${name}: ${value.error ?? value.status}`] : []));
    const hasCompleteCollection = Object.values(result[provider].collectionStatus ?? {}).some(value => value.status === "complete");
    const status = !selected ? "not-selected" : failures.length ? hasCompleteCollection ? "partial" : "error" : "ready";
    Object.assign(result[provider], { status, available: status === "ready" || status === "partial", error: failures.length ? failures.join("; ") : null });
    result.errors.push(...failures.map(message => ({ provider, message })));
  }
  return result;
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
  microsoft: "Microsoft Entra", mongoatlas: "MongoDB Atlas", notion: "Notion", okta: "Okta", resend: "Resend", slack: "Slack",
  stripe: "Stripe", twilio: "Twilio", vercel: "Vercel", mail: "Local Mail", s3: "Object storage", http: "HTTP targets", domain: "World records" };

export function surfaceReadiness(instance) {
  const surfaces = [];
  for (const service of instance.lock.services) {
    const state = instance.serviceStates.get(service.name) ?? "stopped";
    const result = instance.readiness.get(service.name);
    const live = result?.checks?.filter(check => check.kind === "protocol") ?? [];
    const capabilities = Object.entries(instance.lock.capabilities ?? {}).filter(([, value]) => value.service === service.name);
    const ports = service.name === "emulate" ? [...new Set(capabilities.map(([, value]) => value.port))] : [null];
    // Older locks still declare every protocol in service.readiness.
    if (service.name === "emulate" && !ports.length) ports.push(...new Set((service.readiness ?? live).filter(check => check.kind === "protocol").map(check => check.port)));
    for (const port of ports) {
      const id = port ?? (service.name === "http-targets" ? "http" : service.name);
      const profiles = capabilities.filter(([, value]) => !port || value.port === port).map(([profile]) => profile);
      const checks = (service.readiness ?? live).filter(check => check.kind === "protocol" && (!port || check.port === port));
      const measured = live.filter(check => !port || check.port === port);
      const ready = checks.length > 0 && checks.every(check => measured.some(value => value.port === check.port && value.ok));
      const bindingNames = Object.entries(instance.lock.bindings ?? {}).filter(([, value]) =>
        value.service === service.name && (!port || value.port === port)).map(([name]) => name);
      surfaces.push({ id, name: SURFACE_NAMES[id] ?? id,
        implementation: service.name === "emulate" ? "emulate" : service.name === "mail" ? "Cyrus IMAP" : service.name === "s3" ? "SeaweedFS" : "WorldFixture",
        version: service.version, state: state === "running" ? ready ? "ready" : "starting" : state,
        service: service.name, capabilities: profiles, bindingNames, checks });
    }
  }
  return surfaces;
}

export function workbenchBindingGroups(instance, bindings) {
  return surfaceReadiness(instance).map(surface => ({ id: surface.id, name: surface.name, service: surface.service,
    capabilities: surface.capabilities, bindings: surface.bindingNames.filter(name => Object.hasOwn(bindings, name)) }));
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

function slackPersonBindings(bindings, artifactPath, person, credentials) {
  const slack = resolveToken(artifactPath, { profile: "slack.workspace.v1", person: person.id, credentials });
  if (slack.scope !== 'person' || !slack.value) throw new Error(`${person.name} has no current Slack credential`);
  return { ...bindings, SLACK_TOKEN: slack.value };
}

function googlePersonBindings(bindings, artifactPath, person, credentials) {
  const tokens = overlayTokens(artifactPath);
  const key = tokens[`google_token_${person.id}`]?.login === person.email ? `google_token_${person.id}`
    : tokens.demo_token?.login === person.email ? "demo_token" : null;
  const token = key && credentials?.values?.[`token:${key}`];
  if (!token) throw new Error(`${person.name} has no current Google mailbox credential`);
  return { ...bindings, GOOGLE_TOKEN: token };
}

function requireProviderIdentity(artifactPath, provider, person) {
  // Check the declared identity grant before resolving its run credential.
  if (resolveTokenReference(artifactPath, { profile: `${provider}.identity.v1`, person: person.id }).scope === 'person') return;
  throw new Error(`${person.name} has no ${provider} action credential in this world`);
}

function recordProviderEvent(instance, { type, source, actorId, evidence }) {
  const event = { id: `evt_${randomUUID().replaceAll("-", "").slice(0, 24)}`, type, actor_id: actorId,
    source, occurred_at: new Date().toISOString(), provider_evidence: evidence };
  appendEvent(instance.state, event);
  return event;
}

// A WORLD'S OWN CREDENTIALS ARE WORLD DATA, AND THE READER NEEDS THEM.
//
// This used to keep only names ending `_BASE_URL`, `_HOST_PORT`, `_USERNAME` or
// `_URL`, and drop anything containing TOKEN, SECRET, PASSWORD or KEY. That is
// 15 of the 28 declared provider bindings withheld -- every `*_TOKEN`, the S3
// access keys, the IMAP and SMTP passwords -- from a browser showing a synthetic
// world running on loopback.
//
// It was not a safe default, it was a broken one. The Target screen offers
// "Copy .env", and that button copies exactly this map: a reader pasted it into
// their application, got base URLs with no credentials, and every provider call
// answered 401 with nothing on the screen saying half the file was missing.
// Meanwhile `worldfixture env` prints the same tokens in full, and they sit in
// `host-bindings.json` on disk, so nothing was being protected.
//
// THE CONNECTOR TOKEN IS THE ONE EXCEPTION, and it is a different kind of thing.
// It is not world data: it is the credential that writes into the developer's
// own application, so it stays out of the browser and is read from
// `.worldfixture/token` or the environment. The Target screen says so.
const CONNECTOR_TOKEN = /^WORLDFIXTURE_TOKEN$/i;

export function sanitizePublicBindings(bindings = {}) {
  return Object.fromEntries(Object.entries(bindings).filter(([name, value]) =>
    typeof value === "string" && !CONNECTOR_TOKEN.test(name)));
}

function publicBindings(stateDir, fallback) {
  try { return sanitizePublicBindings(JSON.parse(readFileSync(join(stateDir, "host-bindings.json"), "utf8"))); }
  catch { return sanitizePublicBindings(fallback); }
}

function connectorFile(stateDir) {
  return join(stateDir, "application-connector.json");
}

function connectorTarget(stateDir, generation, world) {
  try {
    const target = JSON.parse(readFileSync(connectorFile(stateDir), "utf8"));
    if (generation && (target.generation !== generation || target.confirmed !== true || target.world?.artifact_sha256 !== world?.artifact_sha256)) return null;
    return target.withoutApplication ? null : target;
  }
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

async function connectorOverview(instance, stateDir, artifactPath, generation) {
  const target = connectorTarget(stateDir, generation, instance.lock.world);
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
    return { state, url: target.url, error: error.message, prompt: connectorPrompt(target.url, { artifactPath }) };
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

function serveDocs(url, response) {
  if (!url.pathname.startsWith("/docs")) return false;
  const relative = url.pathname.replace(/^\/docs\/?/, "") || "index.html";
  const requested = relative.endsWith("/") ? `${relative}index.html` : relative;
  const path = normalize(join(DOCS_ROOT, requested));
  if (!path.startsWith(`${DOCS_ROOT}/`) && path !== join(DOCS_ROOT, "index.html")) return false;
  const file = [path, `${path}.html`, join(path, "index.html")].find((candidate) => existsSync(candidate));
  if (!file) return false;
  const extension = file.slice(file.lastIndexOf("."));
  response.writeHead(200, { "content-type": MIME[extension] ?? "application/octet-stream",
    "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable" });
  response.end(readFileSync(file));
  return true;
}

export async function startWorkbench(initialInstance, {
  artifactPath,
  stateDir,
  port = 0,
  host = "127.0.0.1",
  revealWebhookSecrets = workbenchWebhookSecretRevealEnabled(),
  session,
}) {
  const initialArtifactPath = artifactPath;
  const managerFor = () => session ?? initialInstance.sessionManager;
  const currentInstance = () => managerFor()?.instance ?? initialInstance;
  const contexts = new WeakMap();
  let cacheScope;
  function snapshot(instance, generation) {
    const artifactPath = instance.artifactPath ?? initialArtifactPath;
    const digest = instance.lock?.world?.artifact_sha256;
    let context = contexts.get(instance);
    if (!context || context.artifactPath !== artifactPath || context.digest !== digest) {
      const world = readWorld(artifactPath);
      context = { artifactPath, digest, world, held: contents(world), company: primaryOrganization(world) ?? {},
        acceptedProof: `World ${world.id}:${world.version} · ${digest ?? "artifact identity unavailable"} · ${instance.lock?.services?.length ?? 0} selected services.` };
      contexts.set(instance, context);
    }
    const epoch = instance.timelineControl?.status().repeat?.cycle ?? 0;
    const scope = JSON.stringify([generation ?? instance.id ?? "unmanaged", epoch]);
    if (scope !== cacheScope) { slackNames.clear(); cacheScope = scope; }
    const bindings = { ...(instance.applicationBindings ?? instance.bindings()) };
    slackNameScopes.set(bindings, scope);
    const inspector = existsSync(join(artifactPath, "projections/emulator-overlay.json"))
      ? resolveToken(artifactPath, { profile: "slack.workspace.v1", credentials: instance.credentials }) : {};
    const asInspector = input => {
      const value = inspector.value ? { ...input, SLACK_TOKEN: inspector.value } : input;
      slackNameScopes.set(value, scope); return value;
    };
    return { ...context, bindings, asInspector };
  }
  const allowWebhookSecretReveal = revealWebhookSecrets === true;
  const liveClients = new Set();
  let revision = 0;
  const notify = (kind = "refresh") => {
    revision += 1;
    const message = `event: ${kind}\ndata: ${JSON.stringify({ revision, at: new Date().toISOString() })}\n\n`;
    for (const client of liveClients) client.write(message);
  };

  // The runtime event ledger triggers refreshes; an idle world needs no
  // repeated provider reads.
  const highestSeq = () => {
    try {
      return currentInstance().state.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get().seq;
    } catch {
      return null;
    }
  };
  let lastSeq = highestSeq();
  const lifecycleState = () => { const instance = currentInstance(); return JSON.stringify([instance.phase, [...(instance.serviceStates ?? [])]]); };
  let lastLifecycle = lifecycleState();
  const liveTimer = setInterval(() => {
    const seq = highestSeq();
    const lifecycle = lifecycleState();
    if (lifecycle !== lastLifecycle) {
      lastLifecycle = lifecycle;
      notify("service-change");
    }
    if (seq === null || seq === lastSeq) return;
    lastSeq = seq;
    notify("refresh");
  }, 1500);
  liveTimer.unref();

  const notifyClock = () => {
    const instance = currentInstance(), manager = managerFor();
    if (!instance.timelineControl || liveClients.size === 0) return;
    const message = `event: clock\ndata: ${JSON.stringify({ ...instance.timelineControl.status(), ...(manager ? { generation: manager.generation, session: manager.status() } : {}) })}\n\n`;
    for (const client of liveClients) client.write(message);
  };
  const clockTimer = setInterval(notifyClock, 1000);
  clockTimer.unref();

  // A comment line, not an event: it holds the connection open through a proxy
  // without asking any browser to re-read anything.
  let lastSession;
  const notifySession = () => {
    const manager = managerFor();
    if (!manager) return;
    const status = manager.status(), serialized = JSON.stringify(status);
    if (serialized === lastSession) return;
    lastSession = serialized;
    slackNames.clear();
    for (const client of liveClients) client.write(`event: session\ndata: ${serialized}\n\n`);
  };
  const sessionTimer = setInterval(notifySession, 250);
  sessionTimer.unref();
  const keepAlive = setInterval(() => {
    for (const client of liveClients) client.write(": keep-alive\n\n");
  }, 20_000);
  keepAlive.unref();

  const server = createServer(async (request, response) => {
    const manager = managerFor();
    try {
      const url = new URL(request.url, "http://worldfixture.local");
      const expected = request.headers["x-worldfixture-generation"];
      if (request.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/readyz") {
        if (serveDocs(url, response)) return;
        if (serveUi(url, response)) return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") return json(response, 200, { ready: true });
      if (request.method === "GET" && url.pathname === "/api/live") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        response.write(`event: ready\ndata: ${JSON.stringify({ revision, at: new Date().toISOString() })}\n\n`);
        liveClients.add(response);
        if (manager) response.write(`event: session\ndata: ${JSON.stringify(manager.status())}\n\n`);
        notifyClock();
        request.on("close", () => liveClients.delete(response));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        if (manager) response.setHeader("X-WorldFixture-Generation", manager.generation);
        return json(response, 200, manager ? { ...manager.status(), managed: true } : { managed: false, generation: null,
          phase: currentInstance().phase ?? "ready", reconnect_required: false });
      }
      if (["/api/worlds", "/api/world/switch", "/api/world/connection"].includes(url.pathname)) {
        if (!manager) return json(response, 503, { error: "World switching is unavailable for this run", code: "session_unavailable" });
        let result;
        if (url.pathname === "/api/worlds" && request.method === "GET") result = { data: await manager.catalogue() };
        else if (url.pathname === "/api/world/switch" && request.method === "POST") result = await manager.switchWorld(await body(request), expected);
        else if (url.pathname === "/api/world/connection" && request.method === "POST") result = await manager.confirmConnection(await body(request), expected);
        else return json(response, 405, { error: "This session operation does not support that method" });
        notifySession(); notifyClock();
        response.setHeader("X-WorldFixture-Generation", manager.generation);
        return json(response, 200, result);
      }
      if (manager && request.method === "POST" && ["/api/connector/connect", "/api/connector/disconnect"].includes(url.pathname)) {
        const input = await body(request);
        await manager.confirmConnection(url.pathname.endsWith("/disconnect") ? { withoutApplication: true } : { applicationUrl: input.url }, expected);
        const value = await manager.withGeneration(expected, (instance, { generation }) => connectorOverview(instance, instance.stateDir, instance.artifactPath, generation));
        notifySession(); notify("connector-change");
        response.setHeader("X-WorldFixture-Generation", manager.generation);
        return json(response, 200, value);
      }
      const dispatch = async (instance, { generation } = {}) => {
        const connectorStateDir = manager ? instance.stateDir : stateDir;
        const { artifactPath, world, held, company, acceptedProof, bindings, asInspector } = snapshot(instance, generation);
        const reply = (status, value) => ({ status, value });
      if (["/api/clock", "/api/timeline"].includes(url.pathname)) {
        const controller = instance.timelineControl;
        if (!controller) return reply(503, { error: "The timeline is not ready yet.", code: "timeline_not_ready" });
        try {
          if (request.method === "GET" && url.pathname === "/api/clock") return reply(200, controller.status());
          if (request.method === "GET" && url.pathname === "/api/timeline") {
            return reply(200, controller.timeline(url.searchParams));
          }
          if (request.method === "POST" && url.pathname === "/api/clock") {
            const input = await body(request);
            const result = manager ? await manager.clockCommand(input, expected) : await controller.command(input);
            notifyClock();
            return reply(200, result);
          }
          return reply(405, { error: "This timeline operation does not support that method." });
        } catch (error) {
          notifyClock();
          return reply(error.status ?? 400, { error: error.message, code: error.code ?? "timeline_request_failed", state_changed: error.state_changed === true, ...(error.result ? { result: error.result } : {}) });
        }
      }
      if (request.method === "GET" && url.pathname === "/api/overview") {
        const browserBindings = publicBindings(stateDir, bindings);
        // The 500-event read that used to be passed here went to a parameter
        // nothing read, so every overview poll paid for a query and a JSON parse
        // per event and then threw the result away. The activity the screen
        // shows is read once, below.
        const providers = await providerOverview(asInspector(bindings), artifactPath, world, browserBindings);
        providers.notion.webhookSecretRevealEnabled = allowWebhookSecretReveal;
        const organizations = new Map((world.organizations ?? []).map((entry) => [entry.id, entry.name]));
        return reply(200, {
          world: { id: world.id, version: world.version, artifact_sha256: instance.lock.world?.artifact_sha256, title: world.title, description: world.scenario?.title ?? company.summary,
            company: company.name, organizationId: company.id ?? null, organizationPeople: (world.people ?? []).filter(person => company.id && person.organization_id === company.id).length, worldPeople: (world.people ?? []).length, people: held.people, slackMessages: held.slack_messages, mailMessages: held.mail_messages },
          organizations: (world.organizations ?? []).map(({ id, name, summary, domain }) => ({ id, name, summary, domain })),
          people: (world.people ?? []).map(({ id, name, role, primary, organization_id, email, slack_id, github_login }) => ({ id, name, role, primary,
            organization_id, organization_name: organizations.get(organization_id), email, slack_id, github_login })),
          phase: instance.phase ?? "ready",
          ...(manager ? { session: manager.status(), generation } : {}),
          bindings: browserBindings, bindingGroups: workbenchBindingGroups(instance, browserBindings), providers, readiness: readiness(instance),
          surfaces: surfaceReadiness(instance).map(({ checks, ...surface }) => surface),
          activity: latestEvents(instance.state, 100).reverse(), acceptedProof,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/connector") {
        return reply(200, await connectorOverview(instance, connectorStateDir, artifactPath, generation));
      }
      if (request.method === "POST" && url.pathname === "/api/connector/connect") {
        const input = await body(request);
        let display;
        try {
          display = new URL(String(input.url));
          if (!["http:", "https:"].includes(display.protocol)) throw new Error("not HTTP");
        } catch {
          return reply(400, { error: "Enter an HTTP or HTTPS application URL." });
        }
        const target = {
          url: display.toString().replace(/\/$/, ""),
          transport_url: connectorTransportUrl(display),
        };
        writeFileSync(connectorFile(connectorStateDir), `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
        return reply(200, await connectorOverview(instance, connectorStateDir, artifactPath, generation));
      }
      if (request.method === "POST" && url.pathname === "/api/connector/disconnect") {
        await body(request);
        rmSync(connectorFile(connectorStateDir), { force: true });
        return reply(200, { state: "disconnected" });
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/connector/")) {
        const action = url.pathname.split("/").at(-1);
        const input = await body(request);
        const target = connectorTarget(connectorStateDir, generation, instance.lock.world);
        if (!target) return reply(409, { error: "Connect an application first." });
        const options = { artifactPath, token: instance.runtimeToken };
        if (action === "prompt") return reply(200, { prompt: connectorPrompt(target.url, { artifactPath }) });

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
            if (error instanceof ScaleError) return reply(400, { error: error.message });
            throw error;
          }
        }

        if (action === "plan") {
          const result = await planConnector(target.transport_url, { ...options, world: slice });
          return reply(200, { ...result, scale: slice.scale, schema_errors: result.schema_errors ?? [] });
        }
        if (action === "seed") {
          const result = await seedConnector(target.transport_url, { ...options, world: slice, options: input.options });
          notify("connector-change");
          return reply(200, { ...result, scale: slice.scale, schema_errors: result.schema_errors ?? [] });
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
            return reply(400, { error: error.message });
          }
          const result = await deliverConnectorEvent(target.transport_url, event, options);
          notify("connector-change");
          return reply(200, { ...result, delivered: event, schema_errors: result.schema_errors ?? [] });
        }
        if (action === "event") {
          const result = await deliverConnectorEvent(target.transport_url, input, options);
          notify("connector-change");
          return reply(200, result);
        }
        if (action === "reset") {
          const result = await resetConnector(target.transport_url, options);
          notify("connector-change");
          return reply(200, result);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/probe") {
        await body(request);
        return reply(200, { surfaces: await probeApplicationSurfaces(instance) });
      }
      if (request.method === "GET" && url.pathname === "/api/provider/gmail") {
        const person = personFor(world, url.searchParams.get("person_id"));
        requireProviderIdentity(artifactPath, "google", person);
        const folders = await gmailOverview(googlePersonBindings(bindings, artifactPath, person, instance.credentials));
        return reply(200, { ...folders, email: person.email, status: "ready", available: true });
      }
      if (request.method === "GET" && url.pathname === "/api/provider/domain") {
        if (!bindings.DOMAIN_BASE_URL) return reply(404, { error: "The domain service is not selected" });
        let path;
        try {
          path = domainCollectionPath(url.searchParams.get("collection"), url.searchParams.has("id") ? url.searchParams.get("id") : undefined);
          const query = new URLSearchParams();
          for (const name of ["cursor", "limit"]) if (url.searchParams.has(name)) query.set(name, url.searchParams.get(name));
          if (query.size) path += `?${query}`;
        } catch (error) { return reply(400, { error: error.message }); }
        const result = await fetch(`${bindings.DOMAIN_BASE_URL.replace(/\/$/, "")}${path}`, {
          headers: { authorization: `Bearer ${bindings.DOMAIN_TOKEN}`, accept: "application/json" }, signal: AbortSignal.timeout(30000),
        });
        const value = await result.json();
        if (!result.ok) return reply(result.status, { error: value.error?.message ?? value.error ?? "The domain service refused the read" });
        try {
          validateDomainWorld(value.world, { id: world.id, version: world.version, artifact_sha256: instance.lock?.world?.artifact_sha256 });
          if (!url.searchParams.has("id")) validateDomainPage(value);
          else if (!value.record || typeof value.record !== "object" || Array.isArray(value.record)) throw new Error("Domain API returned no record");
        } catch (error) { return reply(502, { error: error.message }); }
        return reply(200, value);
      }
      if (request.method === "GET" && url.pathname === "/api/provider/http") {
        const path = url.searchParams.get("path");
        if (!bindings.SITE_BASE_URL || !httpTargetLinks(artifactPath, bindings.SITE_BASE_URL).some(target => target.path === path)) return reply(404, { error: "This run has no such HTTP target" });
        const result = await fetch(`${bindings.SITE_BASE_URL.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(30000), redirect: "manual" });
        const text = await result.text();
        return reply(200, { path, status: result.status, ok: result.ok, preview: text.slice(0, 400) });
      }
      if (request.method === "GET" && url.pathname === "/api/provider/slack") {
        const channel = url.searchParams.get("channel");
        if (!channel) return reply(400, { error: "channel is required" });
        return reply(200, await slackHistory(asInspector(bindings), channel));
      }
      if (request.method === "GET" && url.pathname === "/api/inspect/events") {
        return reply(200, { events: eventsAfter(instance.state, Number(url.searchParams.get("after") ?? 0), 100) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/inspect/people/")) {
        const person = world.people.find((entry) => entry.id === decodeURIComponent(url.pathname.split("/").at(-1)));
        return person ? reply(200, person) : reply(404, { error: "person not found" });
      }
      if (request.method === "POST" && url.pathname === "/api/inspect/notion/webhook-value") {
        if (!allowWebhookSecretReveal) {
          return reply(403, { error: "webhook value reveal is disabled by WORLDFIXTURE_WORKBENCH_REVEAL_WEBHOOK_SECRETS" });
        }
        const input = await body(request);
        const inspection = await providerJson(`${bindings.NOTION_BASE_URL}/__worldfixture/notion-admin`, bindings.NOTION_TOKEN);
        const revealed = selectNotionWebhookReveal(inspection, input);
        if (!revealed) return reply(404, { error: "the selected webhook value is not available" });
        return reply(200, { ok: true, message: "The selected webhook value is visible until this page is refreshed.", result: revealed });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/domain") {
        const input = await body(request);
        if (!input.actor_id || !world.people?.some(person => person.id === input.actor_id)) {
          return reply(400, { error: "Select a declared world person before you change a record" });
        }
        let result;
        try {
          result = await executeDomainOperation(instance.state, input, {
            world, bindings, rules: instance.lock?.rules ?? [],
          });
        } catch (error) {
          return reply(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500,
            { error: error.message, code: error.code, field: error.field });
        }
        notify("provider-change");
        return reply(200, { ...result, message: "The domain API accepted the record change." });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/slack") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        requireProviderIdentity(artifactPath, "slack", person);
        const personal = slackPersonBindings(bindings, artifactPath, person, instance.credentials);
        const listed = await providerJson(`${personal.SLACK_BASE_URL}/api/conversations.list`, personal.SLACK_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "limit=100",
        });
        const providerChannel = listed.channels?.find((entry) => entry.id === input.channel);
        const channel = world.communication.channels.find((entry) => entry.name === providerChannel?.name);
        if (!channel) throw new Error("the selected Slack channel is not declared by this world");
        const result = await submit(instance.state,
          { baseUrl: personal.SLACK_BASE_URL, token: personal.SLACK_TOKEN, person, channel, text: String(input.text ?? "") },
          { world, rules: instance.lock.rules ?? [], bindings });
        const queued = result.effects.length;
        const consequence = queued > 0
          ? `WorldFixture queued ${queued} scheduled ${queued === 1 ? "effect" : "effects"}. Check Timeline for delivery.`
          : "No causal rule matched this message.";
        notify("provider-change");
        return reply(200, { ok: true, message: `Slack accepted the message from ${result.identity.user}. ${consequence}`, event: result.event, effects: result.effects });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/gmail") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        requireProviderIdentity(artifactPath, "google", person);
        const result = await sendGmail(googlePersonBindings(bindings, artifactPath, person, instance.credentials), input);
        const event = recordProviderEvent(instance, { type: "mail.message.sent.v1", source: "google", actorId: person.id,
          evidence: { message_id: result.id, thread_id: result.threadId, to: input.to, subject: input.subject } });
        notify("provider-change");
        return reply(200, { ok: true, message: `Gmail accepted message ${result.id}.`, event });
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
        return reply(200, { ok: true, message: `SMTP accepted mail from ${person.email}. It is available through IMAP.`, event });
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
        return reply(200, { ok: true, message: `GitHub accepted issue #${result.number}.`, event, issue: result });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/s3") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const acceptedBuckets = new Set((projection(artifactPath, "aws").s3?.buckets ?? []).map((entry) => entry.name));
        if (!acceptedBuckets.has(input.bucket)) throw new Error("the selected S3 bucket is not declared by this world");
        const target = `${bindings.S3_BASE_URL}/${encodeURIComponent(input.bucket)}/${String(input.key).split("/").map(encodeURIComponent).join("/")}`;
        const result = await s3Fetch(target, { method: "PUT", headers: { "content-type": "text/plain; charset=utf-8" }, body: input.text }, bindings);
        if (!result.ok) throw new Error(`S3 refused PutObject with ${result.status}: ${(await result.text()).slice(0, 180)}`);
        const event = recordProviderEvent(instance, { type: "object.created.v1", source: "s3", actorId: person.id,
          evidence: { bucket: input.bucket, key: input.key, etag: result.headers.get("etag") } });
        notify("provider-change");
        return reply(200, { ok: true, message: `SeaweedFS accepted s3://${input.bucket}/${input.key}.`, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-create-invoice") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const amount = Number(input.amount_cents);
        if (!Number.isSafeInteger(amount) || amount <= 0) return reply(400, { error: "Enter a positive integer amount in the currency’s minor units." });
        const currency = String(input.currency ?? "").trim().toLowerCase();
        if (!/^[a-z]{3}$/.test(currency)) return reply(400, { error: "Enter an explicit three-letter currency." });
        const dueOn = String(input.due_on ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return reply(400, { error: "Enter a valid due date." });
        const description = String(input.description ?? "Service invoice").trim() || "Service invoice";
        const form = { customer: String(input.customer_id), description, collection_method: "send_invoice",
          due_date: String(Math.floor(new Date(`${dueOn}T00:00:00Z`).getTime() / 1000)) };
        const draft = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoices`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form),
        });
        await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoiceitems`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ customer: String(input.customer_id), invoice: draft.id, amount: String(amount),
            currency, description }),
        });
        const invoice = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/invoices/${encodeURIComponent(draft.id)}/finalize`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "",
        });
        const event = recordProviderEvent(instance, { type: "stripe.invoice.created.v1", source: "stripe", actorId: person.id,
          evidence: { invoice_id: invoice.id, customer_id: invoice.customer, amount_cents: invoice.amount_due } });
        notify("provider-change");
        return reply(200, { ok: true, message: `Stripe created invoice ${invoice.number}.`, invoice, event });
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
        return reply(200, { ok: true, message: `Stripe paid invoice ${invoice.number}.`, invoice, event });
      }
      if (request.method === "POST" && url.pathname === "/api/actions/stripe-payment") {
        const input = await body(request);
        const person = personFor(world, input.person_id);
        const amount = Number(input.amount_cents);
        if (!Number.isSafeInteger(amount) || amount <= 0) return reply(400, { error: "Enter a positive integer amount in the currency’s minor units." });
        const currency = String(input.currency ?? "").trim().toLowerCase();
        if (!/^[a-z]{3}$/.test(currency)) return reply(400, { error: "Enter an explicit three-letter currency." });
        const created = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/payment_intents`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ amount: String(amount), currency,
            customer: String(input.customer_id ?? ""), description: String(input.description ?? "Workbench payment"), payment_method: "pm_card_visa" }),
        });
        const payment = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/payment_intents/${encodeURIComponent(created.id)}/confirm`, bindings.STRIPE_TOKEN, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payment_method: "pm_card_visa" }),
        });
        const event = recordProviderEvent(instance, { type: "stripe.payment.succeeded.v1", source: "stripe", actorId: person.id,
          evidence: { payment_intent_id: payment.id, customer_id: input.customer_id, invoice_id: input.invoice_id, amount_cents: amount, currency: payment.currency } });
        notify("provider-change");
        return reply(200, { ok: true, message: `Stripe accepted ${payment.id}.`, payment, event });
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
        return reply(200, { ok: true, message: `Stripe canceled ${payment.id}.`, payment, event });
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
        return reply(200, { ok: true, message: `Stripe canceled subscription ${subscription.id}.`, subscription, event });
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
        return reply(200, { ok: true, message: `Notion ${input.operation.replaceAll("_", " ")} completed.`, result: publicResult });
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        await body(request);
        notify("reset-started");
        if (manager) await manager.clockCommand({ action: "reset" }, expected);
        else await instance.reset();
        notify("reset-completed");
        return reply(200, { ok: true, acceptedProof });
      }
      return reply(404, { error: "not found" });
      };
      const clockMutation = request.method === "POST" && ["/api/clock", "/api/reset"].includes(url.pathname);
      const result = manager ? await manager.withGeneration(expected, dispatch, { mutation: request.method !== "GET" && !clockMutation })
        : await dispatch(initialInstance);
      if (manager) response.setHeader("X-WorldFixture-Generation", manager.generation);
      return json(response, result.status, result.value);
    } catch (error) {
      if (manager) response.setHeader("X-WorldFixture-Generation", manager.generation);
      return json(response, error.status ?? 500, { error: error.message, code: error.code, detail: error.detail, request_id: randomUUID() });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, notify: (kind = "refresh") => { notifySession(); notifyClock(); notify(kind); }, close: () => new Promise((resolve) => {
    clearInterval(liveTimer);
    clearInterval(clockTimer);
    clearInterval(keepAlive);
    clearInterval(sessionTimer);
    for (const client of liveClients) client.end();
    server.close(resolve);
  }) };
}
