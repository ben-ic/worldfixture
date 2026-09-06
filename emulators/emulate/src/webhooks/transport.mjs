// HTTP transport only. Each provider owns its body, headers, and retry policy.
export function createWebhookTransport({ fetchImpl = fetch, retryDelays = [], timeoutMs = 15_000,
  headers = () => ({}), isActive = () => true, accepted = response => response.ok,
  shouldRetry = () => true,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Set();
  const timers = new Set();
  const deliveries = [];
  let closed = false;
  const stop = new AbortController();

  async function attempt(delivery) {
    if (closed || !isActive(delivery)) { delivery.status = "cancelled"; return; }
    delivery.attempts += 1;
    delivery.status = "sending";
    let retry = true;
    try {
      const response = await fetchImpl(delivery.url, {
        method: "POST", redirect: "manual", body: delivery.rawBody,
        headers: headers(delivery), signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
      });
      delivery.statusCode = response.status;
      const success = accepted(response);
      retry = shouldRetry(response, null, delivery);
      // A body stream failure cannot turn an accepted HTTP status into a retry.
      await response.body?.cancel().catch(() => {});
      if (closed || !isActive(delivery)) { delivery.status = "cancelled"; return; }
      if (success) { delivery.status = "succeeded"; return; }
    } catch (error) { delivery.error = error.message; retry = shouldRetry(null, error, delivery); }
    const delay = retryDelays[delivery.attempts - 1];
    if (!retry || delay === undefined || closed || !isActive(delivery)) {
      delivery.status = closed || !isActive(delivery) ? "cancelled" : "failed";
      return;
    }
    delivery.status = "retrying";
    const timer = setTimer(() => { timers.delete(timer); run(delivery); }, delay);
    timer.unref?.();
    timers.add(timer);
  }
  function run(delivery) {
    const work = attempt(delivery);
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  return {
    deliveries,
    enqueue(input) {
      const delivery = { ...input, attempts: 0, status: "pending" };
      deliveries.push(delivery);
      if (deliveries.length > 1000) deliveries.shift();
      run(delivery);
      return delivery;
    },
    async drain() { while (pending.size) await Promise.all([...pending]); },
    close() {
      closed = true;
      stop.abort();
      for (const timer of timers) clearTimer(timer);
      timers.clear();
      for (const delivery of deliveries) {
        if (["pending", "sending", "retrying"].includes(delivery.status)) delivery.status = "cancelled";
      }
    },
  };
}
