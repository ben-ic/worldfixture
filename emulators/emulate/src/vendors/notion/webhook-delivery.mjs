// Notion transport. Payload construction and signatures stay in admin.mjs.
const runtimes = new WeakMap();
const GENERATION = "notion_webhook_delivery_generation";
export function closeNotionWebhookDelivery(store) { runtimes.get(store)?.close(); }

export function notionDeliveryConfig(store) {
  const config = store.getData("notion_webhook_delivery_config") ?? {};
  return { ...config, live_delivery: config.live_delivery === true || process.env.WORLDFIXTURE_NOTION_WEBHOOK_DELIVERY === "1" };
}

export function notionWebhookUrlError(store, value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return "The webhook URL cannot contain credentials.";
    if (url.protocol === "https:") return null;
    if (url.protocol === "http:" && notionDeliveryConfig(store).allow_insecure_http === true) return null;
    return "The webhook URL must use HTTPS. Local fixtures can set webhooks.allow_insecure_http to true.";
  } catch { return "The webhook URL is not valid."; }
}

export function createNotionDelivery(store, subscriptions, sign) {
  if (runtimes.has(store)) return runtimes.get(store);
  const pending = new Set();
  const timers = new Set();
  const stop = new AbortController();
  let closed = false;
  const config = () => notionDeliveryConfig(store);

  function send(collection, record, verification = false) {
    if (closed || !config().live_delivery) return;
    if (!store.getData(GENERATION)) store.setData(GENERATION, {});
    const generation = store.getData(GENERATION);
    collection.update(record.id, { live_delivery: true, status: "pending", attempts: [] });
    const run = async (attemptNumber) => {
      if (closed || store.getData(GENERATION) !== generation) return;
      const current = collection.findOneBy("notion_id", record.notion_id);
      const subscription = subscriptions.findOneBy("notion_id", record.subscription_id);
      if (!current) return;
      if (!config().live_delivery || !subscription || subscription.url !== record.url ||
          (verification ? subscription.status !== "pending" : subscription.status !== "active" || !subscription.event_types.includes(record.event_type))) {
        collection.update(record.id, { status: "canceled", next_attempt_at: null });
        return;
      }
      const payload = verification ? record.payload : { ...record.payload, attempt_number: attemptNumber };
      const rawBody = JSON.stringify(payload);
      const signature = sign(rawBody, subscription.verification_token);
      const headers = { "Content-Type": "application/json", "X-Notion-Signature": signature };
      const attempt = { attempt_number: attemptNumber, started_at: new Date().toISOString(), raw_body: rawBody, headers };
      collection.update(record.id, { status: "delivering", payload, raw_body: rawBody, headers, signature, next_attempt_at: null });
      try {
        const urlError = notionWebhookUrlError(store, subscription.url);
        if (urlError) throw new Error(urlError);
        const response = await fetch(subscription.url, {
          method: "POST", headers, body: rawBody, redirect: "manual",
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(config().timeout_ms ?? 10000)]),
        });
        attempt.status_code = response.status;
        await response.body?.cancel().catch(() => {});
        if (response.status < 200 || response.status >= 300) attempt.error = `HTTP ${response.status}`;
      } catch (error) { attempt.error = error.message; }
      if (closed || store.getData(GENERATION) !== generation) return;
      attempt.completed_at = new Date().toISOString();
      const attempts = [...(current.attempts ?? []), attempt];
      // Notion documents eight delivery attempts and about 24 hours in total.
      // It does not publish the exact intervals. This exponential fixture
      // schedule has seven delays whose sum is 24 hours.
      const retry = !closed && attempt.error && !verification && attemptNumber < 8;
      const delay = Math.round((86400000 / 127) * 2 ** (attemptNumber - 1) * (config().retry_delay_scale ?? 1));
      collection.update(record.id, {
        attempts, status: retry ? "retrying" : attempt.error ? "failed" : "delivered",
        response_status: attempt.status_code ?? null, error: attempt.error ?? null,
        next_attempt_at: retry ? new Date(Date.now() + delay).toISOString() : null,
      });
      if (retry) {
        const timer = setTimeout(() => { timers.delete(timer); launch(attemptNumber + 1); }, delay);
        timer.unref?.();
        timers.add(timer);
      }
    };
    const launch = (number) => {
      const task = run(number);
      pending.add(task);
      task.finally(() => pending.delete(task));
    };
    launch(1);
  }

  const runtime = {
    send,
    async waitForIdle() { while (pending.size) await Promise.all([...pending]); },
    close() { closed = true; stop.abort(); for (const timer of timers) clearTimeout(timer); timers.clear(); runtimes.delete(store); },
  };
  runtimes.set(store, runtime);
  return runtime;
}
