import { test } from "node:test";
import assert from "node:assert/strict";
import { startGmailPush, subscriptionFor } from "./gmail-push.mjs";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { createServer } from "@emulators/core";
import { getGoogleStore, googlePlugin, seedFromConfig } from "@emulators/google";

test("the default local subscription uses the registered topic project", () => {
  assert.equal(
    subscriptionFor("projects/inbox-zero/topics/gmail"),
    "projects/inbox-zero/subscriptions/gmail-push",
  );
  assert.equal(
    subscriptionFor("projects/some-other-app/topics/mail-changes"),
    "projects/some-other-app/subscriptions/gmail-push",
  );
});

test("Gmail sends the initial watch notification and retries identical Pub/Sub messages", async t => {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push(raw);
    res.writeHead(received.length === 1 ? 500 : 200).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const server = createServer(googlePlugin, { tokens: { token: { login: "ari@example.com", id: 1, scopes: [] } } });
  seedFromConfig(server.store, "http://google.test", { users: [{ email: "ari@example.com" }] });
  const request = (path, body) => server.app.request(path, { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify(body) });
  const watch = await (await request("/gmail/v1/users/me/watch", { topicName: "projects/demo/topics/gmail", labelIds: ["SPAM"], labelFilterBehavior: "exclude" })).json();
  const stop = startGmailPush({ store: server.store, getGoogleStore, pushUrl: `http://127.0.0.1:${receiver.address().port}/gmail`, intervalMs: 60000 });
  t.after(stop);
  await stop.tick();
  await stop.tick();
  assert.equal(received.length, 2);
  assert.equal(received[0], received[1]);
  const initial = JSON.parse(received[0]);
  assert.deepEqual(JSON.parse(Buffer.from(initial.message.data, "base64url")), { emailAddress: "ari@example.com", historyId: watch.historyId });
  const gs = getGoogleStore(server.store);
  const add = (gmail_id, label_ids) => gs.history.insert({ gmail_id, user_email: "ari@example.com", change_type: "messageAdded", message_gmail_id: "message", thread_id: "thread", label_ids });
  add(String(BigInt(watch.historyId) + 1n), ["SPAM"]);
  await stop.tick();
  assert.equal(received.length, 2);
  add(String(BigInt(watch.historyId) + 2n), ["INBOX"]);
  await stop.tick();
  assert.equal(received.length, 3);
  assert.notEqual(JSON.parse(received[2]).message.messageId, initial.message.messageId);
  await request("/gmail/v1/users/me/stop", {});
  await stop.tick();
  assert.equal(received.length, 3);
  await request("/gmail/v1/users/me/watch", { topicName: "projects/demo/topics/gmail" });
  await stop.tick();
  assert.equal(received.length, 4);
  server.store.getData("google.gmail.watchStates").get("ari@example.com").expiration = "1";
  add(String(BigInt(watch.historyId) + 3n), ["INBOX"]);
  await stop.tick();
  assert.equal(received.length, 4);
});

test("an unparseable or absent topic falls back without naming a product", () => {
  for (const topic of [undefined, "", "garbage", "projects//topics/x"]) {
    const value = subscriptionFor(topic);
    assert.match(value, /^projects\/[^/]+\/subscriptions\/gmail-push$/);
    assert.doesNotMatch(value, /droplive/i);
  }
});

for (const operation of ["close", "reset", "stop", "expire"]) {
  test(`Gmail does not send the next mailbox after ${operation} during a pending POST`, async () => {
    const state = () => ({ expiration: String(Date.now() + 60000), topicName: "projects/demo/topics/mail" });
    let states = new Map([["first@example.com", state()], ["second@example.com", state()]]);
    let respond, calls = 0;
    const stop = startGmailPush({ store: { getData: () => states },
      getGoogleStore: () => ({ messages: { findBy: () => [] }, history: { findBy: () => [] } }),
      pushUrl: "https://receiver.test", intervalMs: 60000,
      fetchImpl: async () => { calls++; return new Promise(resolve => { respond = resolve; }); } });
    const tick = stop.tick();
    if (operation === "close") stop();
    if (operation === "reset") states = new Map();
    if (operation === "stop") states.delete("second@example.com");
    if (operation === "expire") states.get("second@example.com").expiration = "1";
    respond(new Response(null, { status: 200 }));
    await tick;
    stop();
    assert.equal(calls, 1);
  });
}
