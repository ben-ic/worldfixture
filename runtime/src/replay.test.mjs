import assert from "node:assert/strict";
import test from "node:test";

import { connectorEventFromWorldEvent, observedKinds, selectWorldEvent } from "./replay.mjs";

const world = {
  people: [
    { id: "maya-chen", name: "Maya Chen", email: "maya@northstar-relay.worldfixture.test", slack_id: "U1", github_login: "mayachen" },
    { id: "jon-bell", name: "Jon Bell", email: "jon@northstar-relay.worldfixture.test", slack_id: "U2", github_login: "jonbell" },
  ],
  communication: { channels: [{ id: "channel-soc2", name: "soc2-audit", member_ids: ["maya-chen"] }] },
};

function slackEvent(overrides = {}) {
  return {
    seq: 12,
    id: "evt_abc",
    type: "communication.message.sent.v1",
    actor_id: "maya-chen",
    source: "slack",
    occurred_at: "2027-08-19T09:00:00.000Z",
    provider_evidence: { channel_name: "soc2-audit", text: "Mobile tests passed" },
    ...overrides,
  };
}

// The bug this closes: a world event names a channel the way a person would --
// `soc2-audit` -- and the pack the connector was seeded from calls the same
// channel `channel-soc2`. The obvious `channel/<channel_name>` reference misses
// every reference the seed receipt returned, so the connector answers 422 for a
// reason nobody can see. One connector author shipped a three-way fallback to
// work around it; another routed the event into a placeholder project.
test("a channel is addressed by the id the application was seeded with, not the name a person types", () => {
  const event = connectorEventFromWorldEvent(slackEvent(), world);

  assert.equal(event.subject.worldfixture_ref, "channel/channel-soc2");
  assert.equal(event.actor.worldfixture_ref, "person/maya-chen");
  assert.equal(event.data.channel_id, "channel-soc2");
  assert.equal(event.data.channel_name, "soc2-audit");
  // The provider's own view survives alongside the resolved identifiers.
  assert.equal(event.data.text, "Mobile tests passed");
});

test("a replayed event keeps the world's identity and time, not the wall clock", () => {
  const event = connectorEventFromWorldEvent(slackEvent(), world);

  assert.equal(event.api_version, "worldfixture.application-event/v1");
  assert.equal(event.event_id, "evt_abc");
  assert.equal(event.kind, "communication.message.sent.v1");
  // Identity and time come from the observation, so redelivering is a repeat
  // rather than a new event, which is what makes at-least-once delivery safe.
  assert.equal(event.occurred_at, "2027-08-19T09:00:00.000Z");
});

test("mail addressed to a person resolves to that person", () => {
  const event = connectorEventFromWorldEvent(slackEvent({
    type: "mail.message.sent.v1",
    source: "google",
    provider_evidence: { to: "jon@northstar-relay.worldfixture.test", subject: "Follow-up" },
  }), world);

  assert.equal(event.subject.worldfixture_ref, "person/jon-bell");
});

test("an event naming nothing the world knows still delivers, without inventing a subject", () => {
  const event = connectorEventFromWorldEvent(slackEvent({
    provider_evidence: { channel_name: "a-channel-that-does-not-exist", text: "hello" },
  }), world);

  assert.equal("subject" in event, false);
  assert.equal(event.data.text, "hello");
});

test("an incomplete observation is refused before an application is contacted", () => {
  assert.throws(() => connectorEventFromWorldEvent({ id: "evt_x" }, world), /needs id, type and occurred_at/);
});

test("an event is selected by id, by sequence number, by kind, or by being the most recent", () => {
  const events = [
    slackEvent({ seq: 1, id: "evt_one", type: "mail.message.sent.v1" }),
    slackEvent({ seq: 2, id: "evt_two" }),
    slackEvent({ seq: 3, id: "evt_three", type: "mail.message.sent.v1" }),
  ];

  assert.equal(selectWorldEvent(events).id, "evt_three");
  assert.equal(selectWorldEvent(events, "evt_two").id, "evt_two");
  assert.equal(selectWorldEvent(events, "1").id, "evt_one");
  assert.equal(selectWorldEvent(events, 2).id, "evt_two");
  // A kind takes the most recent of that kind, which is what somebody typing a
  // kind means.
  assert.equal(selectWorldEvent(events, "mail.message.sent.v1").id, "evt_three");

  assert.throws(() => selectWorldEvent(events, "evt_nope"), /no observed event matches/);
  assert.throws(() => selectWorldEvent([]), /observed no events yet/);
});

test("the kinds offered are the ones this world produced, most frequent first", () => {
  const events = [
    slackEvent({ id: "a", type: "mail.notification.delivered.v1" }),
    slackEvent({ id: "b", type: "mail.notification.delivered.v1" }),
    slackEvent({ id: "c" }),
  ];

  assert.deepEqual(observedKinds(events), [
    { kind: "mail.notification.delivered.v1", count: 2 },
    { kind: "communication.message.sent.v1", count: 1 },
  ]);
  assert.deepEqual(observedKinds([]), []);
});
