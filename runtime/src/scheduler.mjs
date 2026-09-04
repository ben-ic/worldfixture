// The deterministic timeline scheduler.
//
// WHAT THIS FIXES. A world artifact carries a `timeline`: a list of facts that
// are meant to arrive after the world starts running, each with an
// `after_seconds`. `business.saas-company.v2` declares eight of them. Before
// this file, ONE of the eight was ever delivered -- the compiler's
// `_arrival_projection` kept `kind == "incoming-email"` and dropped the rest,
// and the survivor was played by a `setTimeout` inside the composer. The other
// seven were compiled, digested and verified into the artifact, and then nothing
// played them. A world that says a message arrives at t+20s and never delivers
// it is lying about its own contents.
//
// The scheduler is specified to support two kinds of arrival: deterministic
// scheduled events, and stochastic actor activation. This file is the
// deterministic half. There is no sampling here and no randomness: the same
// world plays the same events at the same world-relative times, every run.
//
// FOUR RULES IT KEEPS, each of which the shortcut version would break:
//
//   * EVERY ARRIVAL IS A REAL PROVIDER WRITE. A chat message goes through the
//     Slack Web API as its author. Mail goes over SMTP. A comment goes through
//     the GitHub API. Nothing reaches into an emulator's store, so an arrival is
//     indistinguishable from a person doing the same thing by hand -- which is
//     the point of the world being made of real interfaces.
//
//   * EVERY ARRIVAL IS AN EVENT, AND CAUSES WHAT IT SHOULD. Delivery goes
//     through `commands.mjs`, so an arrival records a command, records the fact
//     with the provider's own evidence, and fires the causal rules. A scheduled
//     Slack message therefore produces the same mail notifications a manual one
//     does. The composer's `setTimeout` could do none of this: it wrote to
//     Gmail from outside the runtime, with no ledger row and no rules.
//
//   * TIME IS WORLD TIME, NOT PROCESS TIME. Due times are compared against the
//     environment clock in `clock.mjs`, which starts after readiness. On a cold
//     machine, startup takes tens of seconds; a timeline counted from process
//     start would spend its opening minute before anything was listening.
//
//   * RESET RE-ARMS IT. `resetState` clears `scheduled_events` and `clock`, so
//     after a reset the world plays its timeline again from zero. An arrival
//     that had already been delivered before the reset is delivered again,
//     because the world was restored to the state in which it had not yet
//     happened.
//
// WHAT IT DOES NOT DO. It does not invent a destination. A `webhook` arrival
// needs a subscriber, and this instance may have none; that arrival is recorded
// as skipped WITH THE REASON rather than dropped silently or delivered somewhere
// it was not addressed.

import { randomUUID } from "node:crypto";

import { appendEvent } from "./state.mjs";
import { elapsedMs } from "./clock.mjs";
import { deliverArrival } from "./arrivals.mjs";

const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

export const DEFAULT_TICK_MS = 250;

// ---- arming --------------------------------------------------------------

// Put the world's timeline into `scheduled_events`, once, in world order.
//
// The table is the schedule, not the world file. That matters for two reasons:
// a run can be inspected to see what is still pending, and `delivered_at` is the
// idempotency record that stops a restarted tick from replaying an arrival.
export function armTimeline(db, world) {
  const timeline = [...(world.timeline ?? [])].sort(
    (left, right) => (left.after_seconds ?? 0) - (right.after_seconds ?? 0) || String(left.id).localeCompare(String(right.id)),
  );

  // REPLACE, never add. Arming happens when the clock starts at zero -- on `up`
  // and again after `reset` -- and at that moment the whole timeline is pending
  // by definition. An earlier version used `ON CONFLICT DO NOTHING`, and a state
  // directory reused across two different worlds kept the FIRST world's arrivals
  // in the table, already marked delivered. Measured: starting the larger world
  // in a directory that had run the smaller one armed 142 rows for a 134-event
  // timeline, eight of them belonging to a world that was no longer running.
  db.exec("DELETE FROM scheduled_events");

  const insert = db.prepare(
    `INSERT INTO scheduled_events(id, due_at, type, payload, caused_by, delivered_at)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  );

  let armed = 0;
  for (const event of timeline) {
    if (!event?.id || !event.kind) continue;
    insert.run(String(event.id), Math.round(Number(event.after_seconds ?? 0) * 1000), String(event.kind), JSON.stringify(event.payload ?? {}));
    armed += 1;
  }

  return { armed, total: timeline.length };
}

export function pending(db) {
  return db.prepare("SELECT * FROM scheduled_events WHERE delivered_at IS NULL ORDER BY due_at, id").all();
}

export function due(db, elapsed) {
  return db
    .prepare("SELECT * FROM scheduled_events WHERE delivered_at IS NULL AND due_at <= ? ORDER BY due_at, id")
    .all(elapsed);
}

export function timelineState(db) {
  const rows = db.prepare("SELECT delivered_at, due_at, type FROM scheduled_events ORDER BY due_at, id").all();
  const waiting = rows.filter((row) => row.delivered_at === null);
  return {
    total: rows.length,
    delivered: rows.length - waiting.length,
    pending: waiting.length,
    next_due_ms: waiting[0]?.due_at ?? null,
  };
}

// ---- one arrival ---------------------------------------------------------

// Deliver one row and record what happened to it.
//
// A failed delivery is marked delivered anyway, with a `scheduler.arrival.failed`
// event carrying the reason. Leaving it pending would make the tick retry it
// every 250ms for the rest of the run, and a world that floods its own ledger
// with one broken arrival is worse than one that reports the arrival as broken
// once. The distinction between "worked", "skipped" and "failed" is in the
// ledger, where a reader can see it.
export async function playOne(db, row, context) {
  const payload = JSON.parse(row.payload);
  const command = {
    id: id("cmd"),
    type: "world.timeline.arrival.v1",
    actor_id: payload.author_id ?? payload.from_id ?? null,
    target: { service: "scheduler", arrival: row.id },
    input: { kind: row.type, due_at: row.due_at },
  };

  db.prepare(
    `INSERT INTO commands(id, type, actor_id, target, input, idempotency_key, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`,
  ).run(command.id, command.type, command.actor_id, JSON.stringify(command.target), JSON.stringify(command.input),
    `timeline:${row.id}`, Date.now());

  let outcome;
  try {
    outcome = await deliverArrival(db, { id: row.id, kind: row.type, payload }, { ...context, commandId: command.id });
  } catch (error) {
    outcome = { status: "failed", reason: error.message };
  }

  if (outcome.status === "failed" || outcome.status === "skipped") {
    appendEvent(db, {
      id: id("evt"),
      type: `world.timeline.arrival.${outcome.status}.v1`,
      actor_id: command.actor_id,
      source: "scheduler",
      occurred_at: new Date(context.now?.() ?? Date.now()).toISOString(),
      provider_evidence: { arrival: row.id, kind: row.type, reason: outcome.reason },
      caused_by: command.id,
    });
  }

  db.prepare("UPDATE commands SET status = ?, failure = ? WHERE id = ?").run(
    outcome.status === "delivered" ? "accepted" : outcome.status,
    outcome.reason ?? null,
    command.id,
  );
  db.prepare("UPDATE scheduled_events SET delivered_at = ?, caused_by = ? WHERE id = ?")
    .run(Date.now(), command.id, row.id);

  return { arrival: row.id, kind: row.type, ...outcome };
}

// Every arrival now due, in world order, one at a time.
//
// Serial on purpose. Two arrivals a second apart tell a story in that order, and
// running them concurrently would let the later one's Slack message land first.
export async function playDue(db, context, { now = Date.now() } = {}) {
  const elapsed = elapsedMs(db, now);
  const played = [];
  for (const row of due(db, elapsed)) played.push(await playOne(db, row, context));
  return played;
}

// ---- the loop ------------------------------------------------------------

// Start ticking. Returns a handle with `stop()`, so the caller owns its
// lifetime: the supervisor stops it before it stops the services an arrival
// would otherwise try to write to.
export function startScheduler(db, context, { tickMs = DEFAULT_TICK_MS, now = () => Date.now(), onPlayed, onError } = {}) {
  let running = false;
  let stopped = false;
  let suspended = false;

  const tick = async () => {
    // One tick at a time. An arrival that takes longer than the interval --
    // a Slack message whose causal rule sends seven emails over SMTP -- must not
    // have the next tick start on top of it.
    if (running || stopped || suspended) return;
    running = true;
    try {
      const played = await playDue(db, context, { now: now() });
      if (played.length > 0) onPlayed?.(played);
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, tickMs);
  timer.unref?.();

  // Wait for an arrival in flight rather than cutting a provider write in half;
  // it holds a database row it is about to mark delivered.
  const settle = async () => {
    while (running) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  return {
    tick,
    // SUSPEND IS NOT STOP, and reset is why. Reset stops every application
    // surface, restores them, and starts them again; the scheduler has to be
    // quiet across that window and alive afterwards. An early version called
    // `stop()` there, which left the restored world with a timeline that could
    // never play -- a reset that silently disabled the thing it had just
    // re-armed.
    async suspend() {
      suspended = true;
      await settle();
    },
    resume() {
      suspended = false;
    },
    get suspended() {
      return suspended;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await settle();
    },
  };
}
