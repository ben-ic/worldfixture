// The environment clock.
//
// `runtime/src/state.mjs` has carried a `clock` table since the runtime was
// built and nothing has ever written to it. This is that writer.
//
// WHAT THE CLOCK IS FOR. A world declares a timeline in world-relative time:
// `after_seconds: 20` means twenty seconds after the world starts running, not
// twenty seconds after a Node process began. Those are different numbers, and
// the difference is the whole reason this file exists. Starting the composer,
// seeding Cyrus, waiting for SeaweedFS and proving readiness takes tens of
// seconds on a cold machine. A timeline counted from process start would have
// spent its first minute before anything was listening, and the first arrivals
// would land in a world nobody could observe yet -- which is exactly what the
// schema comment in `state.mjs` warned about: "Startup time does not consume the
// scenario timeline, so the live clock starts only after required readiness."
//
// SO THE CLOCK STARTS AFTER READINESS, and world-elapsed time is measured from
// there. The scheduler is also meant to support pause, resume and manual
// advance -- a fixture you cannot stop and step is much less useful for
// debugging -- so those are here rather than deferred: they are
// three lines each on top of the offset the clock already has to keep, and
// leaving them out would mean re-deriving the same arithmetic later.
//
// The clock is not a source of wall-clock time for anything else. Events still
// record real timestamps, because an event is a fact about when something
// actually happened. This clock answers one question: how far into its own
// timeline is this world.

const ROW = "SELECT world_anchor, started_at, paused_at, offset_ms FROM clock WHERE id = 1";

export class ClockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ClockError";
    this.code = code;
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

export function clockRow(db) {
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

// Move the world forward without waiting. A paused clock stays paused: advance
// answers "what would have happened by then", and resuming afterwards would
// otherwise be indistinguishable from never having paused.
export function advanceClock(db, milliseconds, { now = Date.now() } = {}) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new ClockError("bad_advance", `advance takes a positive number of milliseconds, not ${milliseconds}`);
  }
  const row = clockRow(db);
  if (!row) throw new ClockError("clock_not_started", "this instance has no clock to advance");

  db.prepare("UPDATE clock SET offset_ms = offset_ms + ? WHERE id = 1").run(Math.round(milliseconds));
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
