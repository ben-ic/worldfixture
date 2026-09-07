// A Postman collection for all HTTP API routes in one running world.
//
// Provider ports and credentials belong to a run. The Workbench generates this
// file when it is downloaded, so it never ships a stale port or token. The route
// inventory is generated from the provider registrations during development.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDER_ROUTES = JSON.parse(readFileSync(new URL("./postman-routes.json", import.meta.url), "utf8"));

const bearer = variable => ({ type: "bearer", bearer: [{ key: "token", value: `{{${variable}}}`, type: "string" }] });
const basic = (username, password) => ({ type: "basic", basic: [
  { key: "username", value: `{{${username}}}`, type: "string" },
  { key: "password", value: `{{${password}}}`, type: "string" },
] });
const header = (key, value) => ({ key, value, type: "text" });
const jsonBody = value => ({ mode: "raw", raw: JSON.stringify(value, null, 2), options: { raw: { language: "json" } } });
const formBody = entries => ({ mode: "urlencoded", urlencoded: Object.entries(entries).map(([key, value]) => ({ key, value, type: "text" })) });
const folder = (name, items, description) => ({ name, ...(description ? { description } : {}), item: items });

function request(name, method, url, { auth, headers = [], body, description } = {}) {
  return { name, request: { method, ...(auth ? { auth } : {}), ...(headers.length ? { header: headers } : {}),
    ...(body ? { body } : {}), url, ...(description ? { description } : {}) }, response: [] };
}

const PROVIDERS = {
  apple: { title: "Apple", binding: "APPLE_BASE_URL", token: "APPLE_TOKEN" },
  clerk: { title: "Clerk", binding: "CLERK_BASE_URL", token: "CLERK_TOKEN" },
  github: { title: "GitHub", binding: "GITHUB_BASE_URL", token: "GITHUB_TOKEN" },
  google: { title: "Google", binding: "GOOGLE_BASE_URL", token: "GOOGLE_TOKEN" },
  linear: { title: "Linear", binding: "LINEAR_BASE_URL", token: "LINEAR_TOKEN" },
  microsoft: { title: "Microsoft", binding: "MICROSOFT_BASE_URL", token: "MICROSOFT_TOKEN" },
  mongoatlas: { title: "MongoDB Atlas", binding: "MONGOATLAS_BASE_URL", token: "MONGOATLAS_TOKEN" },
  notion: { title: "Notion", binding: "NOTION_BASE_URL", token: "NOTION_TOKEN" },
  okta: { title: "Okta", binding: "OKTA_BASE_URL", token: "OKTA_TOKEN" },
  resend: { title: "Resend", binding: "RESEND_BASE_URL", token: "RESEND_TOKEN" },
  slack: { title: "Slack", binding: "SLACK_BASE_URL", token: "SLACK_TOKEN", form: true },
  stripe: { title: "Stripe", binding: "STRIPE_BASE_URL", token: "STRIPE_TOKEN", form: true },
  twilio: { title: "Twilio", binding: "TWILIO_BASE_URL", basic: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], form: true },
  vercel: { title: "Vercel", binding: "VERCEL_BASE_URL", token: "VERCEL_TOKEN" },
};

const OAUTH = {
  apple: { authorize: "/auth/authorize", token: "/auth/token", scope: "openid email name", test: "/auth/keys" },
  clerk: { authorize: "/oauth/authorize", token: "/oauth/token", scope: "openid email profile", test: "/oauth/userinfo" },
  github: { authorize: "/login/oauth/authorize", token: "/login/oauth/access_token", scope: "repo read:user user:email", test: "/user" },
  google: { authorize: "/o/oauth2/v2/auth", token: "/oauth2/token", scope: "openid email profile", test: "/oauth2/v2/userinfo" },
  linear: { authorize: "/oauth/authorize", token: "/oauth/token", scope: "read write", test: "/graphql" },
  microsoft: { authorize: "/oauth2/v2.0/authorize", token: "/oauth2/v2.0/token", scope: "openid email profile User.Read", test: "/v1.0/me" },
  okta: { authorize: "/oauth2/default/v1/authorize", token: "/oauth2/default/v1/token", scope: "openid email profile", test: "/oauth2/default/v1/userinfo" },
  slack: { authorize: "/oauth/v2/authorize", token: "/api/oauth.v2.access", scope: "channels:read channels:history users:read chat:write", test: "/api/auth.test" },
  vercel: { authorize: "/oauth/authorize", token: "/login/oauth/token", scope: "user", test: "/login/oauth/userinfo" },
};

const PUBLIC_PATH = /(?:^|\/)(?:\.well-known|oauth|authorize|token|register|introspect|revoke)(?:\/|$)|^\/auth\/(?:keys|authorize|token)|^\/checkout\//;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function gatewayUrl(provider, path) {
  if (provider === "google" && /^\/(?:gmail|calendar|drive)\//.test(path)) return `{{WORKBENCH_URL}}${path}`;
  const prefix = provider === "resend" ? "email" : provider;
  return `{{WORKBENCH_URL}}/${prefix}${path}`;
}

function postmanPath(path) {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)(?:\{[^}]*\})?/g, "{{$1}}");
}

function providerAuth(provider, config, path) {
  if (PUBLIC_PATH.test(path)) return undefined;
  if (provider === "notion" && path.startsWith("/admin/") && config.adminToken) return bearer(config.adminToken);
  if (config.basic) return basic(...config.basic);
  return config.token ? bearer(config.token) : undefined;
}

function routeBody(provider, config, method, path) {
  const providerHeaders = provider === "notion" && (path.startsWith("/v1/") || path.startsWith("/admin/"))
    ? [header("Notion-Version", path.startsWith("/admin/") ? "2026-06-01" : "2026-03-11")]
    : [];
  if (!BODY_METHODS.has(method)) return providerHeaders.length ? { headers: providerHeaders } : {};
  return config.form
    ? { headers: [...providerHeaders, header("Content-Type", "application/x-www-form-urlencoded")], body: formBody({}) }
    : { headers: [...providerHeaders, header("Content-Type", "application/json")], body: jsonBody({}) };
}

function routeRequests(provider, values) {
  const config = { ...PROVIDERS[provider], ...(provider === "notion" && values.NOTION_ADMIN_TOKEN ? { adminToken: "NOTION_ADMIN_TOKEN" } : {}) };
  const routes = PROVIDER_ROUTES[provider].map(({ method, path }) => request(`${method} ${path}`, method,
    gatewayUrl(provider, postmanPath(path)), {
      auth: providerAuth(provider, config, path),
      ...routeBody(provider, config, method, path),
      description: path.startsWith("/__worldfixture/") || path.startsWith("/_twilio/")
        ? "A local simulator control. This is not a production provider route."
        : "A route supported by the local provider emulator.",
    }));
  const oauth = OAUTH[provider], prefix = provider.toUpperCase();
  if (!oauth || !values[`${prefix}_CLIENT_ID`] || !values[`${prefix}_CLIENT_SECRET`]) return routes;
  const oauth2 = [
    { key: "tokenName", value: `${config.title} — current WorldFixture run`, type: "string" },
    { key: "grant_type", value: "authorization_code", type: "string" },
    { key: "authUrl", value: gatewayUrl(provider, oauth.authorize), type: "string" },
    { key: "accessTokenUrl", value: gatewayUrl(provider, oauth.token), type: "string" },
    { key: "clientId", value: `{{${prefix}_CLIENT_ID}}`, type: "string" },
    { key: "clientSecret", value: `{{${prefix}_CLIENT_SECRET}}`, type: "string" },
    { key: "scope", value: oauth.scope, type: "string" },
    { key: "redirect_uri", value: "https://oauth.pstmn.io/v1/browser-callback", type: "string" },
    { key: "useBrowser", value: true, type: "boolean" },
    { key: "addTokenTo", value: "header", type: "string" },
    { key: "client_authentication", value: "body", type: "string" },
  ];
  return [request("OAuth 2.0 — get a user token", "GET", gatewayUrl(provider, oauth.test), {
    auth: { type: "oauth2", oauth2 },
    description: "In Postman, open Authorization and select Get New Access Token. The callback URL is already registered for this run.",
  }), ...routes];
}

const AWS_ACTIONS = {
  iam: ["CreateUser", "GetUser", "DeleteUser", "ListUsers", "CreateAccessKey", "ListAccessKeys", "DeleteAccessKey", "CreateRole", "GetRole", "DeleteRole", "ListRoles"],
  sqs: ["CreateQueue", "DeleteQueue", "ListQueues", "GetQueueUrl", "GetQueueAttributes", "SendMessage", "ReceiveMessage", "DeleteMessage", "PurgeQueue"],
  sts: ["GetCallerIdentity", "AssumeRole"],
};

function awsRequests() {
  return Object.entries(AWS_ACTIONS).flatMap(([service, actions]) => actions.map(action => request(action, "POST",
    `{{WORKBENCH_URL}}/aws/${service}/`, { auth: bearer("AWS_TOKEN"),
      headers: [header("Content-Type", "application/x-www-form-urlencoded")],
      body: formBody({ Action: action, Version: service === "iam" ? "2010-05-08" : service === "sqs" ? "2012-11-05" : "2011-06-15" }),
    })));
}

function domainRequests() {
  const auth = bearer("DOMAIN_TOKEN"), json = [header("Content-Type", "application/json")];
  return [
    request("List collections", "GET", "{{WORKBENCH_URL}}/domain/v1/collections", { auth }),
    request("List collection records", "GET", "{{WORKBENCH_URL}}/domain/v1/collections/{{collection}}", { auth }),
    request("Read collection record", "GET", "{{WORKBENCH_URL}}/domain/v1/collections/{{collection}}/{{record_id}}", { auth }),
    request("Create collection record", "POST", "{{WORKBENCH_URL}}/domain/v1/collections/{{collection}}", { auth, headers: json, body: jsonBody({ actor_id: "{{actor_id}}", record: { id: "{{record_id}}" } }) }),
    request("Validate collection record", "POST", "{{WORKBENCH_URL}}/domain/v1/collections/{{collection}}/validate", { auth, headers: json, body: jsonBody({ actor_id: "{{actor_id}}", record: { id: "{{record_id}}" } }) }),
    request("Update collection record", "PATCH", "{{WORKBENCH_URL}}/domain/v1/collections/{{collection}}/{{record_id}}", { auth, headers: json, body: jsonBody({ actor_id: "{{actor_id}}", patch: {} }) }),
    request("Delete collection record", "DELETE", "{{WORKBENCH_URL}}/domain/v1/collections/{{collection}}/{{record_id}}", { auth, headers: json, body: jsonBody({ actor_id: "{{actor_id}}" }) }),
    request("List accepted events", "GET", "{{WORKBENCH_URL}}/domain/v1/events", { auth }),
  ];
}

function siteRequests(artifactPath) {
  const items = [request("OpenAPI document", "GET", "{{WORKBENCH_URL}}/site/openapi.json")];
  if (!artifactPath) return items;
  try {
    const projection = JSON.parse(readFileSync(join(artifactPath, "projections/http-targets.json"), "utf8"));
    for (const [path, operations] of Object.entries(projection.api?.document?.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations)) {
        items.push(request(operation.summary ?? `${method.toUpperCase()} ${path}`, method.toUpperCase(), `{{WORKBENCH_URL}}/site${postmanPath(path)}`));
      }
    }
  } catch {}
  return items;
}

function s3Auth() {
  return { type: "awsv4", awsv4: [
    { key: "accessKey", value: "{{S3_ACCESS_KEY_ID}}", type: "string" },
    { key: "secretKey", value: "{{S3_SECRET_ACCESS_KEY}}", type: "string" },
    { key: "region", value: "{{S3_REGION}}", type: "string" },
    { key: "service", value: "s3", type: "string" },
  ] };
}

function s3Requests() {
  const auth = s3Auth(), bucket = "{{S3_BASE_URL}}/{{S3_BUCKET}}";
  return [
    request("List buckets", "GET", "{{S3_BASE_URL}}/", { auth }),
    request("Create bucket", "PUT", bucket, { auth }),
    request("Delete bucket", "DELETE", bucket, { auth }),
    request("List objects", "GET", `${bucket}/?list-type=2`, { auth }),
    request("Read object", "GET", `${bucket}/{{object_key}}`, { auth }),
    request("Write object", "PUT", `${bucket}/{{object_key}}`, { auth, body: { mode: "raw", raw: "WorldFixture Postman object" } }),
    request("Delete object", "DELETE", `${bucket}/{{object_key}}`, { auth }),
  ];
}

function workbenchRequests() {
  return [
    request("List active gateway paths", "GET", "{{WORKBENCH_URL}}/api/gateway"),
    request("Read session", "GET", "{{WORKBENCH_URL}}/api/session"),
    request("Read world overview", "GET", "{{WORKBENCH_URL}}/api/overview"),
    request("Read world clock", "GET", "{{WORKBENCH_URL}}/api/clock"),
    request("Read timeline", "GET", "{{WORKBENCH_URL}}/api/timeline"),
    request("List available worlds", "GET", "{{WORKBENCH_URL}}/api/worlds"),
  ];
}

const VARIABLE_DEFAULTS = {
  accountSid: "{{TWILIO_ACCOUNT_SID}}", userId: "me", calendarId: "primary", actor_id: "maya-chen",
  collection: "identity.people", record_id: "maya-chen", object_key: "postman/example.txt",
  owner: "northstar-relay", username: "maya-chen",
};

export function postmanCollection({ world, bindings, workbenchUrl, artifactPath }) {
  const values = { ...bindings, WORKBENCH_URL: bindings.WORKBENCH_URL ?? workbenchUrl };
  const items = [folder("WorldFixture", workbenchRequests(), "Workbench API routes for this active run.")];

  for (const [provider, config] of Object.entries(PROVIDERS)) {
    if (values[config.binding]) items.push(folder(config.title, routeRequests(provider, values),
      `All ${PROVIDER_ROUTES[provider].length} registered HTTP routes for this selected provider.`));
  }
  if (values.AWS_BASE_URL) items.push(folder("AWS", awsRequests(), "All supported IAM, SQS, and STS actions."));
  if (values.DOMAIN_BASE_URL) items.push(folder("World records", domainRequests(), "All World records API operations."));
  if (values.SITE_BASE_URL) items.push(folder("World website API", siteRequests(artifactPath), "Every operation in this world's OpenAPI document."));
  if (values.S3_BASE_URL && values.S3_ACCESS_KEY_ID && values.S3_SECRET_ACCESS_KEY && values.S3_REGION) {
    items.push(folder("S3", s3Requests(), "Common S3 bucket and object operations use the direct run address and AWS Signature Version 4."));
  }

  const usedVariables = new Set([...JSON.stringify(items).matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map(match => match[1]));
  const variableValues = { ...VARIABLE_DEFAULTS, ...values };
  return {
    info: {
      name: `WorldFixture — ${world.title ?? `${world.id}:${world.version}`}`,
      description: "Generated by the active WorldFixture Workbench. It contains every registered HTTP route for the selected providers, the world's OpenAPI operations, and current local synthetic credentials. Download it again after a new run or world switch. SMTP, IMAP, PostgreSQL, and MySQL are not HTTP APIs and are not included. Some write requests need required fields before you send them.",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: items,
    variable: [...usedVariables].sort().map(key => ({ key, value: String(variableValues[key] ?? ""), type: "string" })),
  };
}
