// Gmail push delivery — the half of Pub/Sub upstream stopped short of.
//
// `@emulators/google` already implements the whole registration side:
// `users.watch` validates the topic and label filter and stores them under
// `google.gmail.watchStates`, `users.stop` clears it, `users.history.list` is a
// complete implementation with history types, label filtering and pagination, and
// every message mutation records history events through `recordHistoryEvents`.
//
// Then nothing ever reads that state again. There is not one outbound `fetch(` in the
// Google emulator, in 0.8.0 or in 0.10.0 — the subscription is recorded and never
// delivered. This file is only the delivery.
//
// WHAT REAL PUB/SUB DOES, and what we imitate: when Gmail sees a change for a watched
// user it publishes to the topic, and a push subscription POSTs an envelope to the
// subscriber's endpoint. The envelope carries no content — only
// `{emailAddress, historyId}` — and the app is expected to call `history.list` to find
// out what actually changed. So this is a notification, not a feed, and the fidelity
// that matters is the envelope shape and the historyId, both of which come from the
// emulator's own store rather than from anything we invent.
//
// THE PUSH ENDPOINT IS CONFIGURED, NOT DISCOVERED. In production the subscription is
// created once in the Google console and Gmail never learns the URL — so an app that
// only calls `watch` (Inbox Zero is one) gives us nothing to deliver to. The launch
// supplies it instead, composed from the app's own public origin and the verification
// token minted for that session. An app that creates its own subscription would need
// the Pub/Sub admin API, which is a separate surface and not this file.
//
// SO THIS MODULE LOOKS DEAD AND IS NOT. `main.mjs` calls `startGmailPush` only
// when `WORLDFIXTURE_PUBSUB_PUSH_URL` is set, and nothing in this repository sets
// it -- the launch does, per session, with the app's own origin. A sweep for
// unreachable code will find no in-repo caller for the delivery path. Do not
// remove it on that evidence: the environment variable IS the caller, and
// `gmail-push.test.mjs` beside this file exercises the module directly.

const WATCH_STATE_KEY = "google.gmail.watchStates";

// Copied from `@emulators/google`'s internal helpers, which do not export it.
// History ids are compared as BigInts because they are minted far above the range a
// JS number holds exactly.
function compareHistoryIds(left, right) {
  try {
    const l = BigInt(left);
    const r = BigInt(right);
    return l === r ? 0 : l > r ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function currentHistoryId(gs, userEmail) {
  const ids = [
    ...gs.messages.findBy("user_email", userEmail).map((m) => m.history_id),
    ...gs.history.findBy("user_email", userEmail).map((e) => e.gmail_id),
  ].filter(Boolean);

  if (ids.length === 0) return "0";
  return ids.reduce((latest, current) => (compareHistoryIds(current, latest) > 0 ? current : latest));
}

// Whether anything the watch actually asked about changed. A watch with no `labelIds`
// asks about everything, which is Gmail's own default.
function matchesFilter(gs, userEmail, sinceId, labelIds, behavior) {
  const events = gs.history
    .findBy("user_email", userEmail)
    .filter((e) => compareHistoryIds(e.gmail_id, sinceId) > 0);

  if (events.length === 0) return false;
  if (!labelIds || labelIds.length === 0) return true;

  return events.some((e) => {
    const matches = (e.label_ids ?? []).some((id) => labelIds.includes(id));
    return String(behavior).toLowerCase() === "exclude" ? !matches : matches;
  });
}

// Default local subscription name. Real Pub/Sub also permits subscriptions in a
// different project; the explicit subscription option supplies that full name.
export function subscriptionFor(topicName) {
  const project = /^projects\/([^/]+)\/topics\//.exec(topicName ?? "")?.[1];
  return project ? `projects/${project}/subscriptions/gmail-push` : "projects/worldfixture/subscriptions/gmail-push";
}

function envelope({ emailAddress, historyId, subscription, deliveryId }) {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString("base64url");

  return {
    message: {
      data,
      messageId: String(deliveryId),
      publishTime: new Date().toISOString(),
      attributes: {},
    },
    subscription,
  };
}

/**
 * Watch the Google store and POST a Pub/Sub envelope whenever a watched mailbox
 * advances. Returns a stop function.
 *
 * The loop polls because the emulator offers no change hook — the alternative was
 * patching every mutation path, which is exactly the fork this artifact avoids. A
 * two-second tick is imperceptible next to a fifteen-minute session and costs a map
 * lookup per user.
 */
export function startGmailPush({ store, getGoogleStore, pushUrl, subscription, intervalMs = 2000, fetchImpl = fetch, log = () => {} }) {
  if (!pushUrl) return () => {};
  const gs = getGoogleStore(store);
  const delivered = new Map();
  let deliveryId = BigInt(Date.now()) * 1000n;
  let inFlight = false;
  let closed = false;
  const abort = new AbortController();

  async function tick() {
    if (inFlight || closed) return;
    inFlight = true;
    try {
      const states = store.getData(WATCH_STATE_KEY) ?? new Map();
      for (const email of delivered.keys()) if (!states.has(email)) delivered.delete(email);
      for (const [emailAddress, state] of states) {
        if (closed) break;
        // A stop, watch renewal, or store reset can occur during the previous POST.
        if (store.getData(WATCH_STATE_KEY)?.get(emailAddress) !== state) continue;
        if (Number(state.expiration) <= Date.now()) { delivered.delete(emailAddress); continue; }
        const historyId = currentHistoryId(gs, emailAddress);
        let cursor = delivered.get(emailAddress);
        if (!cursor || cursor.state !== state) {
          // A successful Gmail watch sends an initial Pub/Sub notification.
          cursor = { state, historyId: null, pending: null };
          delivered.set(emailAddress, cursor);
        }
        if (!cursor.pending) {
          if (cursor.historyId !== null && compareHistoryIds(historyId, cursor.historyId) <= 0) continue;
          if (cursor.historyId !== null && !matchesFilter(gs, emailAddress, cursor.historyId, state.labelIds, state.labelFilterBehavior)) {
            cursor.historyId = historyId;
            continue;
          }
          const body = envelope({ emailAddress, historyId, subscription: subscription ?? subscriptionFor(state.topicName), deliveryId: String(deliveryId++) });
          cursor.pending = { historyId, rawBody: JSON.stringify(body) };
        }
        try {
          const response = await fetchImpl(pushUrl, { method: "POST", redirect: "manual",
            headers: { "Content-Type": "application/json" }, body: cursor.pending.rawBody,
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) });
          await response.body?.cancel();
          if ([102, 200, 201, 202, 204].includes(response.status)) {
            cursor.historyId = cursor.pending.historyId;
            cursor.pending = null;
            log(`gmail push delivered: ${emailAddress} historyId=${cursor.historyId}`);
          } else log(`gmail push rejected: ${response.status} — will retry`);
        } catch (err) { if (!closed) log(`gmail push failed: ${err?.message ?? err} — will retry`); }
      }
    } finally { inFlight = false; }
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const stop = () => { closed = true; abort.abort(); clearInterval(timer); };
  stop.tick = tick;
  return stop;
}
