import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchema, validate } from "./schema.mjs";
import { DEFAULT_SCALE, scaleWorld } from "./scale.mjs";
import { packsReference } from "./packs-doc.mjs";

export const CONNECTOR_VERSION = "worldfixture.connector/v1";
export const REQUEST_VERSION = "worldfixture.connector-request/v1";
export const EVENT_VERSION = "worldfixture.application-event/v1";
export const DISCOVERY_PATH = "/.well-known/worldfixture";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONNECTOR_DOCS = ["overview.md", "protocol-v1.md", "packs.md", "security.md", "mapping-guide.md", "project.md", "agent-guide.md"]
  .map((name) => join(ROOT, "docs/connectors", name));

// The response shapes, and why they are checked here.
//
// `protocol-v1.md` says the JSON Schemas are authoritative and then describes
// the responses in prose, and the prose left fields out: it never named
// `mappings` on a plan or `status` on a receipt, both of which the schema
// requires. A connector written from the prose therefore passed `connector
// check` -- which only ever looked at `api_version` -- and then crashed the
// Workbench on `plan.mappings.map`, in the browser, with a stack trace naming a
// React component. That is the worst possible place for a protocol mismatch to
// surface, and the furthest from the person who can fix it.
//
// So the responses are checked against the schemas that were always meant to be
// authoritative, and the mismatch is reported by field name in the terminal.
const RESPONSE_SCHEMAS = {
  discovery: "connector-discovery.v1.schema.json",
  plan: "connector-plan.v1.schema.json",
  seed: "connector-receipt.v1.schema.json",
  event: "connector-receipt.v1.schema.json",
  status: "connector-status.v1.schema.json",
};

const schemaCache = new Map();

function responseSchema(name) {
  if (!schemaCache.has(name)) {
    schemaCache.set(name, loadSchema(join(ROOT, "schemas", RESPONSE_SCHEMAS[name])));
  }
  return schemaCache.get(name);
}

export function connectorResponseErrors(value, name) {
  if (!RESPONSE_SCHEMAS[name]) return [];
  try {
    return validate(value, responseSchema(name));
  } catch (error) {
    // A fault in OUR schema is not the application's fault, and it must never
    // take down a command that otherwise succeeded. Reported as a finding
    // against WorldFixture, in the place a reader is already looking.
    return [`WorldFixture could not check this response: ${error.message}`];
  }
}

const DEFAULT_ENDPOINTS = {
  plan: "/__worldfixture/plan",
  seed: "/__worldfixture/seed",
  event: "/__worldfixture/events",
  status: "/__worldfixture/status",
  reset: "/__worldfixture/reset",
};

export class ConnectorError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.detail = detail;
  }
}

export function applicationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("invalid_url", `${JSON.stringify(value)} is not an application URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ConnectorError("invalid_url", "the application URL must use HTTP or HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function endpoint(base, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new ConnectorError("invalid_discovery", `connector endpoint ${JSON.stringify(path)} must be an absolute path`);
  }
  return new URL(path, base);
}

async function responseJson(response) {
  const text = await response.text();
  let value = {};
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new ConnectorError("invalid_response", `${response.url} did not return JSON`, { status: response.status });
  }
  if (!response.ok) {
    throw new ConnectorError(
      "request_refused",
      value.error?.message ?? value.error ?? `${response.url} returned HTTP ${response.status}`,
      { status: response.status, value },
    );
  }
  return value;
}

async function call(url, { method = "GET", token, input, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (input !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ConnectorError("unreachable", `cannot reach ${url}: ${error.message}`);
  }
  return responseJson(response);
}

function validateDiscovery(value) {
  if (value?.api_version !== CONNECTOR_VERSION) {
    throw new ConnectorError(
      "unsupported_connector",
      `connector api_version is ${JSON.stringify(value?.api_version)}, expected ${CONNECTOR_VERSION}`,
    );
  }
  if (!value.application || typeof value.application.id !== "string" || typeof value.application.name !== "string") {
    throw new ConnectorError("invalid_discovery", "connector discovery needs application.id and application.name");
  }
  if (!value.capabilities || typeof value.capabilities !== "object") {
    throw new ConnectorError("invalid_discovery", "connector discovery needs capabilities");
  }
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(value.endpoints ?? {}) };
  for (const [name, supported] of Object.entries(value.capabilities)) {
    if (supported === true && !endpoints[name]) {
      throw new ConnectorError("invalid_discovery", `connector supports ${name} but declares no endpoint`);
    }
  }
  return { ...value, endpoints };
}

export async function discoverConnector(baseUrl, options = {}) {
  const base = applicationUrl(baseUrl);
  const value = await call(endpoint(base, DISCOVERY_PATH), options);
  return validateDiscovery(value);
}

export function readConnectorWorld(artifactPath) {
  const manifest = JSON.parse(readFileSync(join(artifactPath, "manifest.json"), "utf8"));
  const world = JSON.parse(readFileSync(join(artifactPath, "world.json"), "utf8"));
  const packs = {};
  for (const name of manifest.packs ?? []) {
    packs[name] = JSON.parse(readFileSync(join(artifactPath, "packs", `${name}.json`), "utf8"));
  }
  return {
    world: {
      id: manifest.world_id,
      version: manifest.world_version,
      artifact_sha256: manifest.artifact_sha256,
      title: world.title,
      clock: world.clock,
      synthetic: manifest.synthetic,
    },
    packs,
  };
}

// The world a connector operation sends.
//
// Reading and slicing are one step so that a caller can hold the result, print
// what it is about to send, and then send exactly that -- rather than slicing
// once to describe it and again to transmit it, which is two chances to describe
// a different world from the one that arrives.
export function connectorWorld(artifactPath, { scale = DEFAULT_SCALE, limits = {} } = {}) {
  return scaleWorld(readConnectorWorld(artifactPath), { scale, limits });
}

// The world being sent is the world that is running.
//
// THE BUG THIS CLOSES. The artifact a connector is seeded from and the artifact
// the emulators serve are resolved separately, and they can differ: `up` rebases
// the world onto today and writes the result into the run's state directory, an
// older published image does not write one at all, and anybody rebuilding
// `dist/` mid-session moves it underneath a running instance. Each case sends an
// application a world whose people, dates and ids are not the ones the Slack and
// mail surfaces are showing -- and derives `idempotency_key` from the wrong
// artifact, so two genuinely different worlds can share a key and the second
// seed is answered "already applied" and dropped.
//
// None of that announced itself. It has to, because every symptom of it looks
// like a bug in the connector.
export function assertWorldMatchesInstance(world, lock, { generation, expectedGeneration } = {}) {
  if (generation !== undefined || expectedGeneration !== undefined) {
    if (!generation || generation !== expectedGeneration) throw new ConnectorError('generation_mismatch', 'The selected world generation changed. Read the active world and try again.');
    if (!lock?.world?.artifact_sha256 || !world?.world?.artifact_sha256) throw new ConnectorError('artifact_identity_required', 'The active and selected artifacts must both have a verified identity.');
  }
  const running = lock?.world?.artifact_sha256;
  const sending = world?.world?.artifact_sha256;
  if (!running || !sending || running === sending) return;
  throw new ConnectorError(
    "artifact_mismatch",
    `this would seed artifact ${sending.slice(0, 12)}… into an application, ` +
      `but the running world is ${running.slice(0, 12)}…\n` +
      "The instance is serving a world this command cannot see. The usual cause is an image " +
      "older than this checkout: `up` rebases the world onto today into the run's state " +
      "directory, and an image built before that was added never writes one, so this command " +
      "falls back to the world in dist/. Rebuilding dist/ under a running instance does it too.\n" +
      "Pull or rebuild the image, then restart the instance so both agree:\n" +
      "  worldfixture down && worldfixture up",
    { running, sending },
  );
}

function sourceFor({ world, artifactPath, scale, limits }) {
  return world ?? connectorWorld(artifactPath, { scale, limits });
}

function requestEnvelope(world, options = {}) {
  return {
    api_version: REQUEST_VERSION,
    request_id: `req_${randomUUID().replaceAll("-", "")}`,
    world: world.world,
    packs: world.packs,
    // A connector is told how much of the world this is. Its plan can then say
    // "22 of 161 people" instead of reporting 22 people as though that were all
    // of them, which is the difference between a preview and a wrong preview.
    options: { ...(world.scale ? { scale: scaleOption(world.scale) } : {}), ...options },
  };
}

function scaleOption(scale) {
  return {
    preset: scale.preset,
    complete: scale.full === true,
    collections: scale.collections
      .filter((entry) => entry.total > 0)
      .map((entry) => ({ collection: entry.collection, sent: entry.kept, available: entry.total })),
  };
}

// A slice is its own seeding operation.
//
// The key has to change with the slice. Seeding `smoke` and then seeding `full`
// under one key would look to a correctly written connector like the same
// request arriving twice, and the second one -- the one that carries the rest of
// the world -- would be answered with the receipt for the first and dropped.
function idempotencyKey(world) {
  const base = `seed:${world.world.artifact_sha256}`;
  if (!world.scale || world.scale.full) return base;
  const shape = JSON.stringify(
    world.scale.collections.map((entry) => [entry.collection, entry.kept]).sort(),
  );
  return `${base}:${world.scale.preset}:${createHash("sha256").update(shape).digest("hex").slice(0, 12)}`;
}

async function connectorAction(baseUrl, discovery, name, { token, input, timeoutMs, fetchImpl } = {}) {
  if (discovery.capabilities[name] !== true) {
    throw new ConnectorError("unsupported_action", `${discovery.application.name} does not support ${name}`);
  }
  const value = await call(endpoint(applicationUrl(baseUrl), discovery.endpoints[name]), {
    method: name === "status" ? "GET" : "POST",
    token,
    input: name === "status" ? undefined : input,
    timeoutMs,
    fetchImpl,
  });

  // Reported, not thrown. By the time a seed responds the application has
  // already written the records, and refusing the receipt would leave the person
  // with a filled application and a failed command. `connector check` is where
  // the same finding is a failure.
  const errors = connectorResponseErrors(value, name);
  if (errors.length > 0) {
    Object.defineProperty(value, "schema_errors", { value: errors, enumerable: false });
  }
  return value;
}

export async function planConnector(baseUrl, { world, artifactPath, token, options, scale, limits } = {}) {
  const discovery = await discoverConnector(baseUrl);
  const input = requestEnvelope(sourceFor({ world, artifactPath, scale, limits }), { mode: "preview", ...options });
  return connectorAction(baseUrl, discovery, "plan", { token, input });
}

export async function seedConnector(baseUrl, { world, artifactPath, token, options, scale, limits } = {}) {
  const discovery = await discoverConnector(baseUrl);
  const source = sourceFor({ world, artifactPath, scale, limits });
  const input = requestEnvelope(source, { mode: "apply", ...options });
  input.idempotency_key = idempotencyKey(source);
  return connectorAction(baseUrl, discovery, "seed", { token, input, timeoutMs: 300_000 });
}

export async function deliverConnectorEvent(baseUrl, event, { token, fetchImpl } = {}) {
  if (!event || typeof event.event_id !== "string" || typeof event.kind !== "string") {
    throw new ConnectorError("invalid_event", "an application event needs event_id and kind");
  }
  if (!event.occurred_at || !Number.isFinite(Date.parse(event.occurred_at))) {
    throw new ConnectorError("invalid_event", "an application event needs an ISO-8601 occurred_at");
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new ConnectorError("invalid_event", "an application event needs an object in data");
  }
  const discovery = await discoverConnector(baseUrl, { fetchImpl });
  const input = {
    ...event,
    api_version: EVENT_VERSION,
    delivery_id: `delivery_${randomUUID().replaceAll("-", "")}`,
  };
  return connectorAction(baseUrl, discovery, "event", { token, input, fetchImpl });
}

export async function connectorStatus(baseUrl, { token } = {}) {
  const discovery = await discoverConnector(baseUrl);
  return connectorAction(baseUrl, discovery, "status", { token });
}

export async function resetConnector(baseUrl, { token } = {}) {
  const discovery = await discoverConnector(baseUrl);
  return connectorAction(baseUrl, discovery, "reset", {
    token,
    input: { api_version: REQUEST_VERSION, request_id: `req_${randomUUID().replaceAll("-", "")}` },
    timeoutMs: 120_000,
  });
}

export async function checkConnector(baseUrl, { world, artifactPath, token, scale, limits } = {}) {
  const source = sourceFor({ world, artifactPath, scale, limits });
  const checks = [];
  let discovery;
  try {
    discovery = await discoverConnector(baseUrl);
    checks.push({ name: "Discovery document", ok: true, detail: discovery.application.name });
  } catch (error) {
    return { ready: false, checks: [{ name: "Discovery document", ok: false, detail: error.message }] };
  }

  if (!token) {
    checks.push({ name: "Authenticated plan", ok: false, detail: "set WORLDFIXTURE_TOKEN or use --token" });
    return { ready: false, discovery, checks };
  }

  try {
    await connectorAction(baseUrl, discovery, "plan", {
      token: undefined,
      input: requestEnvelope(source, { mode: "preview" }),
    });
    checks.push({ name: "Token protection", ok: false, detail: "plan accepted a request without a token" });
  } catch (error) {
    const protectedStatus = error.detail?.status;
    checks.push({
      name: "Token protection",
      ok: protectedStatus === 401 || protectedStatus === 403,
      detail: protectedStatus === 401 || protectedStatus === 403 ? `HTTP ${protectedStatus}` : error.message,
    });
  }

  const discoveryErrors = connectorResponseErrors(discovery, "discovery");
  checks.push({
    name: "Discovery shape",
    ok: discoveryErrors.length === 0,
    detail: discoveryErrors.length === 0 ? "matches connector-discovery.v1" : discoveryErrors.join("; "),
  });

  try {
    const plan = await connectorAction(baseUrl, discovery, "plan", {
      token,
      input: requestEnvelope(source, { mode: "preview" }),
    });
    checks.push({ name: "Seed plan", ok: plan.api_version === "worldfixture.connector-plan/v1", detail: plan.summary ?? "plan returned" });
    const planErrors = plan.schema_errors ?? [];
    checks.push({
      name: "Plan shape",
      ok: planErrors.length === 0,
      detail: planErrors.length === 0 ? "matches connector-plan.v1" : planErrors.join("; "),
    });
  } catch (error) {
    checks.push({ name: "Seed plan", ok: false, detail: error.message });
  }

  try {
    const status = await connectorAction(baseUrl, discovery, "status", { token });
    checks.push({ name: "Status", ok: status.api_version === "worldfixture.connector-status/v1", detail: status.state ?? "status returned" });
    const statusErrors = status.schema_errors ?? [];
    checks.push({
      name: "Status shape",
      ok: statusErrors.length === 0,
      detail: statusErrors.length === 0 ? "matches connector-status.v1" : statusErrors.join("; "),
    });
  } catch (error) {
    checks.push({ name: "Status", ok: false, detail: error.message });
  }

  return { ready: checks.every((check) => check.ok), discovery, checks };
}

export function connectorPrompt(baseUrl, options = {}) {
  const reference = options.world || options.artifactPath ? packsReference(sourceFor(options)) : null;
  const url = applicationUrl(baseUrl).origin;
  return `Add a development-only WorldFixture connector to the application in the current directory at ${url}.

Read the connector documentation that matches the installed WorldFixture version. Run:

  worldfixture connector docs

${reference ? 'Use the selected-world "What a connector receives" reference included below for this mapping. It describes the same payload as connector plan and seed with the selected scale.' : 'Run connector docs with the same --world or --world-path, --state, --scale and --limit options as connector plan and seed. Read its generated "What a connector receives" section before you design the mapping.'}

Implement the documented Connector v1 HTTP contract inside this application. Inspect the application's domain models, migrations, ORM, authentication, service layer, existing seed tools, tests, build commands, and all local service dependencies. Map WorldFixture records to the existing domain model. Do not create a parallel domain model.

Keep the application's normal development command and database lifecycle. Do not make WorldFixture install dependencies, run migrations, or start the app. Reuse WorldFixture-provided database, S3, or SMTP only when the user requests those optional services in .worldfixture/project.json. If the existing app-owned services are sufficient, leave the services list empty.

Support discovery, planning, deterministic and idempotent baseline seeding, live event delivery, application reference receipts, and status. The connector must declare reset unavailable for every application database. Normal world reset must preserve application database data, including data in a WorldFixture-supplied database. Keep the connector disabled in production and require WORLDFIXTURE_TOKEN for every operation other than limited discovery.

For local development, make the connector load the token at runtime from WORLDFIXTURE_TOKEN or the ignored .worldfixture/token file in the app root. During implementation and tests, do not open, read, print, copy, or expose the token value. Tests must use a separate dummy token. Never commit the token or copy it into an image layer. Keep token-file loading disabled in production.

Run this conformance check and fix all failures:

  worldfixture connector check ${url}

Add tests for the mapping, a repeated seed request, repeated event delivery, authentication, and the normal application page after seed. When finished, report service bindings, the start command, application URL, entity mapping, event mapping, unmapped records, reset support, verification results, and changed files.${reference ? `\n\n${reference}` : ""}`;
}

export function connectorDocumentation(options = {}) {
  const reference = options.world || options.artifactPath ? packsReference(sourceFor(options)) : null;
  return CONNECTOR_DOCS.map(path => path.endsWith("/packs.md") && reference
    ? reference.trim() : readFileSync(path, "utf8").trim()).join("\n\n---\n\n") + "\n";
}
