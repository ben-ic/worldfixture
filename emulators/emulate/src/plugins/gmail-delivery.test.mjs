import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "@emulators/google";
import { insertGmailMessage } from "./gmail-delivery.mjs";
import { scheduleArrivals } from "./arrivals.mjs";

function fixture() {
  const tokens = { primary: { login: "one@fixture.test", id: 1, scopes: [] }, recipient: { login: "two@fixture.test", id: 2, scopes: [] } };
  const server = createServer(googlePlugin, { tokens });
  seedFromConfig(server.store, "http://google.test", {
    users: ["one", "two"].map(name => ({ name, email: `${name}@fixture.test` })), messages: [],
    labels: [{ user_email: "two@fixture.test", name: "Future arrivals", id: "provider-label-7" }],
  });
  const writes = [];
  const fetchImpl = (url, options = {}) => {
    if (options.method === "POST") writes.push({ url: String(url), token: options.headers.authorization });
    return server.app.fetch(new Request(url, options));
  };
  const message = { id: "authored-arrival", from: "Sender <sender@fixture.test>", to: "two@fixture.test",
    subject: "A future arrival", body_text: "First line\nSecond line café", label_ids: ["INBOX", "Future arrivals"] };
  return { server, writes, fetchImpl, message };
}

test("Gmail arrival reaches the second owner with resolved labels and its actual provider ID", async () => {
  const { server, writes, fetchImpl, message } = fixture();
  const accepted = await insertGmailMessage({ baseUrl: "http://google.test", token: "recipient", user: "two@fixture.test", message, fetchImpl });
  assert.notEqual(accepted.id, message.id);
  assert.deepEqual([...accepted.labelIds].sort(), ["INBOX", "provider-label-7"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].token, "Bearer recipient");
  for (const [user, token, expected] of [["one", "primary", 0], ["two", "recipient", 1]]) {
    const response = await server.app.request(`/gmail/v1/users/${user}%40fixture.test/messages`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await response.json()).messages.length, expected);
  }
});

test("wrong owner, missing credential and undeclared labels fail before a write", async () => {
  for (const change of [{ token: "primary" }, { token: undefined }, { message: { label_ids: ["Typo"] } }]) {
    const env = fixture();
    await assert.rejects(insertGmailMessage({ baseUrl: "http://google.test", token: "recipient", user: "two@fixture.test",
      fetchImpl: env.fetchImpl, ...change, message: { ...env.message, ...change.message } }));
    assert.deepEqual(env.writes, []);
  }
});

test("standalone timer resolves the arrival recipient reference instead of its default token", async t => {
  const env = fixture();
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Standalone arrival timed out")), 3000);
    t.after(() => clearTimeout(timeout));
    const cancel = scheduleArrivals({ arrivals: [{ after_seconds: 0, user: "two@fixture.test", token_ref: "google_token_two", message: env.message }],
      origin: "http://google.test", token: "primary", tokenReferences: { google_token_two: "recipient" },
      defaultUser: "one@fixture.test", fetchImpl: env.fetchImpl,
      log: line => { if (line.includes("delivered")) resolve(line); else reject(new Error(line)); },
    });
    t.after(cancel);
  });
  assert.match(await completed, /delivered to two@fixture\.test, message/);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].token, "Bearer recipient");
});
