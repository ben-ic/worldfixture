// How a scheduled arrival reaches the world.
//
// One function per timeline `kind`, and every one of them writes through the
// same public interface a person or an application would use. Nothing here
// touches an emulator's store, reads a projection to fake a result, or reports
// success before a provider accepted the write. That rule is what makes a
// scheduled arrival worth anything: if the world's own events took a private
// path, then the demo would be showing something no real integration could do.
//
// WHY EACH DESTINATION IS THE ONE IT IS, measured rather than assumed:
//
//   chat-message         Slack Web API, as the author, through `commands.mjs`
//                        so the message records a command, records the fact with
//                        Slack's own `ts` as evidence, and fires the causal rules
//                        -- which is how one scheduled message becomes seven real
//                        SMTP notifications.
//   incoming-email       SMTP, so Cyrus accepts it and `worldfixture mail inbox`
//                        can read it back over IMAP. `via: "gmail"` instead uses
//                        Gmail's own `messages.insert`, which is the path the
//                        composer's old `setTimeout` used and the one Gmail push
//                        subscriptions observe.
//   github-comment       GitHub issue comments API.
//   stripe-payment       Stripe payment intents API.
//   s3-object            S3 PUT, against the bucket the world declares.
//   webhook              An HTTP POST to a subscriber. THERE MAY NOT BE ONE.
//                        HTTP targets serve GET only, so an instance with no
//                        registered subscriber reports the arrival as skipped
//                        with that reason. Inventing a destination, or quietly
//                        dropping it, would both be worse.
//
// An unknown kind is skipped with its name in the reason. A world is allowed to
// declare a kind this runtime cannot play yet; it is not allowed to have that
// pass unremarked.

import { randomUUID } from "node:crypto";

import { appendEvent } from "./state.mjs";
import { deliver } from "./commands.mjs";
import { eligible } from "./rules.mjs";
import { send as postMail } from "./smtp.mjs";
import { identity as slackIdentity, send as sendSlack, tokenFor } from "./slack.mjs";
import { deliverConnectorEvent } from "./connector.mjs";

const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

const skipped = (reason) => ({ status: "skipped", reason });
const delivered = (detail = {}) => ({ status: "delivered", ...detail });

function personById(world, personId) {
  return (world.people ?? []).find((person) => person.id === personId) ?? null;
}

function channelById(world, channelId) {
  const channels = world.communication?.channels ?? [];
  return channels.find((channel) => channel.id === channelId || channel.name === channelId) ?? null;
}

// ---- chat-message --------------------------------------------------------

// Through the Slack Web API as the author, then through the rule engine.
//
// This mirrors `submit()` in `commands.mjs` rather than calling it, because the
// command row was already written by the scheduler: a scheduled arrival is one
// command, and writing a second one would make the ledger claim two.
async function chatMessage(db, arrival, { world, bindings, rules, commandId, now, fetchImpl = fetch, sendMail = postMail }) {
  const base = bindings.SLACK_BASE_URL;
  if (!base) return skipped("this instance did not start Slack");

  const author = personById(world, arrival.payload.author_id);
  if (!author) return skipped(`the world has no person ${JSON.stringify(arrival.payload.author_id)}`);

  const channel = channelById(world, arrival.payload.channel_id);
  if (!channel) return skipped(`the world has no channel ${JSON.stringify(arrival.payload.channel_id)}`);

  const token = tokenFor(author);
  const text = String(arrival.payload.text ?? "");

  const answer = await sendSlack(base, token, { channelName: channel.name, text }, { fetchImpl });
  const identity = await slackIdentity(base, token, { fetchImpl });

  const event = {
    id: id("evt"),
    type: "communication.message.sent.v1",
    actor_id: author.id,
    source: "slack",
    occurred_at: new Date(Number(answer.ts) * 1000).toISOString(),
    provider_evidence: {
      channel_id: answer.channel,
      channel_name: channel.name,
      message_ts: answer.ts,
      user_id: identity.user_id,
      text,
      arrival: arrival.id,
    },
    caused_by: commandId,
  };
  appendEvent(db, event);

  // The same causal path a manual `worldfixture slack send` takes. A scheduled
  // message that did not notify the channel would be a different kind of message
  // from a typed one, and they are supposed to be the same kind.
  const effects = [];
  for (const emission of eligible(rules ?? [], event, { world })) {
    if (emission.after_ms > 0) await new Promise((resolve) => setTimeout(resolve, emission.after_ms));
    effects.push(await deliver(db, emission, { world, bindings, clock: now, sendMail }));
  }

  return delivered({
    event_id: event.id,
    channel: channel.name,
    notified: effects.reduce((total, effect) => total + (effect.delivered?.length ?? 0), 0),
  });
}

// ---- incoming-email ------------------------------------------------------

async function incomingEmail(db, arrival, { world, bindings, commandId, now, fetchImpl = fetch, sendMail = postMail }) {
  const via = arrival.payload.via ?? "smtp";
  const from = personById(world, arrival.payload.from_id);
  const to = personById(world, arrival.payload.to_id);
  if (!from) return skipped(`the world has no sender ${JSON.stringify(arrival.payload.from_id)}`);
  if (!to) return skipped(`the world has no recipient ${JSON.stringify(arrival.payload.to_id)}`);

  const subject = String(arrival.payload.subject ?? "");
  const body = String(arrival.payload.body_text ?? arrival.payload.snippet ?? "");

  if (via === "gmail") {
    const base = bindings.GOOGLE_BASE_URL;
    const token = bindings.GOOGLE_TOKEN;
    if (!base || !token) return skipped("this instance did not start Google, so Gmail cannot take an insert");

    // The emulator's own `messages.insert`, which is what a Gmail push
    // subscription watches. Nothing writes the store behind its back.
    const response = await fetchImpl(`${base}/gmail/v1/users/me/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: arrival.id,
        thread_id: arrival.payload.thread_id ?? `thread-${arrival.id}`,
        from: `${from.name} <${from.email}>`,
        to: to.email,
        subject,
        snippet: arrival.payload.snippet ?? subject,
        body_text: body,
        labelIds: arrival.payload.labels ?? ["INBOX", "UNREAD"],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { status: "failed", reason: `Gmail answered ${response.status}: ${(await response.text()).slice(0, 160)}` };

    appendEvent(db, {
      id: id("evt"),
      type: "mail.message.received.v1",
      actor_id: to.id,
      source: "google",
      occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
      provider_evidence: { to: to.email, from: from.email, subject, via: "gmail", arrival: arrival.id },
      caused_by: commandId,
    });
    return delivered({ to: to.email, via: "gmail" });
  }

  const address = bindings.SMTP_HOST_PORT;
  if (!address) return skipped("this instance did not start SMTP");

  // Over the wire, so a message Cyrus refused is not a message that arrived.
  await sendMail(address, {
    from: from.email,
    to: to.email,
    subject,
    body: `${body}\n`,
    headers: { "X-WorldFixture-Arrival": arrival.id },
  });

  appendEvent(db, {
    id: id("evt"),
    type: "mail.message.received.v1",
    actor_id: to.id,
    source: "mail",
    occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
    provider_evidence: { to: to.email, from: from.email, subject, via: "smtp", arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ to: to.email, via: "smtp" });
}

// ---- github-comment ------------------------------------------------------

// A world speaks world ids, and GitHub speaks owner/repo/number. Resolving that
// here rather than in the world file keeps an author from having to know the
// provider's numbering, and keeps the compiler able to check the reference:
// `issue_id` must name an issue some repository in this world actually has.
function resolveIssue(world, payload) {
  if (payload.owner && payload.repository && payload.issue_number) {
    return { owner: payload.owner, repository: payload.repository, number: payload.issue_number };
  }

  const organizations = new Map((world.organizations ?? []).map((entry) => [entry.id, entry.slug ?? entry.id]));
  for (const repository of world.software?.repositories ?? []) {
    if (payload.repository_id && repository.id !== payload.repository_id) continue;
    for (const issue of repository.issues ?? []) {
      if (issue.id !== payload.issue_id) continue;
      return {
        owner: organizations.get(repository.owner_id) ?? repository.owner_id,
        repository: repository.name,
        number: issue.number,
      };
    }
  }
  return null;
}

async function githubComment(db, arrival, { world, bindings, commandId, now, fetchImpl = fetch }) {
  const base = bindings.GITHUB_BASE_URL;
  const token = bindings.GITHUB_TOKEN;
  if (!base || !token) return skipped("this instance did not start GitHub");

  const resolved = resolveIssue(world, arrival.payload);
  if (!resolved) {
    return skipped(`the world has no issue ${JSON.stringify(arrival.payload.issue_id ?? "(unnamed)")}`);
  }
  const { owner, repository, number: issueNumber } = resolved;
  const { body } = arrival.payload;

  const response = await fetchImpl(
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${encodeURIComponent(issueNumber)}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: String(body ?? "") }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) return { status: "failed", reason: `GitHub answered ${response.status}: ${(await response.text()).slice(0, 160)}` };

  const comment = await response.json().catch(() => ({}));
  appendEvent(db, {
    id: id("evt"),
    type: "software.issue.commented.v1",
    actor_id: arrival.payload.author_id ?? null,
    source: "github",
    occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
    provider_evidence: { comment_id: comment.id ?? null, repository, issue_number: issueNumber, arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ repository, issue_number: issueNumber });
}

// ---- stripe-payment ------------------------------------------------------

async function stripePayment(db, arrival, { bindings, commandId, now, fetchImpl = fetch }) {
  const base = bindings.STRIPE_BASE_URL;
  const token = bindings.STRIPE_TOKEN;
  if (!base || !token) return skipped("this instance did not start Stripe");

  const amount = Number(arrival.payload.amount_cents ?? 0);
  if (!Number.isInteger(amount) || amount <= 0) return skipped("a stripe-payment arrival needs a positive amount_cents");

  // Stripe's API takes form encoding, not JSON. Sending JSON here answers 400
  // and would have been reported as a broken world rather than a broken caller.
  const form = new URLSearchParams({
    amount: String(amount),
    currency: String(arrival.payload.currency ?? "usd"),
    confirm: "true",
    "automatic_payment_methods[enabled]": "true",
  });
  if (arrival.payload.description) form.set("description", String(arrival.payload.description));

  const response = await fetchImpl(`${base}/v1/payment_intents`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return { status: "failed", reason: `Stripe answered ${response.status}: ${(await response.text()).slice(0, 160)}` };

  const intent = await response.json().catch(() => ({}));
  appendEvent(db, {
    id: id("evt"),
    type: "finance.payment.recorded.v1",
    actor_id: arrival.payload.customer_id ?? null,
    source: "stripe",
    occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
    provider_evidence: { payment_intent: intent.id ?? null, amount_cents: amount, status: intent.status ?? null, arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ amount_cents: amount, payment_intent: intent.id ?? null });
}

// ---- s3-object -----------------------------------------------------------

async function s3Object(db, arrival, { bindings, commandId, now, fetchImpl = fetch }) {
  const base = bindings.S3_BASE_URL;
  if (!base) return skipped("this instance did not start S3");

  const { bucket, key, body, content_type: contentType } = arrival.payload;
  if (!bucket || !key) return skipped("an s3-object arrival needs bucket and key");

  const response = await fetchImpl(`${base}/${encodeURIComponent(bucket)}/${String(key).split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { "content-type": contentType ?? "application/octet-stream" },
    body: String(body ?? ""),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return { status: "failed", reason: `S3 answered ${response.status}` };

  appendEvent(db, {
    id: id("evt"),
    type: "storage.object.written.v1",
    actor_id: arrival.payload.author_id ?? null,
    source: "s3",
    occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
    provider_evidence: { bucket, key, bytes: String(body ?? "").length, arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ bucket, key });
}

// ---- webhook -------------------------------------------------------------

// A webhook needs somebody listening. The HTTP targets serve GET only, so
// unless the instance was given a subscriber there is nowhere to send it.
async function webhook(db, arrival, { bindings, commandId, now, fetchImpl = fetch }) {
  const url = arrival.payload.url ?? bindings.WEBHOOK_TARGET_URL ?? process.env.WORLDFIXTURE_WEBHOOK_URL;
  if (!url) {
    return skipped(
      "no webhook subscriber: set WORLDFIXTURE_WEBHOOK_URL, or give the arrival its own url, " +
        "and note that the HTTP targets serve GET only",
    );
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worldfixture-arrival": arrival.id },
    body: JSON.stringify(arrival.payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return { status: "failed", reason: `${url} answered ${response.status}` };

  appendEvent(db, {
    id: id("evt"),
    type: "integration.webhook.delivered.v1",
    actor_id: null,
    source: "webhook",
    occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
    provider_evidence: { url, event: arrival.payload.event ?? null, status: response.status, arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ url });
}

// ---- application connector ---------------------------------------------

async function applicationEvent(db, arrival, { applicationConnector, commandId, now, fetchImpl = fetch }) {
  const target = applicationConnector?.();
  if (!target?.baseUrl || !target?.token) return skipped("no application connector is connected");
  const kind = arrival.payload.kind;
  if (!kind) return skipped("an application-event arrival needs payload.kind");

  const receipt = await deliverConnectorEvent(target.baseUrl, {
    event_id: arrival.id,
    kind,
    occurred_at: arrival.payload.occurred_at ?? new Date(now?.() ?? Date.now()).toISOString(),
    ...(arrival.payload.actor ? { actor: arrival.payload.actor } : {}),
    ...(arrival.payload.subject ? { subject: arrival.payload.subject } : {}),
    data: arrival.payload.data ?? {},
  }, { token: target.token, fetchImpl });

  appendEvent(db, {
    id: id("evt"),
    type: "application.event.delivered.v1",
    actor_id: arrival.payload.actor?.worldfixture_ref ?? null,
    source: "application-connector",
    occurred_at: new Date(now?.() ?? Date.now()).toISOString(),
    provider_evidence: { arrival: arrival.id, kind, connector_status: receipt.status },
    caused_by: commandId,
  });
  return delivered({ application_event: kind, connector_status: receipt.status });
}

// ---- dispatch ------------------------------------------------------------

export const KINDS = {
  "chat-message": chatMessage,
  "incoming-email": incomingEmail,
  "github-comment": githubComment,
  "stripe-payment": stripePayment,
  "s3-object": s3Object,
  "application-event": applicationEvent,
  webhook,
};

export async function deliverArrival(db, arrival, context) {
  const play = KINDS[arrival.kind];
  if (!play) return skipped(`this runtime cannot play a ${JSON.stringify(arrival.kind)} arrival yet`);
  return play(db, arrival, context);
}
