import { createHash, randomUUID } from "node:crypto";

const MAX_SYNC_PAGES = 10_000;
const WEBHOOK_MAX_ATTEMPTS = 4;
const WEBHOOK_BLOCK_THRESHOLD = 5;
let processStateTail = Promise.resolve();

async function withExclusiveProcessState(operation) {
  const previous = processStateTail;
  let release;
  processStateTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertJson(value, label) {
  try {
    const encoded = JSON.stringify(value, (_key, item) => {
      if (["undefined", "function", "symbol", "bigint"].includes(typeof item)) {
        throw new TypeError("unsupported JSON value");
      }
      if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("non-finite JSON number");
      return item;
    });
    if (encoded === undefined) throw new TypeError("unsupported JSON value");
  } catch {
    throw new TypeError(`${label} must be JSON-serialisable.`);
  }
}

function normalizeHeaders(headers = {}) {
  const result = {};
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) result[String(name).toLowerCase()] = String(value);
  return result;
}

function parseBody(rawBody) {
  try {
    const value = JSON.parse(rawBody);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function oauthEnvKey(name) {
  return `OAUTH_${Buffer.from(name).toString("hex").toUpperCase()}_ACCESS_TOKEN`;
}

function webhookDeliveryId(key, method, rawBody, headers) {
  const digest = createHash("sha256")
    .update(JSON.stringify([key, method, rawBody, headers]))
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
}

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isClientErrorStatus(status) {
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function validateVerifyResponse(response) {
  if (!response || typeof response !== "object") throw new TypeError("A webhook verify handler must return a response object.");
  if (!isSuccessStatus(response.status) && !isClientErrorStatus(response.status)) {
    throw new RangeError("A webhook verify response status must be a 2xx or 4xx status.");
  }
  if (response.body !== undefined) {
    if (typeof response.body !== "string") throw new TypeError("A webhook verify response body must be a string.");
    if (Buffer.byteLength(response.body, "utf8") > 8 * 1024) throw new RangeError("A webhook verify response body must be at most 8 KB.");
  }
  if (response.contentType !== undefined && !["application/json", "text/plain"].includes(response.contentType)) {
    throw new TypeError("A webhook verify response contentType must be application/json or text/plain.");
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new TypeError("worker must expose a manifest.");
  if (!/^\d+\.\d+\.\d+/.test(manifest.sdkVersion ?? "")) throw new TypeError("worker manifest has no valid SDK version.");

  const keys = new Set();
  for (const item of [...manifest.databases, ...manifest.pacers, ...manifest.capabilities]) {
    if (keys.has(item.key)) throw new TypeError(`Worker item key "${item.key}" is not unique.`);
    keys.add(item.key);
  }

  const databaseKeys = new Set(manifest.databases.map(({ key }) => key));
  for (const database of manifest.databases) {
    if (!["managed", "attached"].includes(database.config.type)) {
      throw new TypeError(`Database "${database.key}" has an unsupported type.`);
    }
    if (!(database.config.primaryKeyProperty in database.config.schema.properties)) {
      throw new TypeError(`Database "${database.key}" primary key is not in its schema.`);
    }
  }
  for (const pacer of manifest.pacers) {
    if (!Number.isInteger(pacer.config.allowedRequests) || pacer.config.allowedRequests < 1) {
      throw new TypeError(`Pacer "${pacer.key}" allowedRequests must be a positive integer.`);
    }
    if (!Number.isInteger(pacer.config.intervalMs) || pacer.config.intervalMs < 1) {
      throw new TypeError(`Pacer "${pacer.key}" intervalMs must be a positive integer.`);
    }
  }
  for (const capability of manifest.capabilities) {
    if (capability._tag === "sync" && !databaseKeys.has(capability.config.databaseKey)) {
      throw new TypeError(`Sync "${capability.key}" refers to an unknown database.`);
    }
  }
}

function validateSyncChange(change, databases, mode) {
  if (!change || typeof change !== "object" || !["upsert", "delete"].includes(change.type)) {
    throw new TypeError("A sync change must be an upsert or delete.");
  }
  if (typeof change.key !== "string" || !change.key) throw new TypeError("A sync change key must be a non-empty string.");
  const database = databases.get(change.targetDatabaseKey);
  if (!database) throw new TypeError(`Sync change refers to unknown database "${change.targetDatabaseKey}".`);
  if (change.type === "delete") {
    if (mode !== "incremental") throw new TypeError("Delete changes are supported only by incremental syncs.");
    return;
  }

  if (!change.properties || typeof change.properties !== "object" || Array.isArray(change.properties)) {
    throw new TypeError("An upsert change must contain properties.");
  }
  const expected = Object.keys(database.config.schema.properties).sort();
  const received = Object.keys(change.properties).sort();
  const missing = expected.filter((name) => !received.includes(name));
  const unknown = received.filter((name) => !expected.includes(name));
  if (missing.length || unknown.length) {
    throw new TypeError(`Sync properties do not match database "${database.key}" schema (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`);
  }
  if (change.upstreamUpdatedAt !== undefined && Number.isNaN(Date.parse(change.upstreamUpdatedAt))) {
    throw new TypeError("upstreamUpdatedAt must be an ISO 8601 timestamp.");
  }
  assertJson(change, "Sync change");
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Run a real @notionhq/workers Worker against deterministic local platform state.
 * This is a package/runtime adapter. It does not add Notion REST endpoints.
 */
export function createNotionWorkersRuntime(worker, options = {}) {
  const manifest = worker?.manifest;
  validateManifest(manifest);

  const now = options.now ?? (() => new Date().toISOString());
  const makeId = options.randomUUID ?? randomUUID;
  const databases = new Map(manifest.databases.map((database) => [database.key, {
    key: database.key,
    config: clone(database.config),
    rows: new Map(),
  }]));
  const capabilities = new Map(manifest.capabilities.map((capability) => [capability.key, clone(capability)]));
  const syncState = new Map();
  const pacerState = Object.fromEntries(manifest.pacers.map((pacer) => [pacer.key, {
    lastScheduledAtMs: 0,
    allowedRequests: pacer.config.allowedRequests,
    intervalMs: pacer.config.intervalMs,
  }]));
  const oauthTokens = new Map(Object.entries(options.oauthTokens ?? {}));
  const queue = [];
  const runRecords = [];
  const verificationFailures = new Map();

  function capability(key, tag) {
    const value = capabilities.get(key);
    if (!value) throw new Error(`Capability "${key}" not found.`);
    if (tag && value._tag !== tag) throw new TypeError(`Capability "${key}" is ${value._tag}, not ${tag}.`);
    return value;
  }

  async function withEnvironment(operation) {
    return withExclusiveProcessState(async () => {
      const values = {
        NOTION_API_BASE_URL: options.notionBaseUrl,
        NOTION_API_TOKEN: options.notionToken,
        NOTION_INPUT_PAYLOAD_PATH: undefined,
      };
      for (const oauth of manifest.capabilities.filter(({ _tag }) => _tag === "oauth")) {
        values[oauthEnvKey(oauth.config.name)] = oauthTokens.get(oauth.key);
      }
      const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
      const previousDateNow = Date.now;
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (options.dateNow) Date.now = options.dateNow;
      try {
        return await operation();
      } finally {
        Date.now = previousDateNow;
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  }

  function record(kind, key, status, details = {}) {
    const value = { id: makeId(), kind, capability_key: key, status, created_at: now(), ...clone(details) };
    runRecords.push(value);
    return value;
  }

  async function runTool(key, input) {
    capability(key, "tool");
    try {
      const output = await withEnvironment(() => worker.run(key, clone(input), { concreteOutput: true }));
      assertJson(output, "Tool output");
      record("tool", key, "succeeded", { input, output });
      return output;
    } catch (error) {
      record("tool", key, "failed", { input, error: errorRecord(error) });
      throw error;
    }
  }

  function applyChange(change, seen) {
    const database = databases.get(change.targetDatabaseKey);
    if (!seen.has(database.key)) seen.set(database.key, new Set());
    if (change.type === "delete") {
      database.rows.delete(change.key);
      return;
    }

    seen.get(database.key).add(change.key);
    const current = database.rows.get(change.key);
    if (current?.upstreamUpdatedAt && change.upstreamUpdatedAt && Date.parse(current.upstreamUpdatedAt) > Date.parse(change.upstreamUpdatedAt)) return;
    database.rows.set(change.key, clone({
      key: change.key,
      properties: change.properties,
      ...(change.upstreamUpdatedAt !== undefined ? { upstreamUpdatedAt: change.upstreamUpdatedAt } : {}),
      ...(change.icon !== undefined ? { icon: change.icon } : {}),
      ...(change.cover !== undefined ? { cover: change.cover } : {}),
      ...(change.pageContentMarkdown !== undefined ? { pageContentMarkdown: change.pageContentMarkdown } : {}),
    }));
  }

  async function runSync(key) {
    const definition = capability(key, "sync");
    const mode = definition.config.mode ?? "replace";
    const seen = new Map([[definition.config.databaseKey, new Set()]]);
    let state = syncState.get(key);
    let pages = 0;
    const results = [];
    try {
      while (true) {
        if (++pages > MAX_SYNC_PAGES) throw new Error(`Sync "${key}" exceeded ${MAX_SYNC_PAGES} pages.`);
        const result = await withEnvironment(() => worker.run(key, {
          userContext: clone(state),
          pacers: clone(pacerState),
        }, { concreteOutput: true }));
        if (!result || typeof result !== "object" || !Array.isArray(result.changes) || typeof result.hasMore !== "boolean") {
          throw new TypeError("A sync must return changes and hasMore.");
        }
        if (result.hasMore && result.nextUserContext === undefined) {
          throw new TypeError("A paginated sync must return nextState when hasMore is true.");
        }
        if (result.nextUserContext !== undefined) assertJson(result.nextUserContext, "Sync state");
        for (const change of result.changes) validateSyncChange(change, databases, mode);
        for (const change of result.changes) applyChange(change, seen);
        Object.assign(pacerState, clone(result.nextPacerStates ?? {}));
        results.push(clone(result));
        state = result.nextUserContext;
        if (!result.hasMore) break;
      }

      if (mode === "replace") {
        for (const [databaseKey, keys] of seen) {
          const database = databases.get(databaseKey);
          for (const rowKey of database.rows.keys()) if (!keys.has(rowKey)) database.rows.delete(rowKey);
        }
      }
      syncState.set(key, clone(state));
      record("sync", key, "succeeded", { pages, state, change_count: results.reduce((sum, result) => sum + result.changes.length, 0) });
      return { pages, state: clone(state), results };
    } catch (error) {
      record("sync", key, "failed", { pages, error: errorRecord(error) });
      throw error;
    }
  }

  async function receiveWebhook(key, request = {}) {
    const definition = capability(key, "webhook");
    const method = String(request.method ?? "POST").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method) || (method !== "POST" && !definition.config.hasVerify)) {
      return { status: 405, body: "Method Not Allowed", contentType: "text/plain", queued: false };
    }
    if ((verificationFailures.get(key) ?? 0) >= WEBHOOK_BLOCK_THRESHOLD) {
      return { status: 403, body: "Webhook blocked after consecutive verification failures.", contentType: "text/plain", queued: false };
    }

    const rawBody = String(request.rawBody ?? "");
    const headers = normalizeHeaders(request.headers);
    const url = String(request.url ?? `https://www.notion.com/webhooks/worker/local/local/local/${key}`);
    const event = {
      deliveryId: request.deliveryId ?? webhookDeliveryId(key, method, rawBody, headers),
      body: parseBody(rawBody),
      rawBody,
      headers,
      method,
    };

    let response = { status: 202, body: "", contentType: "text/plain" };
    if (definition.config.hasVerify) {
      try {
        response = await withEnvironment(() => worker.run(key, { request: {
          method,
          url,
          query: Object.fromEntries(new URL(url).searchParams),
          headers,
          rawBody,
        } }, { concreteOutput: true }));
        validateVerifyResponse(response);
      } catch (error) {
        if (error?.name === "WebhookVerificationError") verificationFailures.set(key, (verificationFailures.get(key) ?? 0) + 1);
        record("webhook_verify", key, "failed", { error: errorRecord(error) });
        throw error;
      }
      record("webhook_verify", key, isSuccessStatus(response.status) ? "succeeded" : "rejected", { response });
      if (!isSuccessStatus(response.status)) return { ...response, queued: false };
    }

    queue.push({ key, event, attempts: 0 });
    return { ...response, queued: true, deliveryId: event.deliveryId };
  }

  async function drainWebhooks() {
    const completed = [];
    while (queue.length) {
      const delivery = queue.shift();
      let final;
      while (delivery.attempts < WEBHOOK_MAX_ATTEMPTS) {
        delivery.attempts += 1;
        try {
          const output = await withEnvironment(() => worker.run(delivery.key, [clone(delivery.event)], { concreteOutput: true }));
          verificationFailures.set(delivery.key, 0);
          final = record("webhook", delivery.key, "succeeded", { delivery_id: delivery.event.deliveryId, attempts: delivery.attempts, output });
          break;
        } catch (error) {
          if (error?.name === "WebhookVerificationError") {
            verificationFailures.set(delivery.key, (verificationFailures.get(delivery.key) ?? 0) + 1);
            final = record("webhook", delivery.key, "verification_failed", { delivery_id: delivery.event.deliveryId, attempts: delivery.attempts, error: errorRecord(error) });
            break;
          }
          if (delivery.attempts === WEBHOOK_MAX_ATTEMPTS) {
            final = record("webhook", delivery.key, "failed", { delivery_id: delivery.event.deliveryId, attempts: delivery.attempts, error: errorRecord(error) });
          }
        }
      }
      completed.push(final);
    }
    return completed;
  }

  function setOAuthAccessToken(key, token) {
    capability(key, "oauth");
    if (typeof token !== "string" || !token) throw new TypeError("OAuth access token must be a non-empty string.");
    oauthTokens.set(key, token);
  }

  function databaseRows(key) {
    const database = databases.get(key);
    if (!database) throw new Error(`Database "${key}" not found.`);
    return [...database.rows.values()].map(clone).sort((left, right) => left.key.localeCompare(right.key));
  }

  return {
    manifest: clone(manifest),
    runTool,
    runSync,
    receiveWebhook,
    drainWebhooks,
    setOAuthAccessToken,
    databaseRows,
    runs: () => runRecords.map(clone),
    pendingWebhooks: () => queue.map(clone),
    syncState: (key) => clone(syncState.get(key)),
    pacerState: () => clone(pacerState),
  };
}

export const notionWorkersRuntimeLimits = Object.freeze({
  maxSyncPages: MAX_SYNC_PAGES,
  webhookMaxAttempts: WEBHOOK_MAX_ATTEMPTS,
  webhookBlockThreshold: WEBHOOK_BLOCK_THRESHOLD,
});
