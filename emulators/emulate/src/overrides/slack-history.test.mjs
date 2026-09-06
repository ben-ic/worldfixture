import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "@emulators/core";
import { slackPlugin, seedFromConfig, getSlackStore } from "@emulators/slack";
import { seedSlackHistory } from "./slack-history.mjs";

function slackWith(config) {
  const { store } = createServer(slackPlugin, { port: 0, baseUrl: "http://localhost" });
  slackPlugin.seed?.(store, "http://localhost");
  seedFromConfig(store, "http://localhost", config);
  const result = seedSlackHistory(store, config);
  return { store, result, ss: getSlackStore(store) };
}

const WORLD = {
  users: [{ name: "mayac", real_name: "Maya Chen" }, { name: "jonbell", real_name: "Jon Bell" }],
  channels: [
    {
      name: "release-2-8",
      topic: "Release 2.8 readiness",
      messages: [
        { user: "mayac", text: "first", ts: "1787231400.000001" },
        { user: "jonbell", text: "second", ts: "1787232120.000002" },
      ],
    },
  ],
};

test("authored history lands in the channel with its authors and order", () => {
  const { result, ss } = slackWith(WORLD);
  const channel = ss.channels.findOneBy("name", "release-2-8");
  const messages = ss.messages.findBy("channel_id", channel.channel_id).sort((a, b) => (a.ts > b.ts ? 1 : -1));
  const byId = new Map(ss.users.all().map((u) => [u.user_id, u.name]));

  assert.equal(result.messages, 2);
  assert.deepEqual(messages.map((m) => m.text), ["first", "second"]);
  assert.deepEqual(messages.map((m) => byId.get(m.user)), ["mayac", "jonbell"]);
  assert.deepEqual(messages.map((m) => m.ts), ["1787231400.000001", "1787232120.000002"]);
});

test("a seeded message carries the fields the read path dereferences", () => {
  // `formatSlackMessage` reads `reactions.length` unguarded, so a message
  // missing them makes every later conversations.history call return a 500.
  const { ss } = slackWith(WORLD);
  const channel = ss.channels.findOneBy("name", "release-2-8");

  for (const message of ss.messages.findBy("channel_id", channel.channel_id)) {
    assert.ok(Array.isArray(message.reactions), "reactions must be an array");
    assert.ok(Array.isArray(message.reply_users), "reply_users must be an array");
    assert.equal(message.reply_count, 0);
  }
});

test("the world's topic replaces the one upstream self-seeded", () => {
  // Upstream seeds `general` itself, then skips any channel whose name exists,
  // so a world that names `general` otherwise loses its own topic.
  const world = { users: WORLD.users, channels: [{ name: "general", topic: "Company updates", messages: [] }] };
  const { result, ss } = slackWith(world);

  assert.equal(ss.channels.findOneBy("name", "general").topic.value, "Company updates");
  assert.equal(result.channels, 1);
});

test("a message from an unknown author fails instead of dropping source data", () => {
  const world = {
    users: WORLD.users,
    channels: [{ name: "release-2-8", topic: "t", messages: [{ user: "nobody", text: "x", ts: "1.000001" }] }],
  };
  assert.throws(() => slackWith(world), /unknown declared author nobody/);
});
