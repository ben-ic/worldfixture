import { clockState, startClock, pauseClock, resumeClock, advanceClock, parseDuration, validateAdvanceTarget } from './clock.mjs';
import { armTimeline, playDue, timelineState, timelineRecords, DEFAULT_TICK_MS } from './scheduler.mjs';

export class TimelineControlError extends Error {
  constructor(code, message, status = 409, result) {
    super(message); this.name = 'TimelineControlError'; this.code = code; this.status = status; this.result = result; this.state_changed = Boolean(result?.played?.length) || code === 'timeline_reset_failed';
  }
}

// One owner serializes provider delivery and lifecycle changes. Reads do not
// wait behind a slow provider write, so in-flight outcomes remain inspectable.
export function attachTimelineControl(instance, world, context = {}) {
  if (instance.timelineControl) return instance.timelineControl;
  const db = instance.state, now = context.now ?? (() => Date.now());
  const active = instance.lock?.execution?.timeline?.active;
  const selected = active ? { ...world, timeline: (world.timeline ?? []).filter(row => active.includes(row.id)) } : world;
  const arc = selected.timeline ?? [];
  const arcEnd = Math.max(0, ...arc.map(row => Math.round(row.after_seconds * 1000)));
  const eligible = arc.length > 0 && Number.isSafeInteger(arcEnd) && arcEnd > 0;
  const reason = eligible ? undefined : 'Repeat requires a selected authored arc with a positive duration';
  let cachedStopped;
  let mode = 'initializing', stopped = false, suspended = false, tail = Promise.resolve(), timer, tickQueued = false;
  const serialize = work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  const cycle = () => db.prepare('SELECT * FROM timeline_cycle WHERE id=1').get() ?? { enabled: 0, cycle: 0, status: 'idle', error: null };
  const updateCycle = (enabled, status, error = null) => db.prepare('UPDATE timeline_cycle SET enabled=?,status=?,error=? WHERE id=1').run(enabled ? 1 : 0, status, error);
  const status = () => {
    if (cachedStopped) return cachedStopped;
    const clock = clockState(db, { now: now() }), pass = cycle();
    const date = clock.anchor ? new Date(Date.parse(clock.anchor) + clock.elapsed_ms) : null;
    return { ok: true, mode, sampled_at_ms: now(), epoch: pass.cycle,
      clock: { ...clock, world_now: date && Number.isFinite(date.getTime()) ? date.toISOString() : null },
      timeline: timelineState(db), repeat: { enabled: Boolean(pass.enabled), eligible, ...(reason ? { reason } : {}), cycle: pass.cycle, status: pass.status, ...(pass.error ? { error: pass.error } : {}) } };
  };
  const response = played => ({ ...status(), played });
  function requireReady() {
    if (stopped) throw new TimelineControlError('timeline_stopped', 'Timeline control is stopped');
    if (mode === 'initializing') throw new TimelineControlError('timeline_not_initialized', 'Timeline control is not initialized', 503);
  }
  function repeatValue(enabled) {
    if (typeof enabled !== 'boolean') throw new TimelineControlError('bad_repeat', 'Repeat enabled must be a boolean', 400);
    if (enabled && !eligible) throw new TimelineControlError('repeat_ineligible', reason, 400);
  }
  function arm() {
    const sampledAt = now();
    startClock(db, { anchor: world.clock?.anchor ?? '', now: sampledAt }); pauseClock(db, { now: sampledAt });
    return armTimeline(db, selected);
  }
  async function drain() {
    let played;
    try { played = await playDue(db, { ...context, bindings: context.bindings ?? {}, world, stopOnFailure: true, shouldStop: () => stopped }, { now: now() }); }
    catch (error) {
      pauseClock(db, { now: now() }); mode = 'failed'; updateCycle(false, 'failed', error.message);
      throw new TimelineControlError('timeline_delivery_failed', error.message, 409, response([]));
    }
    context.onPlayed?.(played);
    if (played.some(row => row.status === 'failed' || row.status === 'uncertain')) {
      pauseClock(db, { now: now() }); mode = 'failed';
      updateCycle(false, 'failed', played.find(row => row.status === 'failed' || row.status === 'uncertain').reason ?? 'Timeline delivery failed');
      throw new TimelineControlError('timeline_delivery_failed', 'Timeline delivery failed; the clock is paused for inspection', 409, response(played));
    }
    return played;
  }
  function finishPosition(running) {
    if (stopped) { mode = 'stopped'; return; }
    if (running) { resumeClock(db, { now: now() }); mode = 'running'; }
    else mode = 'paused';
  }
  async function position(milliseconds) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TimelineControlError('bad_start_at', 'Start time must be a nonnegative safe integer in milliseconds', 400);
    advanceClock(db, milliseconds, { now: now() });
    return drain();
  }
  async function restore({ repeat = false, setup = mode === 'setup' } = {}) {
    const wasRunning = clockState(db, { now: now() }).running;
    pauseClock(db, { now: now() });
    const prior = cycle(); mode = 'resetting'; updateCycle(prior.enabled, 'resetting');
    try {
      const result = await instance.restoreBaseline();
      db.prepare('UPDATE timeline_cycle SET cycle=cycle+1,status=?,error=NULL WHERE id=1').run(prior.enabled ? 'running' : 'idle');
      // Test adapters can implement only provider restore; the controller owns arming.
      arm();
      const played = setup ? [] : await drain();
      if (setup && !stopped) mode = 'setup'; else finishPosition(wasRunning || repeat);
      return { ...response(played), ...result };
    } catch (error) {
      mode = 'failed'; updateCycle(false, 'failed', error.message);
      throw new TimelineControlError('timeline_reset_failed', error.message, 409, response([]));
    }
  }
  async function tick() {
    if (stopped || suspended || mode !== 'running') return;
    await drain();
    if (stopped) return;
    const summary = timelineState(db), pass = cycle();
    if (pass.enabled && !summary.pending && !summary.in_flight && !summary.failed && !summary.uncertain) await restore({ repeat: true });
  }
  function startTimer() {
    timer = setInterval(() => {
      if (tickQueued || stopped || suspended) return;
      tickQueued = true;
      serialize(tick).catch(error => context.onError?.(error)).finally(() => { tickQueued = false; });
    }, context.tickMs ?? DEFAULT_TICK_MS);
    timer.unref?.();
  }
  const controller = {
    status,
    timeline(query) { return { ...timelineRecords(db, query), cycle: cycle().cycle, epoch: cycle().cycle }; },
    initialize(options = {}) {
      return serialize(async () => {
        if (stopped || mode !== 'initializing') throw new TimelineControlError('timeline_already_initialized', 'Timeline is already initialized or stopped');
        const { startAtMs = 0, repeat = false, setup = false } = options;
        if (!Number.isSafeInteger(startAtMs) || startAtMs < 0 || typeof setup !== 'boolean') throw new TimelineControlError('bad_start_at', 'Setup must be boolean and start time must be a nonnegative safe integer', 400);
        if (setup && startAtMs !== 0) throw new TimelineControlError('conflicting_setup', 'Setup and a start position cannot be combined', 400);
        validateAdvanceTarget(startAtMs, { elapsed_ms: 0, anchor: world.clock?.anchor });
        repeatValue(repeat);
        const existing = cycle();
        if (existing.cycle > 0 && timelineState(db).total > 0) {
          db.prepare("UPDATE scheduled_events SET status='uncertain',error='Runtime stopped during provider delivery; inspect before reset' WHERE status='in_flight'").run();
          pauseClock(db, { now: now() }); mode = 'failed'; updateCycle(false, 'failed', 'Existing timeline state requires inspection or reset');
          throw new TimelineControlError('timeline_recovery_required', 'Existing timeline state requires inspection or reset', 409, response([]));
        }
        db.prepare("INSERT INTO timeline_cycle(id,enabled,cycle,status) VALUES(1,?,1,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,cycle=timeline_cycle.cycle+1,status=excluded.status,error=NULL").run(repeat ? 1 : 0, repeat ? 'running' : 'idle');
        arm(); mode = setup ? 'setup' : 'paused';
        startTimer();
        if (setup) return response([]);
        const played = await position(startAtMs);
        finishPosition(true);
        return response(played);
      });
    },
    command(input = {}) {
      return serialize(async () => {
        requireReady();
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TimelineControlError('bad_action', 'Control command must be an object', 400);
        const { action } = input;
        if (action === 'status') return response([]);
        if (action === 'reset') return restore({ setup: input.preserveSetup === true || mode === 'setup' });
        if (mode === 'failed') throw new TimelineControlError('timeline_failed', 'Reset the failed timeline before further delivery', 409, response([]));
        if (action === 'repeat') { repeatValue(input.enabled); updateCycle(input.enabled, input.enabled ? 'running' : 'idle'); return response([]); }
        if (action === 'start') {
          if (mode !== 'setup') throw new TimelineControlError('timeline_not_setup', 'Start position can only be selected during setup');
          const duration = parseDuration(input.duration ?? '0s');
          validateAdvanceTarget(duration, clockState(db, { now: now() }));
          if (input.enabled !== undefined) { repeatValue(input.enabled); updateCycle(input.enabled, input.enabled ? 'running' : 'idle'); }
          const played = await position(duration); finishPosition(true); return response(played);
        }
        if (mode === 'setup') throw new TimelineControlError('timeline_setup', 'Start the timeline before using running controls');
        if (action === 'pause') { pauseClock(db, { now: now() }); mode = 'paused'; return response([]); }
        if (action === 'resume') { resumeClock(db, { now: now() }); mode = 'running'; return response([]); }
        if (action === 'advance') {
          const duration = parseDuration(input.duration), sampledAt = now(), current = clockState(db, { now: sampledAt });
          validateAdvanceTarget(duration, current);
          const running = current.running;
          pauseClock(db, { now: sampledAt }); mode = 'paused';
          const played = await position(duration);
          finishPosition(running);
          return response(played);
        }
        throw new TimelineControlError('bad_action', 'Unknown timeline control action', 400);
      });
    },
    // A manual tick is useful for deterministic lifecycle tests. It uses the same queue.
    tick() { return serialize(tick); },
    async stop() { if (cachedStopped) return; stopped = true; clearInterval(timer); await tail; if (clockState(db).started) pauseClock(db, { now: now() }); mode = 'stopped'; cachedStopped = status(); },
  };
  instance.timelineControl = controller;
  instance.rearmTimeline = arm;
  // restoreBaseline invokes these while it already holds the queue. No nested wait.
  instance.scheduler = { suspend: async () => { suspended = true; }, resume: () => { suspended = false; } };
  return controller;
}
