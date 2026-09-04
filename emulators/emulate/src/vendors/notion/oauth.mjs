import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { escapeAttr, escapeHtml } from "@emulators/core";

const ACCESS_SECONDS = 8 * 60 * 60;

function named(store, name, indexes) {
  return store.collection(`notion_${name}`, indexes);
}

function next(store, kind) {
  const key = `notion_oauth_counter_${kind}`;
  const value = (store.getData(key) ?? 0) + 1;
  store.setData(key, value);
  return `worldfixture_notion_${kind}_${String(value).padStart(6, "0")}`;
}

function metadata(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/token`,
    introspection_endpoint: `${baseUrl}/introspect`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["default"],
  };
}

function oauthError(c, code, description, status = 400) {
  return c.json({ error: code, error_description: description }, status);
}

function mediaType(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function equalString(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyS256(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return equalString(digest, challenge);
}

function clientAuth(c, body, client) {
  if (client.token_endpoint_auth_method === "none") {
    return !client.client_secret && equalString(body.client_id ?? "", client.client_id);
  }
  const basic = c.req.header("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
  if (client.token_endpoint_auth_method === "client_secret_basic" && basic) {
    const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":", 2);
    return equalString(id, client.client_id) && equalString(secret, client.client_secret);
  }
  return client.token_endpoint_auth_method === "client_secret_post"
    && equalString(body.client_id ?? "", client.client_id)
    && equalString(body.client_secret ?? "", client.client_secret);
}

function consentPage({ client, redirectUri, state, codeChallenge, codeChallengeMethod, scope, resource, users }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connect to Notion</title></head><body>
    <main><h1>Connect ${escapeHtml(client.client_name)}</h1>
    <p>Select the user who will connect the workspace.</p>
    <p>Requested access: ${escapeHtml(scope)}</p>
    <form method="post" action="/authorize">
      <input type="hidden" name="client_id" value="${escapeAttr(client.client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeAttr(redirectUri)}">
      <input type="hidden" name="state" value="${escapeAttr(state)}">
      <input type="hidden" name="scope" value="${escapeAttr(scope)}">
      <input type="hidden" name="resource" value="${escapeAttr(resource)}">
      <input type="hidden" name="code_challenge" value="${escapeAttr(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeAttr(codeChallengeMethod)}">
      <label>User <select name="user_id">${users.map((user) => `<option value="${escapeAttr(user.notion_id)}">${escapeHtml(user.name)} — ${escapeHtml(user.workspace_name)}</option>`).join("")}</select></label>
      <button name="decision" value="approve">Allow access</button>
      <button name="decision" value="deny">Cancel</button>
    </form></main></body></html>`;
}

function publicConsentPage({ client, redirectUri, state, users }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Add connection to Notion</title></head><body>
    <main><h1>Add ${escapeHtml(client.client_name)} to Notion</h1>
    <form method="post" action="/v1/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeAttr(client.client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeAttr(redirectUri)}">
      <input type="hidden" name="state" value="${escapeAttr(state)}">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="owner" value="user">
      <label>User <select name="user_id">${users.map((user) => `<option value="${escapeAttr(user.notion_id)}">${escapeHtml(user.name)} — ${escapeHtml(user.workspace_name)}</option>`).join("")}</select></label>
      <button name="decision" value="approve">Allow access</button>
      <button name="decision" value="deny">Cancel</button>
    </form></main></body></html>`;
}

export function registerOAuthRoutes(app, store, baseUrl, tokenMap) {
  const clients = named(store, "oauth_clients", ["client_id"]);
  const codes = named(store, "oauth_codes", ["code"]);
  const tokens = named(store, "oauth_tokens", ["token", "refresh_token"]);
  const users = named(store, "users", ["notion_id", "email"]);

  const resource = { resource: `${baseUrl}/mcp`, authorization_servers: [baseUrl], bearer_methods_supported: ["header"], scopes_supported: ["default"] };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/mcp/.well-known/oauth-protected-resource"]) {
    app.get(path, (c) => c.json(resource));
  }
  app.get("/.well-known/oauth-authorization-server", (c) => c.json(metadata(baseUrl)));
  app.get("/.well-known/mcp.json", (c) => c.json({ name: "Notion", description: "WorldFixture Notion MCP", endpoint: `${baseUrl}/mcp` }));

  function basicClient(c) {
    const encoded = c.req.header("authorization")?.match(/^Basic\s+(.+)$/i)?.[1];
    if (!encoded) return null;
    const [id, secret] = Buffer.from(encoded, "base64").toString("utf8").split(":", 2);
    const client = clients.findOneBy("client_id", id);
    return client?.client_secret && equalString(secret ?? "", client.client_secret) ? client : null;
  }

  function publicTokenResult(grant, user) {
    const workspace = store.getData("notion_workspace") ?? { id: "worldfixture-notion-workspace", name: "WorldFixture" };
    return {
      access_token: grant.token, token_type: "bearer", refresh_token: grant.refresh_token, bot_id: user.notion_id,
      workspace_icon: null, workspace_name: workspace.name, workspace_id: workspace.id,
      owner: { type: "user", user: { object: "user", id: user.notion_id, type: "person", name: user.name, avatar_url: user.avatar_url ?? null, person: { email: user.email } } },
      duplicated_template_id: null, request_id: randomUUID(),
    };
  }

  app.post("/register", async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return oauthError(c, "invalid_client_metadata", "The request body is not valid JSON."); }
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      return oauthError(c, "invalid_redirect_uri", "At least one redirect URI is required.");
    }
    const authMethod = body.token_endpoint_auth_method ?? "none";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(authMethod)) {
      return oauthError(c, "invalid_client_metadata", "token_endpoint_auth_method is not supported.");
    }
    const record = clients.insert({
      client_id: next(store, "client"),
      client_secret: authMethod === "none" ? null : next(store, "secret"),
      client_name: body.client_name ?? "MCP client",
      redirect_uris: [...new Set(body.redirect_uris.map(String))],
      token_endpoint_auth_method: authMethod,
    });
    return c.json({
      client_id: record.client_id,
      ...(record.client_secret ? { client_secret: record.client_secret } : {}),
      client_name: record.client_name,
      redirect_uris: record.redirect_uris,
      token_endpoint_auth_method: record.token_endpoint_auth_method,
    }, 201);
  });

  async function authorize(c, form) {
    const client = clients.findOneBy("client_id", form.client_id);
    if (!client) return oauthError(c, "invalid_request", "Unknown client_id.");
    if (!client.redirect_uris.includes(form.redirect_uri)) return oauthError(c, "invalid_request", "redirect_uri is not registered.");
    if (form.response_type && form.response_type !== "code") return oauthError(c, "unsupported_response_type", "Only response_type=code is supported.");
    if (form.code_challenge_method !== "S256" || !form.code_challenge) return oauthError(c, "invalid_request", "PKCE S256 is required.");
    if (form.resource !== `${baseUrl}/mcp`) return oauthError(c, "invalid_target", "resource must identify this MCP endpoint.");
    const availableUsers = users.all();
    if (availableUsers.length === 0) return oauthError(c, "temporarily_unavailable", "The fixture has no Notion user.", 503);
    if (!Object.hasOwn(form, "decision")) {
      return c.html(consentPage({ client, redirectUri: form.redirect_uri, state: form.state ?? "", codeChallenge: form.code_challenge, codeChallengeMethod: form.code_challenge_method, scope: form.scope ?? "default", resource: form.resource, users: availableUsers }));
    }
    const redirect = new URL(form.redirect_uri);
    if (form.state) redirect.searchParams.set("state", form.state);
    if (form.decision !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      return c.redirect(redirect.toString());
    }
    const actor = users.findOneBy("notion_id", form.user_id);
    if (!actor) return oauthError(c, "invalid_request", "Select a valid Notion user.");
    const code = next(store, "code");
    codes.insert({ code, client_id: client.client_id, redirect_uri: form.redirect_uri, code_challenge: form.code_challenge, user_id: actor.notion_id, used: false, scope: form.scope ?? "default", resource: form.resource });
    redirect.searchParams.set("code", code);
    return c.redirect(redirect.toString());
  }

  app.get("/authorize", (c) => authorize(c, Object.fromEntries(new URL(c.req.url).searchParams)));
  app.post("/authorize", async (c) => authorize(c, await c.req.parseBody()));

  app.post("/token", async (c) => {
    if (mediaType(c.req.header("Content-Type")) !== "application/x-www-form-urlencoded") {
      return oauthError(c, "invalid_request", "Content-Type must be application/x-www-form-urlencoded.", 415);
    }
    const body = await c.req.parseBody();
    if (body.grant_type === "authorization_code") {
      const code = codes.findOneBy("code", body.code);
      if (!code || code.used) return oauthError(c, "invalid_grant", "Authorization code is invalid or was used.");
      const client = clients.findOneBy("client_id", body.client_id ?? code.client_id);
      if (!client || client.client_id !== code.client_id || !clientAuth(c, body, client)) return oauthError(c, "invalid_client", "Client authentication failed.", 401);
      if (body.redirect_uri !== code.redirect_uri || body.resource !== code.resource || !verifyS256(body.code_verifier, code.code_challenge)) return oauthError(c, "invalid_grant", "Authorization code validation failed.");
      codes.update(code.id, { used: true });
      const user = users.findOneBy("notion_id", code.user_id);
      const accessToken = next(store, "access");
      const refreshToken = next(store, "refresh");
      tokens.insert({ token: accessToken, refresh_token: refreshToken, client_id: client.client_id, user_id: user.notion_id, active: true, kind: "mcp", scope: code.scope, resource: code.resource, generation: 1, iat: Math.floor(Date.now() / 1000), expires_at: Date.now() + ACCESS_SECONDS * 1000 });
      tokenMap.set(accessToken, { login: user.email, id: user.id, scopes: ["default"] });
      return c.json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refreshToken, scope: code.scope, user_id: user.notion_id, workspace_id: "worldfixture-notion-workspace", email_domain: user.email.split("@")[1] });
    }
    if (body.grant_type === "refresh_token") {
      const old = tokens.findOneBy("refresh_token", body.refresh_token);
      if (!old || !old.active) return oauthError(c, "invalid_grant", "Refresh token is invalid.");
      const client = clients.findOneBy("client_id", body.client_id ?? old.client_id);
      if (!client || client.client_id !== old.client_id || !clientAuth(c, body, client)) return oauthError(c, "invalid_client", "Client authentication failed.", 401);
      if (body.resource !== old.resource) return oauthError(c, "invalid_target", "resource must match the original grant.");
      const user = users.findOneBy("notion_id", old.user_id);
      tokenMap.delete(old.token);
      tokens.update(old.id, { active: false });
      const accessToken = next(store, "access");
      const refreshToken = next(store, "refresh");
      tokens.insert({ token: accessToken, refresh_token: refreshToken, client_id: client.client_id, user_id: user.notion_id, active: true, kind: "mcp", scope: old.scope, resource: old.resource, generation: old.generation + 1, iat: Math.floor(Date.now() / 1000), expires_at: Date.now() + ACCESS_SECONDS * 1000 });
      tokenMap.set(accessToken, { login: user.email, id: user.id, scopes: ["default"] });
      return c.json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refreshToken, scope: old.scope });
    }
    if (!body.grant_type && body.token) {
      const grant = tokens.findOneBy("token", body.token) ?? tokens.findOneBy("refresh_token", body.token);
      if (grant) {
        tokens.update(grant.id, { active: false });
        tokenMap.delete(grant.token);
      }
      return c.body(null, 200);
    }
    return oauthError(c, "unsupported_grant_type", "The grant type is not supported.");
  });

  app.post("/introspect", async (c) => {
    const body = await c.req.parseBody();
    const token = tokens.findOneBy("token", body.token) ?? tokens.findOneBy("refresh_token", body.token);
    return c.json(token?.active && (!token.expires_at || token.expires_at > Date.now()) ? { active: true, client_id: token.client_id, scope: token.scope, sub: token.user_id, token_type: "Bearer" } : { active: false });
  });

  async function publicAuthorize(c, form) {
    const client = clients.findOneBy("client_id", form.client_id);
    if (!client || !client.client_secret) return oauthError(c, "invalid_request", "Unknown public connection client_id.");
    const redirectUri = form.redirect_uri ?? client.redirect_uris[0];
    if (!client.redirect_uris.includes(redirectUri) || form.response_type !== "code" || form.owner !== "user") return oauthError(c, "invalid_request", "The public connection authorization request is not valid.");
    if (!Object.hasOwn(form, "decision")) return c.html(publicConsentPage({ client, redirectUri, state: form.state ?? "", users: users.all() }));
    const redirect = new URL(redirectUri);
    if (form.state) redirect.searchParams.set("state", form.state);
    if (form.decision !== "approve") { redirect.searchParams.set("error", "access_denied"); return c.redirect(redirect.toString()); }
    const user = users.findOneBy("notion_id", form.user_id);
    if (!user) return oauthError(c, "invalid_request", "Select a valid Notion user.");
    const code = next(store, "public_code");
    codes.insert({ code, client_id: client.client_id, redirect_uri: redirectUri, user_id: user.notion_id, used: false, public_connection: true, scope: "read:user read:content insert:content update:content read:comment insert:comment" });
    redirect.searchParams.set("code", code);
    return c.redirect(redirect.toString());
  }

  app.get("/v1/oauth/authorize", (c) => publicAuthorize(c, Object.fromEntries(new URL(c.req.url).searchParams)));
  app.post("/v1/oauth/authorize", async (c) => publicAuthorize(c, await c.req.parseBody()));

  app.post("/v1/oauth/token", async (c) => {
    if (c.req.header("Notion-Version") !== "2026-03-11") return oauthError(c, "invalid_request", "Notion-Version must be 2026-03-11.");
    const client = basicClient(c);
    if (!client) return oauthError(c, "invalid_client", "Client authentication failed.", 401);
    const body = await c.req.json().catch(() => null);
    if (!body) return oauthError(c, "invalid_request", "The request body is not valid JSON.");
    let user;
    let generation = 1;
    let scope;
    if (body.grant_type === "authorization_code") {
      const code = codes.findOneBy("code", body.code);
      if (!code?.public_connection || code.used || code.client_id !== client.client_id || body.redirect_uri !== undefined && body.redirect_uri !== code.redirect_uri) return oauthError(c, "invalid_grant", "Authorization code validation failed.");
      codes.update(code.id, { used: true });
      user = users.findOneBy("notion_id", code.user_id);
      scope = code.scope;
    } else if (body.grant_type === "refresh_token") {
      const old = tokens.findOneBy("refresh_token", body.refresh_token);
      if (!old?.active || old.kind !== "rest" || old.client_id !== client.client_id) return oauthError(c, "invalid_grant", "Refresh token is invalid.");
      tokens.update(old.id, { active: false });
      tokenMap.delete(old.token);
      user = users.findOneBy("notion_id", old.user_id);
      generation = old.generation + 1;
      scope = old.scope;
    } else return oauthError(c, "unsupported_grant_type", "The grant type is not supported.");
    const accessToken = next(store, "public_access");
    const refreshToken = next(store, "public_refresh");
    const grant = tokens.insert({ token: accessToken, refresh_token: refreshToken, client_id: client.client_id, user_id: user.notion_id, active: true, kind: "rest", scope, generation, iat: Math.floor(Date.now() / 1000), expires_at: null });
    tokenMap.set(accessToken, { login: user.email, id: user.id, scopes: scope.split(" ") });
    return c.json(publicTokenResult(grant, user));
  });

  app.post("/v1/oauth/introspect", async (c) => {
    if (c.req.header("Notion-Version") !== "2026-03-11" || !basicClient(c)) return oauthError(c, "invalid_client", "Client authentication failed.", 401);
    const body = await c.req.json().catch(() => null);
    const grant = body?.token ? tokens.findOneBy("token", body.token) ?? tokens.findOneBy("refresh_token", body.token) : null;
    return c.json(grant?.active && grant.kind === "rest" ? { active: true, scope: grant.scope, iat: grant.iat, request_id: randomUUID() } : { active: false, request_id: randomUUID() });
  });

  app.post("/v1/oauth/revoke", async (c) => {
    if (c.req.header("Notion-Version") !== "2026-03-11" || !basicClient(c)) return oauthError(c, "invalid_client", "Client authentication failed.", 401);
    const body = await c.req.json().catch(() => null);
    const grant = body?.token ? tokens.findOneBy("token", body.token) ?? tokens.findOneBy("refresh_token", body.token) : null;
    if (grant?.kind === "rest") { tokens.update(grant.id, { active: false }); tokenMap.delete(grant.token); }
    return c.json({ request_id: randomUUID() });
  });
}
