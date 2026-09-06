// World time starts after provider readiness. Pause excludes wall time; advance
// moves only forward. Scheduled delivery uses its due time for observed events
// and delayed effects without moving the public cursor backwards.

import { AsyncLocalStorage } from 'node:async_hooks';

const deliveryTime = new AsyncLocalStorage();
// Only the current async delivery sees its scheduled time. Public clock reads
// retain the live cursor, and delayed effects remain relative to their cause.
export function withClockElapsed(db, milliseconds, work) {
  return deliveryTime.run({ db, milliseconds }, work);
}
export function parseDuration(value) {
  if (typeof value !== 'string' || !/^(?:\d+)(?:\.\d+)?(?:ms|s|m|h|d|w)$/.test(value)) {
    throw new ClockError('bad_duration', 'Use a nonnegative duration such as 90s, 5m, or 1w');
  }
  const [, number, unit] = value.match(/^(.*?)(ms|s|m|h|d|w)$/);
  const result = Number(number) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  if (!Number.isSafeInteger(result)) throw new ClockError('bad_duration', 'Duration must be a safe whole number of milliseconds');
  return result;
}

const ROW = "SELECT world_anchor, started_at, paused_at, offset_ms FROM clock WHERE id = 1";

export class ClockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClockError";
    this.code = code;
    this.status = 400;
  }
}

// The world's own time origin, kept so a reader can tell what "now" means
// inside the world as well as how far the run has travelled.
export function startClock(db, { anchor, now = Date.now() }) {
  db.prepare(
    `INSERT INTO clock(id, world_anchor, started_at, paused_at, offset_ms) VALUES (1, ?, ?, NULL, 0)
     ON CONFLICT(id) DO UPDATE SET world_anchor = excluded.world_anchor,
       started_at = excluded.started_at, paused_at = NULL, offset_ms = 0`,
  ).run(String(anchor ?? ""), now);
  return { anchor, elapsed_ms: 0, running: true };
}

function clockRow(db) {
  return db.prepare(ROW).get() ?? null;
}

// World-elapsed milliseconds.
//
// `offset_ms` accumulates every interval the clock has already run, plus any
// manual advance. `started_at` is the wall time the current running interval
// began, and is null while paused. Keeping the two apart means a pause costs no
// world time and an advance costs no wall time, which is what makes the two
// operations independent.
export function elapsedMs(db, now = Date.now()) {
  const delivery = deliveryTime.getStore();
  if (delivery?.db === db) return delivery.milliseconds;
  const row = clockRow(db);
  if (!row) return 0;
  return row.offset_ms + (row.started_at === null ? 0 : Math.max(0, now - row.started_at));
}

export function isRunning(db) {
  const row = clockRow(db);
  return Boolean(row && row.started_at !== null);
}

export function pauseClock(db, { now = Date.now() } = {}) {
  const row = clockRow(db);
  if (!row) throw new ClockError("clock_not_started", "this instance has no clock to pause");
  if (row.started_at === null) return { elapsed_ms: row.offset_ms, running: false };

  const elapsed = row.offset_ms + Math.max(0, now - row.started_at);
  db.prepare("UPDATE clock SET offset_ms = ?, started_at = NULL, paused_at = ? WHERE id = 1").run(elapsed, now);
  return { elapsed_ms: elapsed, running: false };
}

export function resumeClock(db, { now = Date.now() } = {}) {
  const row = clockRow(db);
  if (!row) throw new ClockError("clock_not_started", "this instance has no clock to resume");
  if (row.started_at !== null) return { elapsed_ms: elapsedMs(db, now), running: true };

  db.prepare("UPDATE clock SET started_at = ?, paused_at = NULL WHERE id = 1").run(now);
  return { elapsed_ms: row.offset_ms, running: true };
}

// Check the whole target without changing the clock. Setup and running controls
// use this before changing mode, pause state, or repeat policy.
export function validateAdvanceTarget(milliseconds, { elapsed_ms = 0, anchor } = {}) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new ClockError('bad_advance', 'Advance takes a nonnegative safe integer number of milliseconds');
  }
  const target = elapsed_ms + milliseconds, origin = Date.parse(anchor);
  if (!Number.isSafeInteger(target) || target < 0 || (Number.isFinite(origin) && !Number.isFinite(new Date(origin + target).getTime()))) {
    throw new ClockError('bad_advance', 'Advance exceeds the supported clock range');
  }
  return target;
}

// Move the world forward without waiting. A paused clock stays paused: advance
// answers "what would have happened by then", and resuming afterwards would
// otherwise be indistinguishable from never having paused.
export function advanceClock(db, milliseconds, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new ClockError("bad_advance", `advance takes a positive number of milliseconds, not ${milliseconds}`);
  }
  const row = clockRow(db);
  if (!row) throw new ClockError("clock_not_started", "this instance has no clock to advance");

  validateAdvanceTarget(milliseconds, { elapsed_ms: elapsedMs(db, now), anchor: row.world_anchor });
  db.prepare("UPDATE clock SET offset_ms = offset_ms + ? WHERE id = 1").run(milliseconds);
  return { elapsed_ms: elapsedMs(db, now), running: row.started_at !== null };
}

export function clockState(db, { now = Date.now() } = {}) {
  const row = clockRow(db);
  if (!row) return { started: false, running: false, elapsed_ms: 0, anchor: null };
  return {
    started: true,
    running: row.started_at !== null,
    elapsed_ms: elapsedMs(db, now),
    anchor: row.world_anchor || null,
  };
}
