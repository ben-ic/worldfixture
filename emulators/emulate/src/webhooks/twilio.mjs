import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { importPatchedProvider } from "./pinned-bundle.mjs";

const controllers = new WeakMap();
const terminal = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);
const conversationEvents = ["onConversationAdded", "onConversationUpdated", "onConversationRemoved", "onConversationStateUpdated", "onMessageAdded", "onParticipantAdded"];

export async function loadTwilioWithWebhooks(url) {
  const source = await readFile(new URL(url), "utf8");
  const start = source.indexOf("async function dispatchTwilioWebhook(");
  const end = source.indexOf("\nfunction maskSecret", start);
  if (start < 0 || end < 0) throw new Error("Twilio webhook function was not found in the pinned bundle");
  return importPatchedProvider({ url, sha256: "3573b9c7771a79a04cf45b17df1be7dc3f1b7670173289b7be5f35d440f15308",
    prelude: `import { queueTwilioWebhook, queueTwilioConversationWebhook } from ${JSON.stringify(import.meta.url)};\n`,
    replacements: [
      [source.slice(start, end), "async function dispatchTwilioWebhook(...args) { queueTwilioWebhook(...args); }"],
      ['    accounts: store.collection("twilio.accounts", ["sid"]),', '    conversationWebhookConfigurations: store.collection("twilio.conversation_webhook_configurations", ["chat_service_sid"]),\n    accounts: store.collection("twilio.accounts", ["sid"]),'],
      ['    await dispatchMessageCallback(account, message.status, message);', '    // Twilio does not send a callback for the initial message status.'],
      ['statusCallback: number.status_callback ?? service?.status_callback ?? null', 'statusCallback: service?.status_callback ?? null'],
      ['    inbound_request_url: service.inbound_request_url,', '    inbound_request_url: service.inbound_request_url,\n    inbound_method: service.inbound_method ?? "POST",\n    use_inbound_webhook_on_number: service.use_inbound_webhook_on_number ?? false,'],
      ['      inbound_request_url: bodyString(body, "InboundRequestUrl") ?? null,', '      inbound_request_url: bodyString(body, "InboundRequestUrl") ?? null,\n      inbound_method: normalizeMethod(bodyString(body, "InboundMethod")),\n      use_inbound_webhook_on_number: bodyString(body, "UseInboundWebhookOnNumber") === "true",'],
      ['      inbound_request_url: bodyString(body, "InboundRequestUrl") ?? service.inbound_request_url,', '      inbound_request_url: bodyString(body, "InboundRequestUrl") ?? service.inbound_request_url,\n      inbound_method: bodyString(body, "InboundMethod") === undefined ? service.inbound_method ?? "POST" : normalizeMethod(bodyString(body, "InboundMethod")),\n      use_inbound_webhook_on_number: bodyString(body, "UseInboundWebhookOnNumber") === undefined ? service.use_inbound_webhook_on_number ?? false : bodyString(body, "UseInboundWebhookOnNumber") === "true",'],
      ['    const inboundUrl = messagingService?.inbound_request_url ?? number.sms_url;\n    const inboundMethod = messagingService?.inbound_request_url ? "POST" : number.sms_method;', '    const useNumber = !messagingService || messagingService.use_inbound_webhook_on_number;\n    const inboundUrl = useNumber ? number.sms_url : messagingService.inbound_request_url;\n    const inboundMethod = useNumber ? number.sms_method : messagingService.inbound_method ?? "POST";'],
      ['    if (call.status_callback_event.length > 0 && !call.status_callback_event.includes(status)) return;', '    // Native event selection is applied by queueTwilioWebhook.'],
      ['      status_callback_event: bodyStrings(body, "StatusCallbackEvent")', '      status_callback_method: normalizeMethod(bodyString(body, "StatusCallbackMethod")),\n      status_callback_event: bodyStrings(body, "StatusCallbackEvent")'],
      ['      status_callback_event: []', '      status_callback_method: number.status_callback_method ?? "POST",\n      status_callback_event: []'],
      ['      status_callback: bodyString(body, "StatusCallback") ?? null,\n      application_sid:', '      status_callback: bodyString(body, "StatusCallback") ?? null,\n      status_callback_method: normalizeMethod(bodyString(body, "StatusCallbackMethod")),\n      application_sid:'],
      ['      status_callback: bodyString(body, "StatusCallback") ?? number.status_callback,\n      application_sid:', '      status_callback: bodyString(body, "StatusCallback") ?? number.status_callback,\n      status_callback_method: bodyString(body, "StatusCallbackMethod") ?? number.status_callback_method ?? "POST",\n      application_sid:'],
      ['      status,\n      date_sent: ["sent", "delivered"].includes(status)', '      status,\n      error_code: bodyString(body, "ErrorCode") ?? message.error_code,\n      error_message: bodyString(body, "ErrorMessage") ?? message.error_message,\n      date_sent: ["sent", "delivered"].includes(status)'],
      ['      end_time: terminal ? (/* @__PURE__ */ new Date()).toISOString() : call.end_time\n', '      end_time: terminal ? (/* @__PURE__ */ new Date()).toISOString() : call.end_time,\n      duration: terminal ? durationSeconds(call.start_time, new Date().toISOString()) : call.duration\n'],
      ['function conversationRoutes({ app, store }) {\n  const ts = getTwilioStore(store);', `function conversationRoutes({ app, store }) {\n  const ts = getTwilioStore(store);\n${configurationRoutes}`],
      ['    messaging_service_sid: null,\n    friendly_name: conversation.friendly_name,', '    messaging_service_sid: conversation.messaging_service_sid ?? null,\n    friendly_name: conversation.friendly_name,'],
      ['      unique_name: uniqueName,\n      state: "active",', '      unique_name: uniqueName,\n      messaging_service_sid: bodyString(body, "MessagingServiceSid") ?? null,\n      state: "active",'],
      ['      unique_name: bodyString(body, "UniqueName") ?? conversation.unique_name,', '      unique_name: bodyString(body, "UniqueName") ?? conversation.unique_name,\n      messaging_service_sid: bodyString(body, "MessagingServiceSid") ?? conversation.messaging_service_sid ?? null,'],
      ['      author: bodyString(body, "Author") ?? null,', '      author: bodyString(body, "Author") ?? "system",'],
      ['    return c.json(formatConversation(conversation), 201);', '    queueTwilioConversationWebhook(ts, c, "onConversationAdded", conversation);\n    return c.json(formatConversation(conversation), 201);'],
      ['    return c.json(formatConversation(updated));', '    queueTwilioConversationWebhook(ts, c, "onConversationUpdated", updated);\n    if (updated.state !== conversation.state) queueTwilioConversationWebhook(ts, c, "onConversationStateUpdated", updated, conversation);\n    return c.json(formatConversation(updated));'],
      ['    ts.conversations.delete(conversation.id);', '    queueTwilioConversationWebhook(ts, c, "onConversationRemoved", conversation);\n    ts.conversations.delete(conversation.id);'],
      ['    return c.json(formatConversationMessage(message), 201);', '    queueTwilioConversationWebhook(ts, c, "onMessageAdded", message);\n    return c.json(formatConversationMessage(message), 201);'],
      ['    return c.json(formatConversationParticipant(participant), 201);', '    queueTwilioConversationWebhook(ts, c, "onParticipantAdded", participant);\n    return c.json(formatConversationParticipant(participant), 201);'],
    ],
  });
}

const configurationRoutes = `
  const configurationPath = "/conversations/v1/Services/:serviceSid/Configuration/Webhooks";
  function webhookConfiguration(service) {
    const found = ts.conversationWebhookConfigurations.findOneBy("chat_service_sid", service.sid);
    const config = found ?? { account_sid: service.account_sid, chat_service_sid: service.sid,
      pre_webhook_url: null, post_webhook_url: null, filters: [], method: "POST" };
    const { id, created_at, updated_at, ...result } = config;
    return { ...result, url: "https://conversations.twilio.com/v1/Services/" + service.sid + "/Configuration/Webhooks" };
  }
  app.get(configurationPath, (c) => {
    const service = authenticatedService(c);
    return service instanceof Response ? service : c.json(webhookConfiguration(service));
  });
  app.post(configurationPath, async (c) => {
    const service = authenticatedService(c);
    if (service instanceof Response) return service;
    const body = await parseTwilioBody(c);
    const current = webhookConfiguration(service);
    const filters = bodyString(body, "Filters") === undefined ? current.filters : bodyStrings(body, "Filters");
    if (bodyString(body, "PreWebhookUrl") || filters.some(event => !${JSON.stringify(conversationEvents)}.includes(event))) {
      return twilioError(c, 400, "This local service supports selected post-action webhooks only", 20001);
    }
    const method = bodyString(body, "Method") ?? current.method;
    if (!["GET", "POST"].includes(method)) return twilioError(c, 400, "Method is invalid", 20001);
    const updated = { ...current, post_webhook_url: bodyString(body, "PostWebhookUrl") ?? current.post_webhook_url, filters, method };
    const found = ts.conversationWebhookConfigurations.findOneBy("chat_service_sid", service.sid);
    if (found) ts.conversationWebhookConfigurations.update(found.id, updated);
    else ts.conversationWebhookConfigurations.insert(updated);
    return c.json(webhookConfiguration(service));
  });
`;

export function configureTwilioWebhookDelivery(store, options = {}) {
  return configureCollection(store.collection("twilio.webhook_deliveries"), options);
}

function configureCollection(deliveries, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  controllers.get(deliveries)?.close();
  const pending = new Set();
  const abort = new AbortController();
  const sequences = new Map();
  let closed = false;
  const controller = {
    sequences,
    close() { closed = true; abort.abort(); },
    async drain() { while (pending.size) await Promise.all([...pending]); },
    enqueue(account, event, url, method, params) {
      if (closed) return;
      const task = deliver(structuredClone(account), event, url, method, structuredClone(params)).catch(() => {});
      pending.add(task);
      task.finally(() => pending.delete(task));
    },
  };
  async function deliver(account, event, url, method, params) {
    let requestUrl = url, headers = {}, status = null, responseBody = null, error = null;
    try {
      // Preserve existing URL escapes: they are part of the signature input.
      requestUrl = url.split("#")[0];
      if (method === "GET") requestUrl += (requestUrl.includes("?") ? "&" : "?") + new URLSearchParams(params);
      let signed = requestUrl;
      if (method === "POST") for (const key of Object.keys(params).sort()) signed += key + params[key];
      headers = { "X-Twilio-Signature": createHmac("sha1", account.auth_token).update(signed).digest("base64"),
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) };
      const response = await fetchImpl(requestUrl, { method, headers,
        body: method === "POST" ? new URLSearchParams(params).toString() : undefined,
        redirect: "manual", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]) });
      status = response.status;
      responseBody = await response.text();
    } catch (cause) { error = cause.message; }
    deliveries.insert({ twilio_id: randomUUID(), account_sid: account.sid, event,
      url: requestUrl, method, request_body: params, request_headers: headers,
      response_status: status, response_body: responseBody, success: status >= 200 && status < 300, error });
  }
  controllers.set(deliveries, controller);
  return controller;
}

export function queueTwilioWebhook(ts, account, event, url, method, input) {
  if (!url) return;
  const controller = controllers.get(ts.webhookDeliveries) ?? configureCollection(ts.webhookDeliveries);
  let params = { ...input };
  if (event.startsWith("message.") && event !== "message.inbound") {
    const message = ts.messages.findOneBy("sid", params.MessageSid);
    params = { AccountSid: account.sid, MessageSid: params.MessageSid, SmsSid: params.MessageSid,
      MessageStatus: params.MessageStatus, SmsStatus: params.MessageStatus, To: params.To, From: params.From };
    if (message?.messaging_service_sid) params.MessagingServiceSid = message.messaging_service_sid;
    if (message?.error_code != null) params.ErrorCode = String(message.error_code);
  } else if (event === "message.inbound") {
    params.SmsMessageSid = params.MessageSid;
    if (!params.MessagingServiceSid) delete params.MessagingServiceSid;
  } else if (event.startsWith("call.")) {
    const call = ts.calls.findOneBy("sid", params.CallSid);
    params.Caller = params.From;
    params.Called = params.To;
    if (call?.parent_call_sid) params.ParentCallSid = call.parent_call_sid;
    if (event === "call.inbound") params.CallStatus = "ringing";
    else {
      const status = params.CallStatus;
      const selected = status === "queued" ? "initiated" : status === "in-progress" ? "answered" : terminal.has(status) ? "completed" : status;
      const filters = call?.status_callback_event?.length ? call.status_callback_event : ["completed"];
      if (!filters.includes(selected)) return;
      if (status === "queued") params.CallStatus = "initiated";
      method = call?.status_callback_method ?? "POST";
      const sequence = controller.sequences.get(params.CallSid) ?? 0;
      controller.sequences.set(params.CallSid, sequence + 1);
      params.SequenceNumber = String(sequence);
      params.CallbackSource = "call-progress-events";
      params.Timestamp = new Date().toUTCString().replace("GMT", "+0000");
      if (terminal.has(status)) {
        params.CallDuration = String(call?.duration ?? 0);
        params.Duration = String(Math.ceil(Number(params.CallDuration) / 60));
      }
    }
  }
  controller.enqueue(account, event, url, method === "GET" ? "GET" : "POST", params);
}

export function queueTwilioConversationWebhook(ts, c, event, row, previous) {
  if (c.req.header("X-Twilio-Webhook-Enabled") !== "true") return;
  const config = ts.conversationWebhookConfigurations.findOneBy("chat_service_sid", row.service_sid);
  if (!config?.post_webhook_url || !config.filters.includes(event)) return;
  const account = ts.accounts.findOneBy("sid", row.account_sid);
  const conversation = row.conversation_sid ? ts.conversations.findOneBy("sid", row.conversation_sid) : row;
  const params = { AccountSid: account.sid, EventType: event, ChatServiceSid: row.service_sid, ConversationSid: conversation.sid };
  if (conversation.messaging_service_sid) params.MessagingServiceSid = conversation.messaging_service_sid;
  if (event === "onConversationStateUpdated") {
    Object.assign(params, { StateFrom: previous.state, StateTo: row.state, StateUpdated: row.updated_at, Reason: "API" });
  } else {
    params.DateCreated = row.created_at;
    params.Attributes = row.attributes;
    if (event === "onMessageAdded") {
      Object.assign(params, { MessageSid: row.sid, Index: String(row.index), Body: row.body ?? "", Author: row.author ?? "system", RetryCount: "0" });
      const participant = ts.conversationParticipants.findBy("conversation_sid", conversation.sid).find(p => p.identity === row.author);
      if (participant) params.ParticipantSid = participant.sid;
    } else if (event === "onParticipantAdded") {
      params.ParticipantSid = row.sid;
      params.RetryCount = "0";
      if (row.identity) params.Identity = row.identity;
      if (row.messaging_binding_address) params["MessagingBinding.Address"] = row.messaging_binding_address;
      if (row.messaging_binding_proxy_address) params["MessagingBinding.ProxyAddress"] = row.messaging_binding_proxy_address;
      params["MessagingBinding.Type"] = row.identity ? "CHAT" : row.messaging_binding_address?.startsWith("whatsapp:") ? "WHATSAPP" : "SMS";
    } else {
      Object.assign(params, { DateUpdated: row.updated_at, State: row.state });
      if (row.friendly_name != null) params.FriendlyName = row.friendly_name;
      if (row.unique_name != null) params.UniqueName = row.unique_name;
      if (event === "onConversationRemoved") params.DateRemoved = new Date().toISOString();
      else params.RetryCount = "0";
    }
  }
  queueTwilioWebhook(ts, account, event, config.post_webhook_url, config.method, params);
}
