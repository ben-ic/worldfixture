// A command, the provider action it asks for, the fact that results, and what
// that fact causes.
//
// The two are kept separate deliberately: a command requests a change and can
// fail; an event records a completed fact. Only a successful provider action
// creates its event, and the event carries the provider's own evidence -- the
// channel id and message timestamp Slack answered with -- so a reader can go
// and check. A model response, or a hopeful write, is a proposal and never
// evidence.
//
// This is also the whole of the causal path the extraction found to be safe.
// A rule may fire on a fact the runtime originated, because the runtime was the
// writer and has nothing to catch up on. A rule over a change a service made on
// its own needs the durable change journal no service offers yet.

import { randomUUID } from "node:crypto";

import { appendEvent } from "./state.mjs";
import { queueEffects } from "./causal-queue.mjs";
import { send as sendMail } from "./smtp.mjs";
import { send as sendSlack, whoAmI } from "./slack.mjs";

const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

function record(db, command) {
  db.prepare(
    `INSERT INTO commands(id, type, actor_id, target, input, idempotency_key, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`,
  ).run(
    command.id,
    command.type,
    command.actor_id,
    JSON.stringify(command.target),
    JSON.stringify(command.input),
    command.idempotency_key ?? null,
    Date.now(),
  );
}

function settle(db, commandId, status, { failure, eventId } = {}) {
  db.prepare("UPDATE commands SET status = ?, failure = ?, event_id = ? WHERE id = ?").run(
    status,
    failure ?? null,
    eventId ?? null,
    commandId,
  );
}

// Send a Slack message as a world person, through the Slack Web API.
export async function sendSlackMessage(db, { baseUrl, token, person, channel, text }) {
  const command = {
    id: id("cmd"),
    type: "communication.message.send.v1",
    actor_id: person.id,
    target: { service: "slack", channel: channel.name },
    input: { text },
  };

  record(db, command);

  let answer;
  try {
    answer = await sendSlack(baseUrl, token, { channelName: channel.name, text });
  } catch (error) {
    // A command that failed is recorded as failed. It produces no event,
    // because nothing completed.
    settle(db, command.id, "failed", { failure: error.message });
    throw error;
  }

  const identity = await whoAmI(baseUrl, token);

  const event = {
    id: id("evt"),
    type: "communication.message.sent.v1",
    actor_id: person.id,
    source: "slack",
    occurred_at: new Date(Number(answer.ts) * 1000).toISOString(),
    provider_evidence: {
      channel_id: answer.channel,
      channel_name: channel.name,
      message_ts: answer.ts,
      user_id: identity.user_id,
      text,
    },
    caused_by: command.id,
  };

  appendEvent(db, event);
  settle(db, command.id, "accepted", { eventId: event.id });

  return { command, event, identity };
}

// Carry out what a rule decided.
//
// The rule language emits an event type and a payload; turning that into a real
// provider action is the runtime's job and is the one place code is allowed in.
// Delivery goes through SMTP, not into Cyrus, so a message the server refused is
// not a message that was delivered.
export async function deliver(db, emission, { world, bindings, clock = () => Date.now(), rules = [], sendMail: post = sendMail }) {
  if (emission.type !== "mail.notification.requested.v1") {
    throw new Error(`no delivery for ${emission.type}`);
  }

  const address = bindings.SMTP_HOST_PORT;
  if (!address) throw new Error("Selected rule requires mail.smtp-submission.v1");

  const { recipients, author, channel, text } = emission.payload;
  const people = new Map((world.people ?? []).map((person) => [person.id, person]));

  // A lookup returns one row's field per matching row; a channel's membership is
  // one such field, so the list is flattened here rather than in the rule.
  const membership = [...new Set([].concat(...[].concat(recipients ?? [])))];
  const notify = membership.filter((personId) => personId !== author).map((personId) => people.get(personId));
  const from = people.get(author);
  if (!from?.email || notify.some(person => !person?.email)) throw new Error("Notification references an unknown person or email");

  const delivered = [];

  for (const person of notify) {
    await post(address, {
      from: from.email,
      to: person.email,
      subject: `[#${channel}] ${from.name} posted`,
      body: `${from.name} posted in #${channel}:\n\n${text}\n`,
      headers: { "X-WorldFixture-Rule": emission.rule, "X-WorldFixture-Caused-By": emission.caused_by },
    });

    const event = {
      id: id("evt"),
      type: "mail.notification.delivered.v1",
      actor_id: person.id,
      source: "mail",
      occurred_at: new Date(clock()).toISOString(),
      provider_evidence: { to: person.email, channel, via: "smtp", causal_rule: emission.rule },
      caused_by: emission.caused_by,
    };
    appendEvent(db, event);
    queueEffects(db, event, { world, rules });
    delivered.push(person);
  }

  return { delivered };
}

// One command, its fact, and everything that fact caused.
export async function submit(db, request, { world, rules }) {
  const { event, identity } = await sendSlackMessage(db, request);
  const effects = queueEffects(db, event, { world, rules });
  return { event, identity, effects };
}
