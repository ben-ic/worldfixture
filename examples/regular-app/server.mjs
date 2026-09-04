import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { loadBindings } from "../lib/bindings.mjs";
import {
  allSlackMessages, createGithubIssue, githubIssues, githubRepositories, gmailMessageDetails, postSlack,
  putS3Object, s3BucketDetails, sendGmail, slackChannels, stripeCustomers,
} from "../lib/provider-client.mjs";
import { inbox } from "../../runtime/src/imap.mjs";
import { send as sendMail } from "../../runtime/src/smtp.mjs";
import { createWorldFixtureConnector } from "./worldfixture-connector.mjs";

const bindings = loadBindings();
const authMode = process.env.WORLDFIXTURE_AUTH_MODE === "oauth" ? "oauth" : "preauthorized";
const appTokens = {
  slack: authMode === "preauthorized" ? bindings.SLACK_TOKEN : null,
  github: authMode === "preauthorized" ? bindings.GITHUB_TOKEN : null,
  google: authMode === "preauthorized" ? bindings.GOOGLE_TOKEN : null,
};
const pendingOAuth = new Map();
function connectorToken() {
  if (process.env.WORLDFIXTURE_TOKEN) return process.env.WORLDFIXTURE_TOKEN;
  try { return readFileSync(join(process.cwd(), ".worldfixture/token"), "utf8").trim(); }
  catch { return null; }
}
const worldfixtureConnector = createWorldFixtureConnector({ token: connectorToken() });
const PUBLIC = join(import.meta.dirname, "public");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const authorizedBindings = () => ({ ...bindings, SLACK_TOKEN: appTokens.slack, GITHUB_TOKEN: appTokens.github, GOOGLE_TOKEN: appTokens.google });
function requireAuth(provider) {
  if (!appTokens[provider]) throw new Error(`${provider} is not connected. Complete OAuth or use pre-authorized mode.`);
}
async function optionalProvider(provider, operation, fallback) {
  if (!appTokens[provider]) return fallback;
  try { return await operation(); }
  catch (error) {
    if (/401|403|auth|token/i.test(error.message)) appTokens[provider] = null;
    return fallback;
  }
}

async function tokenIsValid(provider, current) {
  if (!appTokens[provider]) return false;
  const checks = {
    slack: [`${bindings.SLACK_BASE_URL}/api/auth.test`, { method: "POST" }],
    github: [`${bindings.GITHUB_BASE_URL}/user`, {}],
    google: [`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages?maxResults=1`, {}],
  };
  const [url, options] = checks[provider];
  try {
    const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${current[`${provider.toUpperCase()}_TOKEN`]}` } });
    if (!response.ok) return false;
    if (provider === "slack") return (await response.json()).ok === true;
    return true;
  } catch {
    return false;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function headers(message) {
  return Object.fromEntries((message.payload?.headers ?? []).map((entry) => [entry.name.toLowerCase(), entry.value]));
}

function accountHealth(name) {
  if (name === "Lumen Labs") return ["at risk", "Renewal brief needs an accurate export status"];
  if (name === "Harbor Mobility") return ["billing", "Customer record needs billing follow-up"];
  return ["healthy", "No urgent signal in the connected systems"];
}

function belongsTo(account, value) {
  const text = JSON.stringify(value).toLowerCase();
  const words = account.name.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
  return text.includes(account.email.toLowerCase()) || words.some((word) => text.includes(word));
}

async function providerState() {
  const current = authorizedBindings();
  const [customers, mail, issues, slack, buckets, repositories, slackReady, githubReady, googleReady] = await Promise.all([
    stripeCustomers(bindings), optionalProvider("google", () => gmailMessageDetails(current), []),
    optionalProvider("github", () => githubIssues(current), []), optionalProvider("slack", () => allSlackMessages(current), []),
    s3BucketDetails(bindings), optionalProvider("github", () => githubRepositories(current), []),
    tokenIsValid("slack", current), tokenIsValid("github", current), tokenIsValid("google", current),
  ]);
  if (!slackReady) appTokens.slack = null;
  if (!githubReady) appTokens.github = null;
  if (!googleReady) appTokens.google = null;
  const accounts = customers.filter((customer) => customer.name && customer.name !== "Test Customer").map((customer) => {
    const [health, note] = accountHealth(customer.name);
    return { id: customer.id, name: customer.name, email: customer.email, health, note,
      mail: mail.filter((message) => belongsTo(customer, message)).length,
      issues: issues.filter((issue) => belongsTo(customer, issue)).length };
  });
  const changed = buckets.some((bucket) => bucket.keys.some((key) => key.startsWith("relay-digest/")));
  return {
    accounts, mail, issues, slack, buckets, repositories,
    connections: [
      { id: "slack", name: "Slack", detail: new URL(bindings.SLACK_BASE_URL).host, ready: slackReady, mode: slackReady ? authMode : "oauth" },
      { id: "github", name: "GitHub", detail: new URL(bindings.GITHUB_BASE_URL).host, ready: githubReady, mode: githubReady ? authMode : "oauth" },
      { id: "google", name: "Gmail", detail: new URL(bindings.GOOGLE_BASE_URL).host, ready: googleReady, mode: googleReady ? authMode : "oauth" },
      { id: "stripe", name: "Stripe", detail: new URL(bindings.STRIPE_BASE_URL).host, ready: true, mode: "API key" },
      { id: "mail", name: "Mail", detail: `${bindings.SMTP_HOST_PORT} · ${bindings.IMAP_HOST_PORT}`, ready: true, mode: "SMTP + IMAP" },
      { id: "s3", name: "Object storage", detail: new URL(bindings.S3_BASE_URL).host, ready: true, mode: "S3 credential" },
    ],
    resetProof: changed ? "This instance contains Relay Digest changes." : "The accepted starting state is present.",
  };
}

async function briefFor(customerId) {
  const state = await providerState();
  const account = state.accounts.find((entry) => entry.id === customerId) ?? state.accounts[0];
  if (!account) throw new Error("Stripe returned no customer accounts");
  const mail = state.mail.filter((message) => belongsTo(account, message));
  const issues = state.issues.filter((issue) => belongsTo(account, issue));
  const slack = state.slack.filter((message) => belongsTo(account, message));
  const issue = issues[0];
  const customerMail = mail[0];
  const billingMail = mail.find((message) => /invoice|billing|412\.00/i.test(JSON.stringify(message)));
  const sections = [
    { title: "Where the account stands", source: `Stripe · GET /v1/customers/${account.id}`,
      text: `${account.name} is a connected customer account. The provider record names ${account.email} as its contact.`, evidence: account.id },
    { title: "The open technical risk", source: issue ? `GitHub · ${issue.repository}#${issue.number}` : "GitHub · issues list",
      text: issue ? `${issue.title}. ${issue.body}` : "GitHub has no issue that names this account.", evidence: issue?.html_url },
    { title: "What the customer has said", source: customerMail ? `Gmail · ${customerMail.id}` : "Gmail · messages list",
      text: customerMail ? `${headers(customerMail).subject}. ${customerMail.snippet}` : "Gmail has no matching customer thread.", evidence: headers(customerMail ?? {}).from },
    { title: "Team context", source: slack.length ? `Slack · #${slack[0].channel}` : "Slack · connected channels",
      text: slack.length ? slack[0].text : "No Slack message names this customer. The brief keeps that source empty instead of inventing team agreement.", evidence: slack[0]?.ts },
  ];
  if (billingMail) sections.push({ title: "Billing, stated exactly", source: `Gmail · ${billingMail.id}`,
    text: billingMail.snippet, evidence: headers(billingMail).subject, warning: "This statement comes from mail. The Stripe customer record does not prove that an invoice is paid." });
  return { account, sections, sources: { mail: mail.length, issues: issues.length, slack: slack.length } };
}

async function publish(customerId) {
  requireAuth("google"); requireAuth("slack");
  const current = authorizedBindings();
  const brief = await briefFor(customerId);
  const marker = `RELAY_DIGEST_${Date.now()}`;
  const slug = brief.account.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const key = `relay-digest/${slug}-${Date.now()}.json`;
  const stored = await putS3Object(bindings, "northstar-relay-documents", key, { marker, ...brief });
  const mail = await sendGmail(current, { to: brief.account.email, subject: `Account brief: ${brief.account.name}`,
    text: `${brief.sections.map((section) => `${section.title}\n${section.text}\nSource: ${section.source}`).join("\n\n")}\n\nStored at s3://${stored.bucket}/${stored.key}` });
  const slack = await postSlack(current, `${marker}: ${brief.account.name} brief stored at s3://${stored.bucket}/${stored.key}. Gmail accepted ${mail.id}.`);
  return { marker, stored, mail: mail.id, slack: slack.ts ?? slack.message?.ts,
    phases: ["Submitted", "Accepted by Gmail, Slack, and S3", "Read back through provider APIs", "Consequences settled"] };
}

async function body(request, limit = 128 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request is too large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}

async function mailbox() {
  const result = await inbox(bindings.IMAP_HOST_PORT, {
    login: bindings.IMAP_USERNAME, password: bindings.IMAP_PASSWORD, limit: 40,
  });
  return { ...result, address: bindings.IMAP_USERNAME };
}

const OAUTH = {
  slack: { base: "SLACK_BASE_URL", authorize: "/oauth/v2/authorize", token: "/api/oauth.v2.access",
    client: "relay-digest-slack", scope: "channels:read,channels:history,chat:write,users:read" },
  github: { base: "GITHUB_BASE_URL", authorize: "/login/oauth/authorize", token: "/login/oauth/access_token",
    client: "relay-digest-github", scope: "repo read:user" },
  google: { base: "GOOGLE_BASE_URL", authorize: "/o/oauth2/v2/auth", token: "/oauth2/token",
    client: "relay-digest-google", scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" },
};

function oauthStart(request, response, provider) {
  const config = OAUTH[provider];
  if (!config) return sendJson(response, 404, { error: "unknown OAuth provider" });
  const state = randomUUID();
  const redirectUri = `http://${request.headers.host}/auth/${provider}/callback`;
  pendingOAuth.set(state, { provider, redirectUri, created: Date.now() });
  const url = new URL(config.authorize, bindings[config.base]);
  url.searchParams.set("client_id", config.client);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  if (provider === "slack") url.searchParams.set("user_scope", config.scope);
  url.searchParams.set("state", state);
  response.writeHead(302, { location: url.toString() });
  response.end();
}

async function oauthCallback(response, provider, url) {
  const record = pendingOAuth.get(url.searchParams.get("state"));
  pendingOAuth.delete(url.searchParams.get("state"));
  if (!record || record.provider !== provider || Date.now() - record.created > 10 * 60_000) throw new Error("OAuth state is invalid or expired");
  const config = OAUTH[provider];
  const form = new URLSearchParams({ code: url.searchParams.get("code") ?? "", client_id: config.client,
    client_secret: "worldfixture-example-secret", redirect_uri: record.redirectUri, grant_type: "authorization_code" });
  const tokenResponse = await fetch(new URL(config.token, bindings[config.base]), { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || token.error || token.ok === false || !token.access_token) throw new Error(token.error_description ?? token.error ?? "OAuth token exchange failed");
  appTokens[provider] = provider === "slack" && token.authed_user?.access_token ? token.authed_user.access_token : token.access_token;
  response.writeHead(302, { location: `/#${provider}` });
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://example.local");
    if (url.pathname === "/.well-known/worldfixture" || url.pathname.startsWith("/__worldfixture/")) {
      const input = request.method === "POST" ? await body(request, 8 * 1024 * 1024) : {};
      const result = await worldfixtureConnector.handle({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.authorization,
        input,
      });
      return sendJson(response, result.status, result.body);
    }
    const authMatch = url.pathname.match(/^\/auth\/(slack|github|google)\/(start|callback)$/);
    if (request.method === "GET" && authMatch?.[2] === "start") return oauthStart(request, response, authMatch[1]);
    if (request.method === "GET" && authMatch?.[2] === "callback") return await oauthCallback(response, authMatch[1], url);
    if (request.method === "GET" && url.pathname === "/api/state") {
      const state = await providerState();
      return sendJson(response, 200, { ...state, mail: undefined, issues: undefined, slack: undefined });
    }
    if (request.method === "POST" && url.pathname === "/api/brief") return sendJson(response, 200, await briefFor((await body(request)).customerId));
    if (request.method === "POST" && url.pathname === "/api/publish") return sendJson(response, 200, await publish((await body(request)).customerId));
    if (request.method === "GET" && url.pathname === "/api/slack") return sendJson(response, 200, {
      channels: (requireAuth("slack"), await slackChannels(authorizedBindings())), messages: await allSlackMessages(authorizedBindings()),
    });
    if (request.method === "POST" && url.pathname === "/api/slack") {
      const input = await body(request);
      requireAuth("slack"); return sendJson(response, 200, await postSlack(authorizedBindings(), input.text, input.channel));
    }
    if (request.method === "GET" && url.pathname === "/api/github") return sendJson(response, 200, {
      repositories: (requireAuth("github"), await githubRepositories(authorizedBindings())), issues: await githubIssues(authorizedBindings()),
    });
    if (request.method === "POST" && url.pathname === "/api/github") {
      const input = await body(request);
      requireAuth("github"); return sendJson(response, 200, await createGithubIssue(authorizedBindings(), input.title, input.text, input.repository));
    }
    if (request.method === "GET" && url.pathname === "/api/gmail") { requireAuth("google"); return sendJson(response, 200, await gmailMessageDetails(authorizedBindings())); }
    if (request.method === "POST" && url.pathname === "/api/gmail") { requireAuth("google"); return sendJson(response, 200, await sendGmail(authorizedBindings(), await body(request))); }
    if (request.method === "GET" && url.pathname === "/api/mail") return sendJson(response, 200, await mailbox());
    if (request.method === "POST" && url.pathname === "/api/mail") {
      const input = await body(request);
      const accepted = await sendMail(bindings.SMTP_HOST_PORT, { from: bindings.SMTP_USERNAME,
        to: input.to, subject: input.subject, body: input.text });
      return sendJson(response, 200, { accepted, mailbox: await mailbox() });
    }
    if (request.method === "GET" && url.pathname === "/api/files") return sendJson(response, 200, await s3BucketDetails(bindings));
    if (request.method === "POST" && url.pathname === "/api/files") {
      const input = await body(request);
      return sendJson(response, 200, await putS3Object(bindings, input.bucket, input.key, { text: input.text }));
    }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(PUBLIC, relative);
    if (request.method === "GET" && file.startsWith(PUBLIC) && existsSync(file)) {
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      return createReadStream(file).pipe(response);
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) { sendJson(response, 500, { error: error.message }); }
});

const preferredPort = Number(process.env.PORT ?? 3000);
server.once("error", (error) => {
  if (error.code !== "EADDRINUSE" || process.env.PORT) throw error;
  server.listen({ host: "127.0.0.1", port: 0 });
});
server.on("listening", () => console.log(`Relay Digest: http://127.0.0.1:${server.address().port}`));
server.listen({ host: "127.0.0.1", port: preferredPort });
