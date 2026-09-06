import { createHmac, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

// Slack documents message.* as subscription names; the inner type is "message".
// RTM-only events (notably presence_change) must never reach an Events API URL.
export const SLACK_EVENT_TYPES = Object.freeze([
  "message.channels", "message.groups", "message.im", "message.mpim",
  "reaction_added", "reaction_removed", "user_change",
  "channel_archive", "channel_unarchive", "channel_rename",
  "group_archive", "group_unarchive", "group_rename",
  "member_joined_channel", "member_left_channel",
  "file_created", "file_shared", "file_deleted", "pin_added", "pin_removed",
]);
const STATE = "worldfixture.slack.events_api";
const timestamp = () => (BigInt(Date.now()) * 1000n).toString().replace(/(.{6})$/, ".$1");
const identifier = (prefix) => prefix + randomBytes(8).toString("hex").toUpperCase();

function standardProfile(profile = {}) {
  const { fields, ...standard } = profile;
  // Match the defaults added by the upstream profile formatter before comparison.
  return { title: "", phone: "", skype: "", ...standard,
    real_name_normalized: profile.real_name_normalized ?? profile.real_name,
    display_name_normalized: profile.display_name_normalized ?? profile.display_name,
    status_text: profile.status_text ?? "", status_emoji: profile.status_emoji ?? "",
    status_emoji_display_info: profile.status_emoji_display_info ?? [],
    status_expiration: profile.status_expiration ?? 0,
    huddle_state: profile.huddle_state ?? "default_unset",
    huddle_state_expiration_ts: profile.huddle_state_expiration_ts ?? 0 };
}

export function slackHeaders(body, secret, seconds = Math.floor(Date.now() / 1000)) {
  return {
    "Content-Type": "application/json",
    "X-Slack-Request-Timestamp": String(seconds),
    "X-Slack-Signature": `v0=${createHmac("sha256", secret).update(`v0:${seconds}:${body}`).digest("hex")}`,
  };
}

function channelFor(store, event) {
  const id = (typeof event.channel === "object" ? event.channel.id : event.channel)
    ?? event.channel_id ?? event.item?.channel;
  return store.collection("slack.channels").all().find((channel) => channel.channel_id === id);
}

function channelType(channel) {
  return channel?.is_im ? "im" : channel?.is_mpim ? "mpim" : channel?.is_private ? "group" : "channel";
}

function nativeEvent(store, input) {
  const event = structuredClone(input);
  event.event_ts ??= event.ts ?? timestamp();
  if (event.type === "message") event.channel_type = channelType(channelFor(store, event));
  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    const message = store.collection("slack.messages").all().find((entry) =>
      entry.channel_id === event.item.channel && entry.ts === event.item.ts);
    if (message?.user && !message.bot_id) event.item_user = message.user;
  }
  if (event.type === "file_created" || event.type === "file_shared") {
    if (event.type === "file_shared" && event.file?.user) event.user_id = event.file.user;
    event.file = { id: event.file_id };
  }
  if (event.type === "file_deleted") delete event.file;
  if (event.type === "user_change") {
    // Upstream uses microseconds as a number. Slack's cache_ts is epoch seconds.
    event.cache_ts = Number(event.event_ts.split(".")[0]);
  }
  return event;
}

function subscriptionType(event, channel) {
  if (event.type !== "message") return event.type;
  return `message.${channel?.is_im ? "im" : channel?.is_mpim ? "mpim" : channel?.is_private ? "groups" : "channels"}`;
}

function visibleTo(store, config, event, channel) {
  const user = store.collection("slack.users").all().find((entry) => entry.user_id === config.user_id);
  const member = channel?.members?.some((id) => id === user?.user_id || id === user?.name);
  // These subscriptions require membership even for user installations in public channels.
  if (["pin_added", "pin_removed", "member_joined_channel"].includes(event.type) && !member) return false;
  if (channel && (channel.is_private || channel.is_im || channel.is_mpim || config.is_bot) && !member) {
    // A user must receive their own member_left_channel after membership removal.
    return event.type === "member_left_channel" && event.user === config.user_id;
  }
  if (event.type === "file_created") {
    const file = store.collection("slack.files").all().find((entry) => entry.file_id === event.file_id);
    return file?.user === config.user_id;
  }
  if (event.type === "file_deleted") {
    const file = store.collection("slack.files").all().find((entry) => entry.file_id === event.file_id);
    if (file?.user === config.user_id) return true;
    return [...(file?.channels ?? []), ...(file?.groups ?? []), ...(file?.ims ?? [])].some((id) => {
      const shared = store.collection("slack.channels").all().find((entry) => entry.channel_id === id);
      return shared && (!(shared.is_private || shared.is_im || shared.is_mpim || config.is_bot)
        || shared.members?.some((memberId) => memberId === user?.user_id || memberId === user?.name));
    });
  }
  return true;
}

function normalizeConfig(store, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Slack events_api must be an object");
  let url;
  try { url = new URL(input.request_url); } catch { throw new Error("Slack events_api.request_url must be an HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Slack events_api.request_url must be an HTTP or HTTPS URL without credentials");
  }
  if (typeof input.signing_secret !== "string" || !input.signing_secret) throw new Error("Slack events_api.signing_secret is required");
  if (!/^A[A-Z0-9]+$/.test(input.app_id ?? "")) throw new Error("Slack events_api.app_id must be a Slack app ID");
  const user = store.collection("slack.users").all().find((entry) => entry.user_id === input.user_id || entry.name === input.user);
  if (!user) throw new Error("Slack events_api.user_id or user must name a world user");
  if (!Array.isArray(input.events) || !input.events.length || input.events.some((type) => !SLACK_EVENT_TYPES.includes(type))) {
    throw new Error(`Slack events_api.events must contain supported subscriptions: ${SLACK_EVENT_TYPES.join(", ")}`);
  }
  const team = store.collection("slack.teams").all().find((entry) => !input.team_id || entry.team_id === input.team_id);
  if (!team) throw new Error("Slack events_api.team_id must name a world workspace");
  return { ...input, user_id: user.user_id, team_id: team.team_id, is_bot: input.is_bot ?? user.is_bot ?? false,
    verification_token: input.verification_token ?? randomBytes(24).toString("hex") };
}

/** Install after seeding/restoring. The mutation path queues delivery and returns immediately. */
export function installSlackWebhooks({ store, webhooks, config, fetchImpl = fetch,
  retryDelays = [0, 60_000, 300_000], timeoutMs = 3000, sleep = delay }) {
  const saved = store.getData(STATE);
  const input = config ?? saved?.config;
  if (!input) return { ready: Promise.resolve(), drain: async () => {}, close() {} };
  const normalized = normalizeConfig(store, { ...input,
    verification_token: input.verification_token ?? saved?.config.verification_token });
  // Store credentials and verification state with provider state so snapshots retain it.
  const state = saved && JSON.stringify(saved.config) === JSON.stringify(normalized)
    ? saved : { config: normalized, verified: false, deliveries: [] };
  store.setData(STATE, state);
  const pending = new Set();
  const stop = new AbortController();
  const originalDispatch = webhooks.dispatch;
  const users = store.collection("slack.users");
  const channels = store.collection("slack.channels");
  const originalUserUpdate = users.update;
  const originalChannelInsert = channels.insert;
  const customFieldOnly = new Set();
  let closed = false;

  async function attempt(body, retry, reason) {
    const headers = slackHeaders(body, normalized.signing_secret);
    if (retry) {
      headers["X-Slack-Retry-Num"] = String(retry);
      headers["X-Slack-Retry-Reason"] = reason;
    }
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
    let url = normalized.request_url;
    try {
      for (let redirects = 0; ; redirects++) {
        const response = await fetchImpl(url, { method: "POST", headers, body, redirect: "manual", signal });
        if ([301, 302].includes(response.status) && response.headers.get("location")) {
          await response.body?.cancel();
          if (redirects === 2) return { success: false, reason: "too_many_redirects", status: response.status };
          url = new URL(response.headers.get("location"), url).href;
          continue;
        }
        const text = await response.text();
        return { success: response.ok, status: response.status, text,
          reason: "http_error", noRetry: !response.ok && response.headers.get("x-slack-no-retry") === "1" };
      }
    } catch (error) {
      const code = String(error.cause?.code ?? "");
      return { success: false, status: null, reason: signal.aborted ? "http_timeout"
        : /CERT|SSL|TLS/.test(code) ? "ssl_error" : "connection_failed" };
    }
  }

  async function verify() {
    if (state.verified) return;
    const challenge = randomBytes(32).toString("hex");
    const body = JSON.stringify({ token: normalized.verification_token, challenge, type: "url_verification" });
    const response = await attempt(body, 0);
    let answer = response.text?.trim();
    try { answer = JSON.parse(response.text).challenge; } catch {
      if (answer?.startsWith("challenge=")) answer = new URLSearchParams(answer).get("challenge");
    }
    if (response.status !== 200 || answer !== challenge) throw new Error("Slack Events API URL verification failed: receiver must return HTTP 200 with the challenge within three seconds");
    state.verified = true;
    store.setData(STATE, state);
  }
  const ready = verify();
  // Keep startup failure observable through ready without an unhandled rejection.
  ready.catch(() => {});

  async function deliver(payload) {
    await ready;
    const body = JSON.stringify(payload);
    let reason;
    for (let retry = 0; retry <= retryDelays.length && !closed; retry++) {
      if (retry) await sleep(retryDelays[retry - 1], undefined, { signal: stop.signal });
      if (closed) return;
      const result = await attempt(body, retry, reason);
      state.deliveries.push({ event_id: payload.event_id, retry, status: result.status, success: result.success, reason: result.success ? null : result.reason });
      if (state.deliveries.length > 1000) state.deliveries.splice(0, state.deliveries.length - 1000);
      store.setData(STATE, state);
      if (result.success || result.noRetry) return;
      reason = result.reason;
    }
  }

  webhooks.dispatch = async function(type, action, payload, owner, repo) {
    if (owner !== "slack") return originalDispatch.call(this, type, action, payload, owner, repo);
    if (closed || !payload?.event) return;
    if (payload.event.type === "user_change" && customFieldOnly.delete(payload.event.user?.id)) return;
    const channel = channelFor(store, payload.event);
    if (!normalized.events.includes(subscriptionType(payload.event, channel))) return;
    if (!visibleTo(store, normalized, payload.event, channel)) return;
    const event = nativeEvent(store, payload.event);
    const envelope = {
      token: normalized.verification_token, team_id: normalized.team_id, api_app_id: normalized.app_id,
      event, type: "event_callback", event_id: identifier("Ev"), event_context: identifier("EC"),
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ enterprise_id: null, team_id: normalized.team_id, user_id: normalized.user_id,
        is_bot: normalized.is_bot, is_enterprise_install: false }],
      is_ext_shared_channel: false, context_team_id: normalized.team_id, context_enterprise_id: null,
    };
    const task = deliver(envelope).catch((error) => {
      if (!closed) { state.last_error = error.message; store.setData(STATE, state); }
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };

  users.update = function(id, changes) {
    const previous = this.get(id);
    const updated = originalUserUpdate.call(this, id, changes);
    if (updated) {
      customFieldOnly.delete(updated.user_id);
      if (previous && changes.profile
        && !isDeepStrictEqual(previous.profile?.fields, updated.profile?.fields)
        && isDeepStrictEqual(standardProfile(previous.profile), standardProfile(updated.profile))
        && Object.keys(changes).every((key) => key === "profile" || isDeepStrictEqual(previous[key], updated[key]))) {
        customFieldOnly.add(updated.user_id);
      }
    }
    return updated;
  };
  channels.insert = function(data) {
    const channel = originalChannelInsert.call(this, data);
    // conversations.create stores the creator as the first member but emits no join event.
    if (!closed && !channel.is_im && !channel.is_mpim && channel.creator) {
      const creator = users.all().find((user) => user.user_id === channel.creator || user.name === channel.creator);
      if (creator) void webhooks.dispatch("member_joined_channel", undefined, { event: {
        type: "member_joined_channel", user: creator.user_id, channel: channel.channel_id,
        channel_type: channel.channel_id[0], team: creator.team_id,
      } }, "slack");
    }
    return channel;
  };
  return { ready, async drain() { while (pending.size) await Promise.all([...pending]); },
    close() { closed = true; stop.abort(); webhooks.dispatch = originalDispatch;
      users.update = originalUserUpdate; channels.insert = originalChannelInsert; } };
}
