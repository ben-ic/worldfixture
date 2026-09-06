import { createHash, randomUUID } from "node:crypto";
import { getGoogleStore } from "@emulators/google";
import { createWebhookTransport } from "./transport.mjs";

const CONFIG = "worldfixture.google.webhook_config";
const CHANNELS = "worldfixture.google.channels";
const CHANGES = "worldfixture.google.drive_changes";
const RETRY_CODES = new Set([500, 502, 503, 504]);
const SUCCESS_CODES = new Set([200, 201, 202, 204, 102]);
const EVENT_TYPES = new Set(["birthday", "default", "focusTime", "fromGmail", "outOfOffice", "workingLocation"]);
const channels = store => store.collection(CHANNELS, ["channel_id", "owner"]);
const changes = store => store.collection(CHANGES, ["owner"]);
const config = store => store.getData(CONFIG) ?? {};
const enabled = store => config(store).live_delivery === true || process.env.WORLDFIXTURE_GOOGLE_WEBHOOK_DELIVERY === "1";
const error = (c, code, message) => c.json({ error: { code, message,
  errors: [{ message, domain: "global", reason: code === 404 ? "notFound" : code === 401 ? "authError" : "invalid" }] } }, code);
const publicChannel = channel => ({ kind: "api#channel", id: channel.channel_id,
  resourceId: channel.resource_id, resourceUri: channel.resource_uri,
  ...(channel.token !== undefined ? { token: channel.token } : {}), expiration: String(channel.expiration) });
const driveFile = record => ({ kind: "drive#file", id: record.google_id, name: record.name,
  mimeType: record.mime_type, parents: record.parent_google_ids, trashed: record.trashed ?? false,
  modifiedTime: record.modified_time ?? record.updated_at });
const snapshot = collection => new Map(collection.all().map(record => [record.id, structuredClone(record)]));
const tokenDigest = value => createHash("sha256").update(value ?? "").digest("hex");

export function wrapGoogleWebhooks(upstream, upstreamSeed, options = {}) {
  return {
    plugin: { ...upstream, register(app, store, webhooks, ...args) {
      const gs = getGoogleStore(store);
      const tokenClients = () => store.getData("worldfixture.google.webhook_token_clients") ?? {};
      const clientFor = c => tokenClients()[tokenDigest(c.get("authToken"))] ?? c.get("authUser")?.client_id ?? "fixture";
      app.use("/oauth2/token", async (c, next) => {
        if (c.req.method !== "POST") return next();
        const copy = c.req.raw.clone();
        const input = copy.headers.get("content-type")?.includes("application/json")
          ? await copy.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await copy.text()));
        const original = c.json;
        c.json = function (value, ...rest) {
          if (value?.access_token && input.client_id) store.setData("worldfixture.google.webhook_token_clients", {
            ...tokenClients(), [tokenDigest(value.access_token)]: input.client_id,
          });
          return original.call(this, value, ...rest);
        };
        try { await next(); } finally { c.json = original; }
      });
      const active = channel => channel && channel.expiration > Date.now();
      const transport = createWebhookTransport({
        // Google publishes exponential backoff, but no exact intervals or limit.
        retryDelays: [1000, 2000, 4000, 8000, 16000],
        accepted: response => SUCCESS_CODES.has(response.status),
        shouldRetry: (response, err) => Boolean(err) || RETRY_CODES.has(response?.status),
        headers: delivery => delivery.headers,
        isActive: delivery => {
          const channel = channels(store).findOneBy("channel_id", delivery.channelId);
          return enabled(store) && active(channel) && channel.generation === delivery.generation;
        },
        ...options,
      });
      webhooks.googleDelivery = transport;
      function notify(channel, state, changed) {
        if (!active(channel)) return;
        const number = state === "sync" ? 1 : channel.message_number + 2;
        channels(store).update(channel.id, { message_number: number });
        const headers = {
          "Content-Type": "application/json; utf-8", "Content-Length": "0", "User-Agent": "APIs-Google",
          "X-Goog-Channel-ID": channel.channel_id, "X-Goog-Message-Number": String(number),
          "X-Goog-Resource-ID": channel.resource_id, "X-Goog-Resource-URI": channel.resource_uri,
          "X-Goog-Resource-State": state, "X-Goog-Channel-Expiration": new Date(channel.expiration).toUTCString(),
          ...(channel.token !== undefined ? { "X-Goog-Channel-Token": channel.token } : {}),
          ...(changed ? { "X-Goog-Changed": changed } : {}),
        };
        const input = { channelId: channel.channel_id, generation: channel.generation, url: channel.address, rawBody: "", headers };
        if (enabled(store)) transport.enqueue(input);
        else {
          transport.deliveries.push({ ...input, attempts: 0, status: "captured" });
          if (transport.deliveries.length > 1000) transport.deliveries.shift();
        }
      }
      const calendar = (owner, id) => gs.calendars.findBy("user_email", owner)
        .find(record => id === "primary" ? record.primary : record.google_id === id);

      async function watch(c, family, kind) {
        const owner = c.get("authUser")?.login;
        if (!owner) return error(c, 401, "Invalid Credentials");
        let resourceKey = owner;
        let resourcePath = c.req.path.slice(0, -6);
        if (family === "calendar" && kind === "events") {
          const record = calendar(owner, c.req.param("calendarId"));
          if (!record) return error(c, 404, "Not Found");
          resourceKey = record.google_id;
          resourcePath = `/calendar/v3/calendars/${encodeURIComponent(resourceKey)}/events`;
        } else if (family === "calendar") {
          if (!["me", owner].includes(c.req.param("userId"))) return error(c, 404, "Not Found");
          resourcePath = `/calendar/v3/users/${encodeURIComponent(owner)}/calendarList`;
        } else if (kind === "files") {
          resourceKey = c.req.param("fileId");
          if (!gs.driveItems.findBy("user_email", owner).some(record => record.google_id === resourceKey)) return error(c, 404, "File not found");
        } else if (!/^\d+$/.test(c.req.query("pageToken") ?? "")) return error(c, 400, "The pageToken parameter is required.");
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body.id !== "string" || !body.id || body.id.length > 64 || /[\r\n]/.test(body.id) ||
            !["web_hook", "webhook"].includes(body.type) || typeof body.address !== "string") return error(c, 400, "Invalid notification channel.");
        if (body.token !== undefined && (typeof body.token !== "string" || body.token.length > 256 || /[\r\n]/.test(body.token))) return error(c, 400, "Invalid channel token.");
        try {
          const target = new URL(body.address);
          if (target.username || target.password || !(target.protocol === "https:" || target.protocol === "http:" && config(store).allow_insecure_http === true)) throw new Error();
        } catch { return error(c, 400, "The notification address must use HTTPS."); }
        if (channels(store).findOneBy("channel_id", body.id)) return error(c, 400, "Channel id is already in use.");
        const eventTypes = new URL(c.req.url).searchParams.getAll("eventTypes");
        if (kind === "events" && eventTypes.some(type => !EVENT_TYPES.has(type))) return error(c, 400, "Invalid eventTypes value.");
        const defaultTtl = family === "calendar" ? 604800 : 3600;
        const maxTtl = family === "calendar" || kind === "changes" ? 604800 : 86400;
        const ttl = body.params?.ttl === undefined ? defaultTtl : Number(body.params.ttl);
        const requestedExpiration = body.expiration === undefined ? Date.now() + ttl * 1000 : Number(body.expiration);
        if (!Number.isFinite(ttl) || ttl <= 0 || !Number.isSafeInteger(requestedExpiration) || requestedExpiration <= Date.now()) return error(c, 400, "Invalid channel expiration.");
        const channel = channels(store).insert({ channel_id: body.id, owner, family, kind, client_id: clientFor(c), generation: randomUUID(),
          resource_key: resourceKey, resource_id: createHash("sha256").update(`${family}:${kind}:${owner}:${resourceKey}`).digest("base64url").slice(0, 28),
          resource_uri: `https://www.googleapis.com${resourcePath}`, token: body.token, address: body.address,
          expiration: Math.min(requestedExpiration, Date.now() + maxTtl * 1000), message_number: 0, event_types: eventTypes });
        notify(channel, "sync");
        return c.json(publicChannel(channel));
      }

      app.post("/calendar/v3/calendars/:calendarId/events/watch", c => watch(c, "calendar", "events"));
      app.post("/calendar/v3/users/:userId/calendarList/watch", c => watch(c, "calendar", "calendarList"));
      app.post("/drive/v3/files/:fileId/watch", c => watch(c, "drive", "files"));
      app.post("/drive/v3/changes/watch", c => watch(c, "drive", "changes"));
      for (const family of ["calendar", "drive"]) app.post(`/${family}/v3/channels/stop`, async c => {
        const owner = c.get("authUser")?.login;
        if (!owner) return error(c, 401, "Invalid Credentials");
        const body = await c.req.json().catch(() => null);
        if (!body?.id || !body.resourceId) return error(c, 400, "Channel id and resourceId are required.");
        const channel = channels(store).findOneBy("channel_id", body.id);
        if (!channel || channel.owner !== owner || channel.client_id !== clientFor(c) || channel.family !== family || channel.resource_id !== body.resourceId) return error(c, 404, "Channel not found.");
        channels(store).delete(channel.id);
        return c.body(null, 204);
      });
      app.get("/drive/v3/changes/startPageToken", c => c.get("authUser")?.login
        ? c.json({ kind: "drive#startPageToken", startPageToken: String((store.getData("worldfixture.google.change_sequence") ?? 0) + 1) })
        : error(c, 401, "Invalid Credentials"));
      app.get("/drive/v3/changes", c => {
        const owner = c.get("authUser")?.login;
        if (!owner) return error(c, 401, "Invalid Credentials");
        const token = c.req.query("pageToken");
        if (!/^\d+$/.test(token ?? "")) return error(c, 400, "The pageToken parameter is required.");
        const pageSize = Number(c.req.query("pageSize") ?? 100);
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) return error(c, 400, "Invalid pageSize.");
        const found = changes(store).findBy("owner", owner).filter(change => change.sequence >= Number(token));
        const page = found.slice(0, pageSize);
        return c.json({ kind: "drive#changeList", changes: page.map(record => record.payload),
          ...(found.length > pageSize ? { nextPageToken: String(found[pageSize].sequence) }
            : { newStartPageToken: String((store.getData("worldfixture.google.change_sequence") ?? 0) + 1) }) });
      });

      // Observe committed REST writes. These reads do not create provider data.
      let mutation = Promise.resolve();
      app.use("*", async (c, next) => {
        if (!["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method) ||
            !/^\/(?:calendar\/v3\/|(?:upload\/)?drive\/v3\/files)/.test(c.req.path)) return next();
        const previousMutation = mutation;
        let release;
        mutation = new Promise(resolve => { release = resolve; });
        await previousMutation;
        try {
        const before = { events: snapshot(gs.calendarEvents), calendars: snapshot(gs.calendars), files: snapshot(gs.driveItems) };
        let status;
        const response = c.response;
        c.response = function (...values) { const result = response.apply(this, values); status = result.status; return result; };
        try { await next(); } finally { c.response = response; }
        if (status === undefined || status < 200 || status >= 300) return;
        const specs = [["events", gs.calendarEvents], ["calendars", gs.calendars], ["files", gs.driveItems]];
        for (const [kind, collection] of specs) {
          const after = snapshot(collection);
          for (const id of new Set([...before[kind].keys(), ...after.keys()])) {
            const old = before[kind].get(id);
            const current = after.get(id);
            if (JSON.stringify(old) === JSON.stringify(current)) continue;
            const record = current ?? old;
            if (kind === "files") {
              const sequence = (store.getData("worldfixture.google.change_sequence") ?? 0) + 1;
              store.setData("worldfixture.google.change_sequence", sequence);
              changes(store).insert({ owner: record.user_email, sequence, payload: { kind: "drive#change", changeType: "file",
                fileId: record.google_id, removed: !current, time: new Date().toISOString(), ...(current ? { file: driveFile(current) } : {}) } });
            }
            for (const channel of channels(store).all().filter(item => item.owner === record.user_email)) {
              if (kind === "events" && channel.family === "calendar" && channel.kind === "events" && channel.resource_key === record.calendar_google_id &&
                  (!channel.event_types.length || channel.event_types.includes(record.event_type ?? "default"))) notify(channel, "exists");
              if (kind === "calendars" && channel.family === "calendar" && channel.kind === "calendarList") notify(channel, "exists");
              if (kind === "files" && channel.family === "drive") {
                if (channel.kind === "changes") notify(channel, "change");
                else if (channel.resource_key === record.google_id) {
                  const state = !current ? "remove" : !old ? "add" : !old.trashed && current.trashed ? "trash" : old.trashed && !current.trashed ? "untrash" : "update";
                  const changed = state === "update" ? [
                    ...(JSON.stringify(old.parent_google_ids) !== JSON.stringify(current.parent_google_ids) ? ["parents"] : []),
                    ...(old.name !== current.name || old.mime_type !== current.mime_type ? ["properties"] : []),
                  ].join(",") || undefined : undefined;
                  notify(channel, state, changed);
                }
              }
            }
          }
        }
        } finally { release(); }
      });
      upstream.register(app, store, webhooks, ...args);
    } },
    seedFromConfig(store, baseUrl, input = {}, ...args) {
      store.setData(CONFIG, input.webhooks ?? {});
      upstreamSeed(store, baseUrl, input, ...args);
    },
  };
}
