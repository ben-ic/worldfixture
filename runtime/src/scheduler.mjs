// The persisted schedule is the source for delivery and timeline inspection.
// One runtime controller serializes ticks, advance and reset. Each due arrival
// uses a public provider API; failed, skipped and interrupted attempts remain
// distinct from accepted writes. Delayed effects drain in due-time order.

import { randomUUID } from "node:crypto";

import { appendEvent } from "./state.mjs";
import { elapsedMs, withClockElapsed } from "./clock.mjs";
import { deliverEffect, worldNow } from "./causal-queue.mjs";
import { deliverArrival } from "./arrivals.mjs";

const id = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

export const DEFAULT_TICK_MS = 250;

// ---- arming --------------------------------------------------------------

// Put the world's timeline into `scheduled_events`, once, in world order.
//
// The table is the schedule, not the world file. That matters for two reasons:
// a run can be inspected to see what is still pending, and `delivered_at` is the
// persisted outcome prevents another normal tick from replaying an arrival.
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

// Append a new pass. Keep the clock, provider state, and all delivery evidence.
export function appendTimelinePass(db, world, { offset, cycle }) {
  const rows = (world.timeline ?? []).filter(event => event?.id && event.kind).map(event => ({
    id: `loop:${cycle}:${event.id}`, due: offset + Math.round(Number(event.after_seconds ?? 0) * 1000), event,
  }));
  if (rows.some(row => !Number.isSafeInteger(row.due) || row.due < 0)) throw new Error('Loop schedule exceeds the supported clock range');
  db.exec('SAVEPOINT append_timeline_pass');
  try {
    const insert = db.prepare('INSERT INTO scheduled_events(id,due_at,type,payload) VALUES(?,?,?,?)');
    for (const { id, due, event } of rows) insert.run(id, due, event.kind, JSON.stringify(event.payload ?? {}));
    db.prepare('UPDATE timeline_cycle SET cycle=? WHERE id=1').run(cycle);
    db.exec('RELEASE append_timeline_pass');
  } catch (error) { db.exec('ROLLBACK TO append_timeline_pass'); db.exec('RELEASE append_timeline_pass'); throw error; }
  return rows.length;
}

export function pending(db) {
  return db.prepare("SELECT * FROM scheduled_events WHERE status = 'pending' ORDER BY due_at, id").all();
}

export function due(db, elapsed) {
  return db
    .prepare("SELECT * FROM scheduled_events WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id")
    .all(elapsed);
}

export function timelineState(db) {
  const summary = { total: 0, pending: 0, in_flight: 0, delivered: 0, failed: 0, skipped: 0, uncertain: 0, next_due_ms: null };
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM scheduled_events GROUP BY status').all()) {
    summary[row.status] = row.count; summary.total += row.count;
  }
  summary.next_due_ms = db.prepare("SELECT MIN(due_at) AS due FROM scheduled_events WHERE status='pending'").get().due;
  return summary;
}

export function timelineRecords(db, query = {}) {
  const input = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query);
  const valuesByName = {}, allowed = new Set(['after', 'limit', 'fromMs', 'toMs']);
  function badQuery(message) { const error = new Error(message); error.code = 'bad_timeline_query'; error.status = 400; throw error; }
  for (const [key, value] of input) {
    if (!allowed.has(key) || Object.hasOwn(valuesByName, key)) badQuery('Unknown or duplicate timeline query field');
    if (value === undefined) continue;
    if (typeof value === 'string' && !/^\d+$/.test(value)) badQuery('Timeline query values must be whole nonnegative numbers');
    valuesByName[key] = typeof value === 'string' ? Number(value) : value;
  }
  const { after = 0, limit = 100, fromMs, toMs } = valuesByName;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) badQuery('Timeline cursor and limit must be valid nonnegative integers; limit is 1..1000');
  for (const value of [fromMs, toMs]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) badQuery('Timeline time bounds must be nonnegative safe integers');
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) badQuery('Timeline start must not exceed its end');
  const where = ['seq > ?'], values = [after];
  if (fromMs !== undefined) { where.push('due_at >= ?'); values.push(fromMs); }
  if (toMs !== undefined) { where.push('due_at <= ?'); values.push(toMs); }
  const rows = db.prepare(`SELECT * FROM scheduled_events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...values, limit + 1);
  const data = rows.slice(0, limit).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  return { data, next_cursor: data.at(-1)?.seq ?? after, has_more: rows.length > limit,
    total_count: db.prepare(`SELECT COUNT(*) AS count FROM scheduled_events${where.length > 1 ? ` WHERE ${where.slice(1).join(' AND ')}` : ''}`).get(...values.slice(1)).count };
}

// ---- one arrival ---------------------------------------------------------

// Record a claim before the provider call; interrupted claims require inspection.
export async function playOne(db, row, context) {
  const current = db.prepare('SELECT * FROM scheduled_events WHERE id=?').get(row.id);
  if (current && current.status !== 'pending') return { arrival: row.id, id: row.id, kind: row.type, status: current.status, reason: current.error };
  const payload = JSON.parse(row.payload);
  const command = {
    id: id("cmd"),
    type: "world.timeline.arrival.v1",
    actor_id: payload.actor_id ?? payload.author_id ?? payload.from_id ?? (row.type === "world.causal.effect.v1" ? payload.payload?.actor_id : null) ?? null,
    target: { service: "scheduler", arrival: row.id },
    input: { kind: row.type, due_at: row.due_at },
  };

  db.prepare(
    `INSERT INTO commands(id, type, actor_id, target, input, idempotency_key, status, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`,
  ).run(command.id, command.type, command.actor_id, JSON.stringify(command.target), JSON.stringify(command.input),
    `timeline:${row.id}`, Date.now());

  db.prepare("UPDATE scheduled_events SET status='in_flight',attempted_at=?,command_id=? WHERE id=? AND status='pending'").run(Date.now(), command.id, row.id);
  let outcome;
  try {
    outcome = row.type === "world.causal.effect.v1"
      ? await deliverEffect(db, payload, { ...context, commandId: command.id })
      : await deliverArrival(db, { id: row.id, kind: row.type, payload }, { ...context, commandId: command.id });
  } catch (error) {
    outcome = { status: "failed", reason: error.message };
  }

  if (outcome.status === "failed" || outcome.status === "skipped") {
    appendEvent(db, {
      id: id("evt"),
      type: `world.timeline.arrival.${outcome.status}.v1`,
      actor_id: command.actor_id,
      source: "scheduler",
      occurred_at: new Date(worldNow(db, context.now?.() ?? Date.now())).toISOString(),
      provider_evidence: { arrival: row.id, kind: row.type, reason: outcome.reason },
      caused_by: command.id,
    });
  }

  db.prepare("UPDATE commands SET status = ?, failure = ? WHERE id = ?").run(
    outcome.status === "delivered" ? "accepted" : outcome.status,
    outcome.reason ?? null,
    command.id,
  );
  const eventId = outcome.event_id ?? outcome.event?.id ?? db.prepare('SELECT event_id FROM commands WHERE id=?').get(command.id)?.event_id
    ?? db.prepare('SELECT id FROM events WHERE caused_by=? ORDER BY seq LIMIT 1').get(command.id)?.id ?? null;
  db.prepare('UPDATE commands SET event_id=COALESCE(event_id,?) WHERE id=?').run(eventId, command.id);
  db.prepare('UPDATE scheduled_events SET status=?,delivered_at=?,completed_at=?,event_id=?,error=? WHERE id=?')
    .run(outcome.status, outcome.status === 'delivered' ? Date.now() : null, Date.now(), eventId, outcome.reason ?? null, row.id);

  return { arrival: row.id, id: row.id, kind: row.type, due_at: row.due_at, event_id: eventId, ...outcome };
}

// Every arrival now due, in world order, one at a time.
//
// Serial on purpose. Two arrivals a second apart tell a story in that order, and
// running them concurrently would let the later one's Slack message land first.
export async function playDue(db, context, { now = Date.now() } = {}) {
  const elapsed = elapsedMs(db, now);
  const played = [];
  for (;;) {
    if (context.shouldStop?.()) break;
    const row = db.prepare("SELECT * FROM scheduled_events WHERE status='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1").get(elapsed);
    if (!row) break;
    const result = await withClockElapsed(db, row.due_at, () => playOne(db, row, context));
    played.push(result);
    if (result.status === 'failed' && context.stopOnFailure) break;
  }
  return played;
}
