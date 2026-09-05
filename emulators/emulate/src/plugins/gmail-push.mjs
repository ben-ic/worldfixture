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
function matchesFilter(gs, userEmail, sinceId, labelIds) {
  const events = gs.history
    .findBy("user_email", userEmail)
    .filter((e) => compareHistoryIds(e.gmail_id, sinceId) > 0);

  if (events.length === 0) return false;
  if (!labelIds || labelIds.length === 0) return true;

  return events.some((e) => (e.label_ids ?? []).some((id) => labelIds.includes(id)));
}

// A push subscription belongs to the same project as the topic it is attached to,
// so the client's own `topicName` decides the name -- `projects/P/topics/T` gives
// `projects/P/subscriptions/gmail-push`. Deriving it beats naming a project here:
// the envelope now agrees with what the app registered instead of asserting a
// project nothing else has heard of.
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
export function startGmailPush({ store, getGoogleStore, pushUrl, intervalMs = 2000, log = () => {} }) {
  if (!pushUrl) return () => {};

  const gs = getGoogleStore(store);
  const delivered = new Map();
  let deliveryId = 1;
  let inFlight = false;


  async function tick() {
    if (inFlight) return;
    inFlight = true;

    try {
      const states = store.getData(WATCH_STATE_KEY);
      if (!states || states.size === 0) return;

      for (const [emailAddress, state] of states) {
        const historyId = currentHistoryId(gs, emailAddress);

        // The FIRST tick after a watch registers only records where the mailbox
        // already was. Delivering then would push the whole seeded backlog at a
        // visitor the moment they sign in, which is not what a real mailbox does.
        if (!delivered.has(emailAddress)) {
          delivered.set(emailAddress, historyId);
          continue;
        }

        const since = delivered.get(emailAddress);
        if (compareHistoryIds(historyId, since) <= 0) continue;
        if (!matchesFilter(gs, emailAddress, since, state.labelIds)) {
          delivered.set(emailAddress, historyId);
          continue;
        }

        const body = envelope({
          emailAddress,
          historyId,
          subscription: subscriptionFor(state.topicName),
          deliveryId: deliveryId++,
        });

        try {
          const response = await fetch(pushUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });

          // Pub/Sub redelivers what is not acknowledged. We advance only on a 2xx, so
          // an app that is still starting gets the notification on the next tick
          // rather than losing it.
          if (response.ok) {
            delivered.set(emailAddress, historyId);
            log(`gmail push delivered: ${emailAddress} historyId=${historyId}`);
          } else {
            log(`gmail push rejected: ${response.status} — will retry`);
          }
        } catch (err) {
          log(`gmail push failed: ${err?.message ?? err} — will retry`);
        }
      }
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
