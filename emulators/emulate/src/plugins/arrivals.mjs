// Mail that arrives while somebody is watching.
//
// WHY THIS EXISTS. A seeded mailbox is static: the seed is applied once at start and
// nothing ever changes, so `historyId` never advances and a push subscription — however
// correctly implemented — would have nothing to deliver, forever. The demo would show a
// correct, complete, inert inbox, and the one thing an inbox demo is FOR, watching the
// software react to a message it has not seen before, would be missing.
//
// So the seed gains a WorldFixture-owned block the vendor emulator never sees:
//
//     worldfixture:
//       arrivals:
//         - after_seconds: 45
//           message:
//             from: ...
//             subject: ...
//             body_text: ...
//
// Each one is delivered by POSTing to the emulator's OWN Gmail API — `messages.insert`,
// which it already implements — with the seeded token. Nothing reaches into the store
// behind the emulator's back, so the message is created through exactly the path a real
// insert takes, history is recorded by the same code that records it for everything
// else, and push falls out rather than being staged. If `messages.insert` ever changes
// behaviour, this changes with it.
//
// Times are relative to process start, which is close enough to session start: the
// artifact is launched with the session and the µVM dies with it.

function encodeMessage(message) {
  const { label_ids, labelIds, ...rest } = message;

  return {
    ...rest,
    // The seed writes `label_ids`, matching how a seeded message is declared; the API
    // takes `labelIds`. Accept either so an arrival can be copy-pasted from the seed.
    // INBOX + UNREAD is the default because `messages.insert` files a message under NO
    // labels at all when none are given — it would arrive invisibly.
    labelIds: labelIds ?? label_ids ?? ["INBOX", "UNREAD"],
  };
}

/**
 * Schedule every arrival declared in the seed. Returns a cancel function.
 */
export function scheduleArrivals({ arrivals, origin, token, defaultUser, log = () => {} }) {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return () => {};

  if (!token) {
    log("arrivals declared but the seed has no token to insert them with — skipping");
    return () => {};
  }

  const timers = arrivals.map((arrival, index) => {
    const delayMs = Math.max(0, Number(arrival.after_seconds ?? 0)) * 1000;
    const user = arrival.user ?? defaultUser ?? "me";

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `${origin}/gmail/v1/users/${encodeURIComponent(user)}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(encodeMessage(arrival.message ?? {})),
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (response.ok) {
          log(`arrival ${index + 1}/${arrivals.length} delivered to ${user}`);
        } else {
          log(`arrival ${index + 1} rejected: HTTP ${response.status} ${await response.text()}`);
        }
      } catch (err) {
        log(`arrival ${index + 1} failed: ${err?.message ?? err}`);
      }
    }, delayMs);

    timer.unref?.();
    return timer;
  });

  return () => timers.forEach(clearTimeout);
}
