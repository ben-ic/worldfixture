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
//                        Slack's own `ts` as evidence, and queues the causal
//                        effects declared by the selected world.
//   incoming-email       SMTP, so Cyrus accepts it and `worldfixture mail inbox`
//                        can read it back over IMAP. `via: "gmail"` instead uses
//                        Gmail's own `messages.insert`, which is the path the
//                        composer's old `setTimeout` used and the one Gmail push
//                        subscriptions observe.
//   github-comment       GitHub issue comments API.
//   stripe-payment       Stripe invoice settlement or payment intents API.
//   s3-object            S3 PUT, against the bucket the world declares.
//   webhook              An HTTP POST to a subscriber. THERE MAY NOT BE ONE.
//                        HTTP targets serve GET only, so an instance with no
//                        registered subscriber reports the arrival as skipped
//                        with that reason. Inventing a destination, or quietly
//                        dropping it, would both be worse.
//
// Unknown executable kinds fail preflight and dispatch.

import { insertGmailMessage } from "../../emulators/emulate/src/plugins/gmail-delivery.mjs";
import { s3Fetch } from "./s3-signing.mjs";
import { randomUUID, createHash } from "node:crypto";

import { appendEvent, eventsAfter } from "./state.mjs";
import { queueEffects, worldNow } from "./causal-queue.mjs";

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
async function chatMessage(db, arrival, { world, bindings, credentials, rules, commandId, now, fetchImpl = fetch }) {
  const base = bindings.SLACK_BASE_URL;
  if (!base) throw new Error("this instance did not start Slack");

  const author = personById(world, arrival.payload.author_id);
  if (!author) throw new Error(`the world has no person ${JSON.stringify(arrival.payload.author_id)}`);

  const channel = channelById(world, arrival.payload.channel_id);
  if (!channel) throw new Error(`the world has no channel ${JSON.stringify(arrival.payload.channel_id)}`);

  const token = tokenFor(author, credentials);
  const text = String(arrival.payload.text ?? "");

  const answer = await sendSlack(base, token, { channelName: channel.name, text }, { fetchImpl });
  const identity = await slackIdentity(base, token, { fetchImpl });

  const event = {
    id: id("evt"),
    type: "communication.message.sent.v1",
    actor_id: author.id,
    source: "slack",
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
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
  const effects = queueEffects(db, event, { world, rules, now: now?.() ?? Date.now() });

  return delivered({
    event_id: event.id,
    channel: channel.name,
    queued_effects: effects.length,
  });
}

// ---- incoming-email ------------------------------------------------------

async function incomingEmail(db, arrival, { world, bindings, credentials, commandId, now, fetchImpl = fetch, sendMail = postMail }) {
  const via = arrival.payload.via ?? "smtp";
  const from = personById(world, arrival.payload.from_id);
  const to = personById(world, arrival.payload.to_id);
  if (!from) throw new Error(`the world has no sender ${JSON.stringify(arrival.payload.from_id)}`);
  if (!to) throw new Error(`the world has no recipient ${JSON.stringify(arrival.payload.to_id)}`);

  const subject = String(arrival.payload.subject ?? "");
  const body = String(arrival.payload.body_text ?? arrival.payload.snippet ?? "");

  if (via === "gmail") {
    const base = bindings.GOOGLE_BASE_URL;
    if (!base) throw new Error("this instance did not start Google, so Gmail cannot take an insert");
    const token = credentials?.values?.[`token:google_token_${to.id}`]
      ?? (!Object.hasOwn(world.communication ?? {}, "mailboxes") && to.primary ? credentials?.values?.["token:demo_token"] : undefined);
    let accepted;
    try {
      accepted = await insertGmailMessage({ baseUrl: base, token, user: to.email, fetchImpl,
        message: {
          thread_id: arrival.payload.thread_id ?? `thread-${arrival.id}`,
          from: `${from.name} <${from.email}>`, to: to.email, subject,
          snippet: arrival.payload.snippet ?? subject, body_text: body,
          labelIds: arrival.payload.labels ?? ["INBOX", "UNREAD"],
        },
      });
    } catch (error) { return { status: "failed", reason: error.message }; }

    appendEvent(db, {
      id: id("evt"),
      type: "mail.message.received.v1",
      actor_id: to.id,
      source: "google",
      occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
      provider_evidence: { to: to.email, from: from.email, subject, via: "gmail", arrival: arrival.id, message_id: accepted.id, thread_id: accepted.threadId },
      caused_by: commandId,
    });
    return delivered({ to: to.email, via: "gmail", message_id: accepted.id });
  }

  const address = bindings.SMTP_HOST_PORT;
  if (!address) throw new Error("this instance did not start SMTP");

  // Over the wire, so a message Cyrus refused is not a message that arrived.
  await sendMail(address, {
    from: from.email,
    to: to.email,
    subject,
    body: `${body}\n`,
    date: new Date(worldNow(db, now?.() ?? Date.now())).toUTCString(),
    headers: { "X-WorldFixture-Arrival": arrival.id },
  });

  appendEvent(db, {
    id: id("evt"),
    type: "mail.message.received.v1",
    actor_id: to.id,
    source: "mail",
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
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
  if (!base || !token) throw new Error("this instance did not start GitHub");

  const resolved = resolveIssue(world, arrival.payload);
  if (!resolved) {
    throw new Error(`the world has no issue ${JSON.stringify(arrival.payload.issue_id ?? "(unnamed)")}`);
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
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
    provider_evidence: { comment_id: comment.id ?? null, repository, issue_number: issueNumber, arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ repository, issue_number: issueNumber });
}

// ---- stripe-payment ------------------------------------------------------

async function stripePayment(db, arrival, { world, bindings, commandId, now, rules = [], fetchImpl = fetch }) {
  const base = bindings.STRIPE_BASE_URL, token = bindings.STRIPE_TOKEN, payload = arrival.payload;
  if (!base || !token) throw new Error("stripe-payment requires the selected Stripe binding");
  const amount = payload.amount_cents, currency = payload.currency?.toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !/^[a-z]{3}$/.test(currency ?? "")) throw new Error("stripe-payment needs an exact positive amount and explicit currency");
  const request = async (path, fields) => {
    const response = await fetchImpl(`${base}${path}`, { method: fields ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(fields ? { body: new URLSearchParams(fields).toString() } : {}), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Stripe answered ${response.status} for ${path.split("?")[0]}`);
    return response.json();
  };
  const find = async (path, sourceId, metadataKey, matches = row => row.metadata?.[metadataKey] === sourceId) => {
    let cursor; const seen = new Set(), found = [];
    do {
      const page = await request(`${path}?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(page.data)) throw new Error(`Stripe returned an invalid list for ${path}`);
      found.push(...page.data.filter(matches));
      if (!page.has_more) break;
      cursor = page.data.at(-1)?.id;
      if (!cursor || seen.has(cursor)) throw new Error(`Stripe pagination did not advance for ${path}`);
      seen.add(cursor);
    } while (cursor);
    if (found.length !== 1) throw new Error(`Stripe ${path} does not contain one record for declared ${metadataKey}`);
    return found[0];
  };
  const sourceCustomer = world.finance?.customers?.find(row => row.id === payload.customer_id);
  const email = world.people?.find(row => row.id === sourceCustomer?.contact_id)?.email;
  if (payload.customer_id && !email) throw new Error("stripe-payment customer has no declared contact email");
  const customer = payload.customer_id ? await find("/v1/customers", payload.customer_id, "customer contact email", row => row.email === email) : null;
  let invoice = null, intent = null;
  if (payload.invoice_id) {
    invoice = await find("/v1/invoices", payload.invoice_id, "worldfixture_invoice_id");
    if (invoice.status !== "open") throw new Error("stripe-payment requires an open invoice; a paid invoice cannot be settled twice");
    if (invoice.amount_due !== amount || invoice.currency !== currency || (customer && invoice.customer !== customer.id)) throw new Error("stripe-payment does not match the provider invoice amount, currency, or customer");
    invoice = await request(`/v1/invoices/${encodeURIComponent(invoice.id)}/pay`, {});
    if (invoice.status !== "paid" || invoice.amount_paid !== amount) throw new Error("Stripe did not accept the invoice settlement");
    const linked = await request(`/v1/invoice_payments?invoice=${encodeURIComponent(invoice.id)}&limit=100`);
    const payments = linked.data?.filter(row => row.status === "paid" && row.amount_paid === amount) ?? [];
    if (payments.length !== 1 || linked.has_more) throw new Error("Stripe invoice settlement linkage is incomplete");
    intent = { id: payments[0].payment?.payment_intent, status: "succeeded" };
  } else {
    intent = await request("/v1/payment_intents", { amount: String(amount), currency,
      ...(customer ? { customer: customer.id } : {}), ...(payload.description ? { description: payload.description } : {}),
      "metadata[worldfixture_arrival_id]": arrival.id });
    intent = await request(`/v1/payment_intents/${encodeURIComponent(intent.id)}/confirm`, {});
    if (intent.status !== "succeeded" || intent.amount !== amount || intent.currency !== currency) throw new Error("Stripe did not accept the payment");
  }
  const event = { id: id("evt"), type: "finance.payment.recorded.v1", actor_id: null, source: "stripe",
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
    provider_evidence: { payment_intent: intent.id, invoice: invoice?.id ?? null, customer: customer?.id ?? invoice?.customer ?? null,
      amount_cents: amount, currency, status: intent.status, arrival: arrival.id }, caused_by: commandId };
  appendEvent(db, event); queueEffects(db, event, { world, rules, now: now?.() ?? Date.now() });
  return delivered({ amount_cents: amount, currency, payment_intent: intent.id, invoice: invoice?.id ?? null });
}

// ---- s3-object -----------------------------------------------------------

async function s3Object(db, arrival, { bindings, commandId, now, fetchImpl = fetch }) {
  const base = bindings.S3_BASE_URL;
  if (!base) throw new Error("this instance did not start S3");

  const { bucket, key, body, content_type: contentType } = arrival.payload;
  if (!bucket || !key) throw new Error("an s3-object arrival needs bucket and key");

  const response = await s3Fetch(`${base}/${encodeURIComponent(bucket)}/${String(key).split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    headers: { "content-type": contentType ?? "application/octet-stream" },
    body: String(body ?? ""),
    signal: AbortSignal.timeout(15_000),
  }, bindings, fetchImpl);
  if (!response.ok) return { status: "failed", reason: `S3 answered ${response.status}` };

  appendEvent(db, {
    id: id("evt"),
    type: "storage.object.written.v1",
    actor_id: arrival.payload.author_id ?? null,
    source: "s3",
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
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
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
    provider_evidence: { url, event: arrival.payload.event ?? null, status: response.status, arrival: arrival.id },
    caused_by: commandId,
  });

  return delivered({ url });
}

// ---- application connector ---------------------------------------------

async function applicationEvent(db, arrival, { world, applicationConnector, commandId, now, fetchImpl = fetch }) {
  const target = applicationConnector?.();
  if (!target?.baseUrl || !target?.token) throw new Error("no application connector is connected");
  const kind = arrival.payload.kind;
  if (!kind) throw new Error("an application-event arrival needs payload.kind");

  const eventId = `wf:${encodeURIComponent(world.id)}:${encodeURIComponent(world.version ?? '')}:${encodeURIComponent(arrival.id)}`;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical(arrival.payload))).digest('hex');
  const proposed = {
    event_id: eventId,
    kind,
    occurred_at: arrival.payload.occurred_at ?? new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
    ...(arrival.payload.actor ? { actor: arrival.payload.actor } : {}),
    ...(arrival.payload.subject ? { subject: arrival.payload.subject } : {}),
    data: arrival.payload.data ?? {},
  };
  const stored = db.prepare('SELECT * FROM connector_receipts WHERE event_id=?').get(eventId);
  if (stored && stored.payload_fingerprint !== fingerprint) throw new Error('Connector event payload changed under the same world and arrival identity');
  if (stored && stored.target !== target.baseUrl) throw new Error('Connector event target changed; existing application receipt requires inspection');
  const envelope = stored ? JSON.parse(stored.envelope) : proposed;
  if (!stored) db.prepare("INSERT INTO connector_receipts(event_id,target,envelope,payload_fingerprint,status) VALUES(?,?,?,?,'pending')").run(eventId, target.baseUrl, JSON.stringify(envelope), fingerprint);
  const receipt = stored?.status === 'accepted' ? { status: 'already_applied' }
    : await deliverConnectorEvent(target.baseUrl, envelope, { token: target.token, fetchImpl });
  db.prepare("UPDATE connector_receipts SET status='accepted',receipt=? WHERE event_id=?").run(JSON.stringify(receipt), eventId);

  appendEvent(db, {
    id: id("evt"),
    type: "application.event.delivered.v1",
    actor_id: arrival.payload.actor?.worldfixture_ref ?? null,
    source: "application-connector",
    occurred_at: new Date(worldNow(db, now?.() ?? Date.now())).toISOString(),
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
  "domain-operation": async (db, arrival, context) => {
    const { executeDomainOperation } = await import('./domain-operations.mjs');
    const result = await executeDomainOperation(db, arrival.payload, { ...context, existingCommandId: context.commandId });
    return delivered({ event_id: result.event.id, record: result.record });
  },
};

export async function deliverArrival(db, arrival, context) {
  const play = KINDS[arrival.kind];
  if (!play) throw new Error(`Unknown executable timeline kind ${JSON.stringify(arrival.kind)}`);
  const before = db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get().seq;
  const result = await play(db, arrival, context);
  if (!['chat-message', 'stripe-payment', 'domain-operation'].includes(arrival.kind)) {
    for (const event of eventsAfter(db, before)) queueEffects(db, event, { world: context.world, rules: context.rules ?? [], now: context.now?.() ?? Date.now() });
  }
  return result;
}
