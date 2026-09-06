import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createServer } from "@emulators/core";
import { loadTwilioWithWebhooks, configureTwilioWebhookDelivery, queueTwilioWebhook } from "./twilio.mjs";
import { importPatchedProvider } from "./pinned-bundle.mjs";
const loaded = await loadTwilioWithWebhooks(new URL("../../node_modules/emulate/dist/dist-RJB3ANOP.js", import.meta.url).href);
const sid = "AC" + "1".repeat(32), secret = "native-twilio-secret", from = "+14155550100", to = "+14155550101";
async function fixture(t, handler, options = {}) {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    received.push({ raw, url: req.url, method: req.method, headers: req.headers,
      params: Object.fromEntries(new URLSearchParams(req.method === "GET" ? req.url.split("?")[1] : raw)) });
    if (handler) await handler(req, res); else res.end("<Response/>");
  });
  await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
  t.after(() => { receiver.closeAllConnections(); receiver.close(); });
  const origin = `http://127.0.0.1:${receiver.address().port}`;
  const server = createServer(loaded.twilioPlugin, { port: 0, baseUrl: "http://twilio.test", tokens: {} });
  loaded.seedFromConfig(server.store, "http://twilio.test", { account: { sid, auth_token: secret },
    phone_numbers: [{ phone_number: from }], conversations: { services: [{ friendly_name: "Fixture" }] } });
  const hooks = configureTwilioWebhookDelivery(server.store, options);
  t.after(() => hooks.close());
  async function api(path, body = {}, method = "POST", enabled = false) {
    const response = await server.app.request(path, { method, headers: {
      authorization: "Basic " + Buffer.from(`${sid}:${secret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded", ...(enabled ? { "X-Twilio-Webhook-Enabled": "true" } : {}),
    }, body: ["GET", "DELETE"].includes(method) ? undefined : new URLSearchParams(body) });
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response.status === 204 ? null : response.json();
  }
  function signatures() {
    for (const row of received) {
      let text = origin + row.url;
      if (row.method === "POST") {
        assert.equal(row.headers["content-type"], "application/x-www-form-urlencoded");
        for (const key of Object.keys(row.params).sort()) text += key + row.params[key];
      } else assert.equal(row.raw, "");
      assert.equal(row.headers["x-twilio-signature"], createHmac("sha1", secret).update(text).digest("base64"));
      assert.equal(row.headers["x-worldfixture-event"], undefined);
    }
  }
  return { ...server, api, received, origin, hooks, signatures, accountPath: `/2010-04-01/Accounts/${sid}` };
}
test("Twilio SMS uses native fields and signs the exact callback URL", async t => {
  const f = await fixture(t);
  const message = await f.api(`${f.accountPath}/Messages.json`, { From: from, To: to, Body: "Hello & שלום", StatusCallback: f.origin + "/sms?ref=a%20b&x=%2f" });
  await f.hooks.drain();
  assert.equal(f.received.length, 0);
  for (const Status of ["sent", "delivered", "undelivered"]) await f.api("/_twilio/simulate/message-status", { MessageSid: message.sid, Status,
    ...(Status === "undelivered" ? { ErrorCode: "30003", ErrorMessage: "Unreachable" } : {}) });
  await f.hooks.drain();
  assert.equal(f.received.length, 3);
  assert.deepEqual(f.received[0].params, { AccountSid: sid, From: from, To: to, MessageSid: message.sid, SmsSid: message.sid, MessageStatus: "sent", SmsStatus: "sent" });
  assert.equal(f.received[2].params.ErrorCode, "30003");
  assert.equal(f.received[2].params.Body, undefined);
  assert.equal(f.received[0].url, "/sms?ref=a%20b&x=%2f");
  f.signatures();
});
test("Twilio call filters, GET signatures, status mapping and sequence are native", async t => {
  const f = await fixture(t);
  const call = await f.api(`${f.accountPath}/Calls.json`, [["From", from], ["To", to], ["Twiml", "<Response/>"],
    ["StatusCallback", f.origin + "/call?ref=a%20b"], ["StatusCallbackMethod", "GET"],
    ...["initiated", "answered", "completed"].map(x => ["StatusCallbackEvent", x])]);
  for (const Status of ["in-progress", "busy"]) await f.api("/_twilio/simulate/call-status", { CallSid: call.sid, Status });
  await f.hooks.drain();
  assert.deepEqual(f.received.map(x => x.params.CallStatus), ["initiated", "in-progress", "busy"]);
  assert.deepEqual(f.received.map(x => x.params.SequenceNumber), ["0", "1", "2"]);
  for (const row of f.received) {
    assert.equal(row.method, "GET"); assert.equal(row.params.CallSid, call.sid);
    assert.equal(row.params.Caller, from); assert.equal(row.params.Called, to);
    assert.equal(row.params.CallbackSource, "call-progress-events");
    assert.ok(Number.isFinite(Date.parse(row.params.Timestamp)));
  }
  assert.equal(f.received[0].params.CallDuration, undefined);
  assert.match(f.received[2].params.CallDuration, /^\d+$/);
  f.signatures();
});
test("Twilio defaults to terminal call callbacks and signs inbound SMS and Voice", async t => {
  const f = await fixture(t), number = f.store.collection("twilio.phone_numbers").all()[0];
  await f.api(`${f.accountPath}/IncomingPhoneNumbers/${number.sid}.json`, { SmsUrl: f.origin + "/sms", SmsMethod: "POST",
    VoiceUrl: f.origin + "/voice", VoiceMethod: "GET", StatusCallback: f.origin + "/status" });
  const sms = await f.api("/_twilio/simulate/inbound-message", { To: from, From: to, Body: "Hello & שלום" });
  const inbound = await f.api("/_twilio/simulate/inbound-call", { To: from, From: to });
  const call = await f.api(`${f.accountPath}/Calls.json`, { From: from, To: to, Twiml: "<Response/>", StatusCallback: f.origin + "/status" });
  await f.api("/_twilio/simulate/call-status", { CallSid: call.sid, Status: "completed" });
  await f.hooks.drain();
  assert.equal(f.received.length, 3);
  const message = f.received.find(x => x.params.MessageSid === sms.sid);
  assert.equal(message.params.Body, "Hello & שלום"); assert.equal(message.params.SmsMessageSid, sms.sid);
  assert.equal(message.params.SmsStatus, "received"); assert.equal(message.params.NumMedia, "0");
  assert.equal(f.received.find(x => x.params.CallSid === inbound.sid).params.CallStatus, "ringing");
  assert.equal(f.received.find(x => x.params.CallSid === call.sid).params.CallStatus, "completed");
  f.signatures();
});
test("Twilio Conversations post-action form callbacks require REST opt-in and honor filters", async t => {
  const f = await fixture(t), service = f.store.collection("twilio.conversation_services").all()[0];
  const path = `/conversations/v1/Services/${service.sid}`;
  const events = ["onConversationAdded", "onConversationUpdated", "onConversationStateUpdated", "onConversationRemoved", "onMessageAdded", "onParticipantAdded"];
  const config = await f.api(path + "/Configuration/Webhooks", [["PostWebhookUrl", f.origin + "/conversations"], ...events.map(e => ["Filters", e])]);
  assert.deepEqual(config.filters, events);
  await f.api(path + "/Conversations", { FriendlyName: "No callback" });
  const conversation = await f.api(path + "/Conversations", { FriendlyName: "Support" }, "POST", true);
  const convPath = `${path}/Conversations/${conversation.sid}`;
  const participant = await f.api(convPath + "/Participants", { Identity: "alice" }, "POST", true);
  const message = await f.api(convPath + "/Messages", { Author: "alice", Body: "Hello & שלום", Attributes: '{"a":1}' }, "POST", true);
  await f.api(convPath, { State: "closed", FriendlyName: "Resolved" }, "POST", true);
  await f.api(convPath, {}, "DELETE", true);
  await f.hooks.drain();
  assert.deepEqual(f.received.map(x => x.params.EventType), [events[0], events[5], events[4], events[1], events[2], events[3]]);
  // Every Conversations event includes AccountSid, including state and removal.
  // https://www.twilio.com/docs/conversations-classic/conversations-webhooks
  for (const request of f.received) assert.equal(request.params.AccountSid, sid);
  assert.equal(f.received.find(x => x.params.EventType === "onParticipantAdded").params.RetryCount, "0");
  const body = f.received.find(x => x.params.EventType === "onMessageAdded").params;
  assert.equal(body.MessageSid, message.sid); assert.equal(body.ConversationSid, conversation.sid);
  assert.equal(body.ChatServiceSid, service.sid); assert.equal(body.ParticipantSid, participant.sid);
  assert.equal(body.Body, "Hello & שלום"); assert.equal(body.Attributes, '{"a":1}');
  assert.equal(body.Index, String(message.index)); assert.equal(body.DateCreated, message.date_created);
  const state = f.received.find(x => x.params.EventType === "onConversationStateUpdated").params;
  assert.equal(state.StateFrom, "active"); assert.equal(state.StateTo, "closed"); assert.equal(state.Reason, "API");
  f.signatures();
  await f.api(path + "/Configuration/Webhooks", { PostWebhookUrl: "" });
  await f.api(path + "/Conversations", { FriendlyName: "Disabled" }, "POST", true);
  await f.hooks.drain(); assert.equal(f.received.length, 6);
});
test("Twilio slow and failed receivers do not block changes; failures are recorded", async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (_req, res) => { await waiting; res.statusCode = 500; res.end("unavailable"); });
  t.after(release);
  const message = await f.api(`${f.accountPath}/Messages.json`, { From: from, To: to, Body: "test", StatusCallback: f.origin + "/slow" });
  const response = await f.api("/_twilio/simulate/message-status", { MessageSid: message.sid, Status: "sent" });
  assert.equal(response.status, "sent"); release(); await f.hooks.drain();
  const delivery = f.store.collection("twilio.webhook_deliveries").all()[0];
  assert.equal(delivery.success, false); assert.equal(delivery.response_status, 500); assert.equal(f.received.length, 1);
});
test("Twilio receiver timeout is recorded without failing the message change", async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 30 });
  const message = await f.api(`${f.accountPath}/Messages.json`, { From: from, To: to, Body: "test", StatusCallback: f.origin + "/timeout" });
  await f.api("/_twilio/simulate/message-status", { MessageSid: message.sid, Status: "sent" }); await f.hooks.drain();
  const delivery = f.store.collection("twilio.webhook_deliveries").all()[0];
  assert.equal(delivery.success, false); assert.equal(delivery.response_status, null); assert.match(delivery.error, /timeout/i);
});
test("pinned loader resolves bare relative imports from the original source", async t => {
  const directory = await mkdtemp(join(tmpdir(), "twilio-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "dependency.mjs"), "export const value = 23;");
  const source = 'import "./dependency.mjs"; export { value } from "./dependency.mjs"; export const original = import.meta.url;';
  await writeFile(join(directory, "provider.mjs"), source);
  const url = pathToFileURL(join(directory, "provider.mjs")).href;
  const result = await importPatchedProvider({ url, sha256: createHash("sha256").update(source).digest("hex"), replacements: [] });
  assert.equal(result.value, 23); assert.equal(result.original, url);
});

test("Twilio Messaging Service callbacks use message overrides and never use a Voice callback", async t => {
  const f = await fixture(t), number = f.store.collection("twilio.phone_numbers").all()[0];
  await f.api(`${f.accountPath}/IncomingPhoneNumbers/${number.sid}.json`, { StatusCallback: f.origin + "/voice-only" });
  const service = await f.api("/messaging/v1/Services", { FriendlyName: "SMS", StatusCallback: f.origin + "/service" });
  await f.api(`/messaging/v1/Services/${service.sid}/PhoneNumbers`, { PhoneNumberSid: number.sid });
  const first = await f.api(`${f.accountPath}/Messages.json`, { To: to, Body: "service", MessagingServiceSid: service.sid });
  const second = await f.api(`${f.accountPath}/Messages.json`, { From: from, To: to, Body: "override", MessagingServiceSid: service.sid, StatusCallback: f.origin + "/override" });
  const third = await f.api(`${f.accountPath}/Messages.json`, { From: from, To: to, Body: "no SMS callback" });
  for (const message of [first, second, third]) await f.api("/_twilio/simulate/message-status", { MessageSid: message.sid, Status: "sent" });
  await f.hooks.drain();
  assert.deepEqual(f.received.map(x => x.url), ["/service", "/override"]);
  for (const row of f.received) assert.equal(row.params.MessagingServiceSid, service.sid);
  f.signatures();
});

test("Twilio signature matches the published authentication example and omits URL fragments", async t => {
  // Fixed expected signature from https://www.twilio.com/docs/usage/security.
  // This assertion does not calculate its own expected HMAC.
  const server = createServer(loaded.twilioPlugin, { port: 0, baseUrl: "http://twilio.test", tokens: {} });
  const requests = [];
  const hooks = configureTwilioWebhookDelivery(server.store, { fetchImpl: async (url, request) => {
    requests.push({ url, ...request }); return new Response("OK");
  } });
  t.after(() => hooks.close());
  queueTwilioWebhook({ webhookDeliveries: server.store.collection("twilio.webhook_deliveries") },
    { sid, auth_token: "12345" }, "signature.example", "https://example.com/myapp.php?foo=1&bar=2#rc=0", "POST",
    { To: "+18005551212", From: "+14158675310", Digits: "1234", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" });
  await hooks.drain();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.com/myapp.php?foo=1&bar=2");
  assert.equal(requests[0].headers["X-Twilio-Signature"], "L/OH5YylLD5NRKLltdqwSvS0BnU=");
});

test("Twilio Conversations callbacks retain MessagingServiceSid and the resource author default", async t => {
  const f = await fixture(t), service = f.store.collection("twilio.conversation_services").all()[0];
  const path = `/conversations/v1/Services/${service.sid}`;
  const messaging = await f.api("/messaging/v1/Services", { FriendlyName: "Messages" });
  await f.api(path + "/Configuration/Webhooks", [["PostWebhookUrl", f.origin + "/events"],
    ["Method", "GET"], ["Filters", "onConversationAdded"], ["Filters", "onMessageAdded"]]);
  const conversation = await f.api(path + "/Conversations", { MessagingServiceSid: messaging.sid }, "POST", true);
  assert.equal(conversation.messaging_service_sid, messaging.sid);
  const message = await f.api(`${path}/Conversations/${conversation.sid}/Messages`, { Body: "From REST" }, "POST", true);
  // The API contract defines system as the default author.
  // https://www.twilio.com/docs/conversations-classic/api/conversation-message-resource
  assert.equal(message.author, "system");
  await f.hooks.drain();
  assert.equal(f.received.length, 2);
  for (const request of f.received) {
    assert.equal(request.method, "GET");
    assert.equal(request.params.MessagingServiceSid, messaging.sid);
    assert.equal(request.params.AccountSid, sid);
  }
  assert.equal(f.received[1].params.Author, message.author);
  assert.equal(f.received[1].params.ParticipantSid, undefined);
  f.signatures();
});

test("Twilio Messaging Service inbound routing honors its method and number override", async t => {
  // https://www.twilio.com/docs/messaging/api/service-resource
  const f = await fixture(t), number = f.store.collection("twilio.phone_numbers").all()[0];
  await f.api(`${f.accountPath}/IncomingPhoneNumbers/${number.sid}.json`, { SmsUrl: f.origin + "/number", SmsMethod: "POST" });
  const service = await f.api("/messaging/v1/Services", { FriendlyName: "Inbound", InboundRequestUrl: f.origin + "/service", InboundMethod: "GET" });
  assert.equal(service.inbound_method, "GET");
  await f.api(`/messaging/v1/Services/${service.sid}/PhoneNumbers`, { PhoneNumberSid: number.sid });
  await f.api("/_twilio/simulate/inbound-message", { To: from, From: to, Body: "GET & שלום" });
  await f.api(`/messaging/v1/Services/${service.sid}`, { UseInboundWebhookOnNumber: "true" });
  await f.api("/_twilio/simulate/inbound-message", { To: from, From: to, Body: "POST" });
  await f.api(`/messaging/v1/Services/${service.sid}`, { UseInboundWebhookOnNumber: "false", InboundRequestUrl: "" });
  await f.api("/_twilio/simulate/inbound-message", { To: from, From: to, Body: "Disabled" });
  await f.hooks.drain();
  assert.equal(f.received.length, 2);
  assert.equal(f.received[0].method, "GET");
  assert.ok(f.received[0].url.startsWith("/service?"));
  assert.equal(f.received[0].params.Body, "GET & שלום");
  assert.equal(f.received[1].url, "/number");
  assert.equal(f.received[1].method, "POST");
  f.signatures();
});
