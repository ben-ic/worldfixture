import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { importPatchedProvider } from "./pinned-bundle.mjs";

const controllers = new WeakMap();
export function closeLinearWebhookDelivery(store) { controllers.get(store)?.close(); }
const collection = (store, name) => store.collection(`linear.${name}`);

export async function loadLinearWithWebhooks(url) {
  const source = await readFile(new URL(url), "utf8");
  const start = source.indexOf("async function dispatchLinearWebhook(store, event) {");
  const end = source.indexOf("\nvar schema = buildSchema(`", start);
  if (start < 0 || end < 0) throw new Error("Linear webhook function was not found in the pinned bundle");
  return importPatchedProvider({ url,
    sha256: "69b05df3b0f49e2e3cad06622add8ccd1e30adf71625f00890f2a995a2789a5e",
    prelude: `import { queueLinearWebhook } from ${JSON.stringify(import.meta.url)};\n`,
    replacements: [
      [source.slice(start, end), "async function dispatchLinearWebhook(store, event) { queueLinearWebhook(store, event); }"],
      ['action: "archive",', 'action: "update", updatedFrom: issueWebhookPayload(context, issue),'],
      ['action: "unarchive",', 'action: "update", updatedFrom: issueWebhookPayload(context, issue),'],
      ['secret: nullableString(input.secret),', 'secret: nullableString(input.secret) ?? randomBytes(32).toString("hex"),'],
      ['secret: whCfg.secret ?? null,', 'secret: whCfg.secret ?? randomBytes(32).toString("hex"),'],
      ['const updated = ls().comments.update(comment.id, { body: requiredString(input.body, "body") });',
        'const updated = ls().comments.update(comment.id, { body: requiredString(input.body, "body"), edited: true, edited_at: new Date().toISOString() });'],
      ['body: comment.body,\n    issueId: comment.issue_id,',
        'body: comment.body,\n    archivedAt: null,\n    edited: comment.edited ?? false,\n    editedAt: comment.edited_at ?? null,\n    issueId: comment.issue_id,'],
      ['identifier: issue.identifier,\n    title: issue.title,',
        `identifier: issue.identifier,
    number: issue.number,
    priorityLabel: ["No priority", "Urgent", "High", "Medium", "Low"][issue.priority],
    creatorId: issue.creator_id,
    projectId: issue.project_id,
    cycleId: issue.cycle_id,
    dueDate: issue.due_date,
    startedAt: issue.started_at,
    completedAt: issue.completed_at,
    canceledAt: issue.canceled_at,
    labelIds: [...issue.label_ids],
    title: issue.title,`],
      ['map((label) => ({ id: label.linear_id, name: label.name }))',
        'map((label) => ({ id: label.linear_id, name: label.name, color: label.color }))'],
      ['function labelWebhookPayload(_context, label) {\n  return {',
        'function labelWebhookPayload(_context, label) {\n  return {\n    isGroup: false,'],
    ],
  });
}

export function configureLinearWebhookDelivery(store, { fetchImpl = fetch, timeoutMs = 5000,
  retryDelays = [60_000, 3_600_000, 21_600_000], sleep = delay } = {}) {
  controllers.get(store)?.close();
  const pending = new Set();
  const stop = new AbortController();
  let closed = false;
  const controller = {
    async drain() { while (pending.size) await Promise.all([...pending]); },
    close() { closed = true; stop.abort(); },
    enqueue(webhook, payload) {
      const task = deliver(structuredClone(webhook), structuredClone(payload)).catch(() => {});
      pending.add(task);
      task.finally(() => pending.delete(task));
    },
  };
  async function deliver(webhook, payload) {
    const deliveryId = randomUUID();
    for (let retry = 0; retry <= retryDelays.length && !closed; retry++) {
      if (retry) await sleep(retryDelays[retry - 1], undefined, { signal: stop.signal, ref: false });
      if (closed) return;
      // Deleting or disabling a subscription prevents later delivery attempts.
      const current = collection(store, "webhooks").all().find((entry) => entry.linear_id === webhook.linear_id);
      if (!current?.enabled) return;
      payload.webhookTimestamp = Date.now();
      const body = JSON.stringify(payload);
      const headers = {
        "Accept-Charset": "utf-8", "Content-Type": "application/json; charset=utf-8",
        "Linear-Delivery": deliveryId, "Linear-Event": payload.type,
        "Linear-Timestamp": String(payload.webhookTimestamp), "User-Agent": "Linear-Webhook",
        "Linear-Signature": createHmac("sha256", webhook.secret).update(body).digest("hex"),
      };
      let status = null, error = null;
      try {
        const response = await fetchImpl(webhook.url, { method: "POST", headers, body,
          redirect: "manual", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]) });
        status = response.status;
        await response.body?.cancel();
      } catch (cause) { error = cause.message; }
      collection(store, "webhook_deliveries").insert({ linear_id: randomUUID(), webhook_id: webhook.linear_id,
        event: payload.type, action: payload.action, url: webhook.url, status, error,
        payload: structuredClone(payload), headers, retry });
      if (status === 200) return;
    }
  }
  controllers.set(store, controller);
  return controller;
}

export function queueLinearWebhook(store, input) {
  // Agent session notifications have a different protocol from data changes.
  if (!["Issue", "Comment", "IssueLabel"].includes(input.type)) return;
  const event = structuredClone(input);
  const organization = collection(store, "organizations").all()[0];
  const controller = controllers.get(store) ?? configureLinearWebhookDelivery(store);
  for (const webhook of collection(store, "webhooks").all()) {
    if (!webhook.enabled || (!webhook.resource_types.includes(event.type) && !webhook.resource_types.includes("*"))) continue;
    const team = event.teamId ? collection(store, "teams").all().find((entry) => entry.linear_id === event.teamId) : null;
    if (webhook.all_public_teams ? team?.private : webhook.team_id !== event.teamId) continue;
    // Older snapshots can have unsigned hooks. Keep the generated key in state,
    // where the native webhook query can return it to the app.
    if (!webhook.secret) {
      webhook.secret = randomBytes(32).toString("hex");
      collection(store, "webhooks").update(webhook.id, { secret: webhook.secret });
    }
    const updatedFrom = event.updatedFrom && Object.fromEntries(Object.entries(event.updatedFrom)
      .filter(([key, value]) => !isDeepStrictEqual(value, event.data?.[key])));
    controller.enqueue(webhook, {
      action: event.action, type: event.type,
      // The pinned mutation handlers supply User records, including app users.
      // A User.app flag does not identify an Integration or its service.
      actor: event.actor ? { id: event.actor.linear_id, type: "user",
        name: event.actor.name, email: event.actor.email,
        url: `https://linear.app/user/${encodeURIComponent(event.actor.email)}`,
        avatarUrl: event.actor.avatar_url ?? null } : null,
      data: event.data, url: event.type === "Comment" && event.url
        ? `${event.url}#comment-${event.data.id}` : event.url ?? null,
      createdAt: new Date().toISOString(),
      organizationId: organization?.linear_id ?? null, webhookId: webhook.linear_id,
      ...(updatedFrom ? { updatedFrom } : {}),
    });
  }
}
