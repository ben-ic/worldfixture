// The causal rule language, and the limit it is deliberately kept inside.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { defaultEnvironment } from "./environments.mjs";
import { RuleError, applyRules, parseDelay } from "./rules.mjs";

// Explicit test fixture; notifications are authored world policy.
const CHANNEL_NOTIFICATION = {
  api_version: "worldfixture.causal-rule/v1",
  id: "rule-slack-channel-notification",
  when: "communication.message.sent.v1",
  requires: ["provider_evidence.channel_name", "actor_id"],
  emit: [
    {
      type: "mail.notification.requested.v1",
      // Real notification mail is not instant, and a bounded delay is part of
      // the rule language rather than decoration.
      after: "1s",
      with: {
        recipients: {
          lookup: {
            collection: "communication.channels",
            match: { field: "name", value: { copy: "provider_evidence.channel_name" } },
            select: "member_ids",
          },
        },
        author: { copy: "actor_id" },
        channel: { copy: "provider_evidence.channel_name" },
        text: { copy: "provider_evidence.text" },
      },
    },
  ],
};


const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WORLD = JSON.parse(readFileSync(join(ROOT, "dist/business.saas-company.v2/world.json"), "utf8"));

function messageSent({ channel = "release-2-8", actor = "maya-chen", caused = "cmd_1" } = {}) {
  // `caused: null` means a fact the runtime did not originate.
  return {
    id: "evt_1",
    type: "communication.message.sent.v1",
    actor_id: actor,
    source: "slack",
    occurred_at: "2026-09-02T09:43:00Z",
    provider_evidence: { channel_name: channel, channel_id: "C1", message_ts: "1.1", text: "Mobile tests passed" },
    caused_by: caused,
  };
}

test("a delay is bounded and named, or it is not a delay", () => {
  assert.equal(parseDelay(undefined), 0);
  assert.equal(parseDelay("500ms"), 500);
  assert.equal(parseDelay("5s"), 5_000);
  assert.equal(parseDelay("2m"), 120_000);
  for (const bad of ["soon", "5", "-1s", "1h", "1e3s"]) {
    assert.throws(() => parseDelay(bad), RuleError, bad);
  }
});

test("a rule copies from the event and looks up in the world", () => {
  const [emission] = applyRules([CHANNEL_NOTIFICATION], messageSent(), { world: WORLD });

  assert.equal(emission.type, "mail.notification.requested.v1");
  assert.equal(emission.after_ms, 1_000);
  assert.equal(emission.caused_by, "evt_1");
  assert.equal(emission.payload.author, "maya-chen");
  assert.equal(emission.payload.channel, "release-2-8");
  assert.equal(emission.payload.text, "Mobile tests passed");

  // Membership comes from the world, which is the only part of this that IS a
  // fact about this world.
  const world = WORLD.communication.channels.find((entry) => entry.name === "release-2-8");
  assert.deepEqual(emission.payload.recipients, [world.member_ids]);
});

test("a rule whose required fields are absent does not fire", () => {
  const event = messageSent();
  delete event.provider_evidence.channel_name;
  assert.deepEqual(applyRules([CHANNEL_NOTIFICATION], event, { world: WORLD }), []);
});

test("a rule does not fire on another event type", () => {
  const event = { ...messageSent(), type: "finance.invoice.paid" };
  assert.deepEqual(applyRules([CHANNEL_NOTIFICATION], event, { world: WORLD }), []);
});

test("a lookup that matches nothing yields nothing, not an error", () => {
  const emissions = applyRules([CHANNEL_NOTIFICATION], messageSent({ channel: "no-such-channel" }), { world: WORLD });
  assert.deepEqual(emissions[0].payload.recipients, []);
});

test("a misspelled term is refused rather than emitted as a literal", () => {
  // `{ copyy: "actor_id" }` would otherwise emit the string "actor_id" and
  // nothing would report it.
  for (const shape of [{ copyy: "actor_id" }, { script: "whatever()" }, "actor_id", 7]) {
    const rule = {
      id: "bad", when: "communication.message.sent.v1",
      emit: [{ type: "x", with: { thing: shape } }],
    };
    assert.throws(() => applyRules([rule], messageSent(), { world: WORLD }), RuleError, JSON.stringify(shape));
  }

  // A literal is written out, and works.
  const literal = {
    id: "ok", when: "communication.message.sent.v1",
    emit: [{ type: "x", with: { thing: { value: "actor_id" } } }],
  };
  assert.equal(applyRules([literal], messageSent(), { world: WORLD })[0].payload.thing, "actor_id");
});

test("the world's own rules parse under the same engine", () => {
  // `business.saas-company` declares two rules of its own. Neither fires here,
  // and both have to be readable by the engine that would fire them.
  for (const rule of WORLD.agentic.causal_rules) {
    assert.doesNotThrow(() => applyRules([rule], messageSent(), { world: WORLD }), rule.id);
  }
});

test("channel notifications are not injected into generated environments", () => {
  assert.deepEqual(defaultEnvironment('test.sparse:v1').rules, []);
});
