import { readFileSync } from "node:fs";
import { join } from "node:path";

// A thin Slack client, over the real Slack Web API.
//
// `worldfixture slack send` exists to prove the rule the whole design rests on:
// a manual action uses the same interface an application uses. It calls
// `chat.postMessage` with the person's own token and reports what the service
// answered. It never writes an emulator store, and it never reports success
// before the service accepted the message.

// `fetchImpl` is a parameter so a test can drive this client rather than replace
// it. Stubbing the client would leave the URL, the method, the headers and the
// `ok: false` handling below untested, and those are the parts that break.
async function call(baseUrl, method, token, body, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const answer = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }));

  // A REFUSAL THAT IS NOT SLACK-SHAPED. The composer's rate limiter answers 403
  // with `{message, documentation_url}` and no `ok` and no `error`, so the line
  // below used to read "Slack refused conversations.list: unknown error" -- a
  // message that names neither the cause nor the repair. It was measured in a
  // real run: 5,000 requests per token per hour is the limit, it is per token
  // and per listener, and the reset time is in the response headers.
  if (!answer.ok) {
    if (response.status === 403 && /rate limit/i.test(String(answer.message ?? ""))) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const seconds = Number.isFinite(reset) ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : null;
      const error = new Error(
        `Slack refused ${method}: this token is over its rate limit of ` +
          `${response.headers.get("x-ratelimit-limit") ?? "?"} requests an hour` +
          (seconds === null ? "" : `, which resets in ${seconds}s`),
      );
      error.code = "rate_limited";
      error.retry_after_seconds = seconds;
      error.slack = answer;
      throw error;
    }
    const error = new Error(`Slack refused ${method}: ${answer.error ?? answer.message ?? `HTTP ${response.status}`}`);
    error.slack = answer;
    throw error;
  }

  return answer;
}

// Channel ids and identities do not change during a run, and asking for them on
// every message is what spends a token's hourly budget. `send` used to cost
// three requests -- conversations.list, chat.postMessage, auth.test -- so a
// world with a hundred scheduled messages spent three hundred. Now it costs one
// after the first.
const channelCache = new Map();
const identityCache = new Map();

export function forgetSlackCaches() {
  channelCache.clear();
  identityCache.clear();
}

async function channelId(baseUrl, token, channelName, options) {
  const key = `${baseUrl}\u0000${channelName}`;
  const cached = channelCache.get(key);
  if (cached) return cached;

  const channels = await listChannels(baseUrl, token, options);
  for (const entry of channels) channelCache.set(`${baseUrl}\u0000${entry.name}`, entry.id);
  const channel = channels.find((entry) => entry.name === channelName || entry.id === channelName);

  if (!channel) {
    const error = new Error(
      `no channel named ${JSON.stringify(channelName)}; this world has ${channels.map((c) => c.name).join(", ")}`,
    );
    error.code = "no_such_channel";
    throw error;
  }
  return channel.id;
}

export async function identity(baseUrl, token, options = {}) {
  const key = `${baseUrl}\u0000${token}`;
  if (!identityCache.has(key)) identityCache.set(key, await whoAmI(baseUrl, token, options));
  return identityCache.get(key);
}

export function tokenFor(person) {
  // The token map the compiler writes names the person, which is what makes a
  // world person able to act as themselves. Every token once resolved to the
  // emulator's default admin instead.
  return `slack_token_${person.id}`;
}

// Who the world grants a Slack token, read from the overlay rather than guessed.
//
// Not every person in a world is in the workspace. This world's ten insiders
// have tokens and its six external people do not, which is the right fidelity --
// a customer's director of operations is not a member of the supplier's Slack --
// and it means "act as Priya on Slack" has to be answered with that fact rather
// than with the emulator's 401.
export function slackTokenHolders(artifactPath) {
  const overlay = JSON.parse(
    readFileSync(join(artifactPath, "projections/emulator-overlay.json"), "utf8"),
  );
  return new Set(
    Object.keys(overlay.tokens ?? {})
      .filter((token) => token.startsWith("slack_token_"))
      .map((token) => token.slice("slack_token_".length)),
  );
}

export async function whoAmI(baseUrl, token, options = {}) {
  return call(baseUrl, "auth.test", token, {}, options);
}

export async function listChannels(baseUrl, token, options = {}) {
  const answer = await call(baseUrl, "conversations.list", token, {}, options);
  return answer.channels ?? [];
}

export async function send(baseUrl, token, { channelName, text }, options = {}) {
  // The emulator mints its own channel ids, so the name is resolved through the
  // API rather than assumed from the world's own id -- once per run, not once
  // per message.
  const channel = await channelId(baseUrl, token, channelName, options);
  return call(baseUrl, "chat.postMessage", token, { channel, text }, options);
}

export async function history(baseUrl, token, channelName) {
  const channels = await listChannels(baseUrl, token);
  const channel = channels.find((entry) => entry.name === channelName || entry.id === channelName);
  if (!channel) throw new Error(`no channel named ${JSON.stringify(channelName)}`);
  const answer = await call(baseUrl, "conversations.history", token, { channel: channel.id });
  return answer.messages ?? [];
}
