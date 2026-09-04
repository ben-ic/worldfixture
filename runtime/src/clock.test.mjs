// The environment clock.
//
// Every test injects `now`, so none of them waits for real time to pass. A test
// that slept would be slow and would still not prove the arithmetic; passing the
// clock its own idea of now proves it exactly.

import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ClockError, advanceClock, clockState, elapsedMs, isRunning, pauseClock, resumeClock, startClock } from "./clock.mjs";
import { rebaseForSession } from "./cli.mjs";
import { openState, resetState } from "./state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const T0 = 1_800_000_000_000;

function fresh() {
  return openState(":memory:");
}

test("a clock that was never started reads zero rather than failing", () => {
  const db = fresh();
  assert.equal(elapsedMs(db, T0), 0);
  assert.equal(isRunning(db), false);
  assert.deepEqual(clockState(db, { now: T0 }), { started: false, running: false, elapsed_ms: 0, anchor: null });
  db.close();
});

test("world time is measured from the start, not from the process", () => {
  const db = fresh();

  // The clock starts after readiness. Whatever the process did before that --
  // and on a cold machine that is tens of seconds of container startup -- is not
  // world time and must not consume the timeline.
  startClock(db, { anchor: "2026-08-21T09:00:00Z", now: T0 });

  assert.equal(elapsedMs(db, T0), 0);
  assert.equal(elapsedMs(db, T0 + 20_000), 20_000);
  assert.equal(clockState(db, { now: T0 + 20_000 }).anchor, "2026-08-21T09:00:00Z");
  db.close();
});

test("a pause costs no world time and a resume does not backdate", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });

  pauseClock(db, { now: T0 + 30_000 });
  assert.equal(elapsedMs(db, T0 + 30_000), 30_000);

  // Five minutes of wall time pass while paused. None of it is world time.
  assert.equal(elapsedMs(db, T0 + 330_000), 30_000);
  assert.equal(isRunning(db), false);

  resumeClock(db, { now: T0 + 330_000 });
  assert.equal(elapsedMs(db, T0 + 330_000), 30_000);
  assert.equal(elapsedMs(db, T0 + 340_000), 40_000);
  assert.equal(isRunning(db), true);
  db.close();
});

test("advance moves the world without waiting, and leaves a paused clock paused", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });
  pauseClock(db, { now: T0 + 1_000 });

  advanceClock(db, 600_000, { now: T0 + 1_000 });

  // Advance answers "what would have happened by then". Resuming afterwards
  // would otherwise be indistinguishable from never having paused.
  assert.equal(elapsedMs(db, T0 + 1_000), 601_000);
  assert.equal(isRunning(db), false);

  resumeClock(db, { now: T0 + 1_000 });
  assert.equal(elapsedMs(db, T0 + 2_000), 602_000);
  db.close();
});

test("advance also works on a running clock, and adds to it", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });
  advanceClock(db, 5_000, { now: T0 + 1_000 });
  assert.equal(elapsedMs(db, T0 + 1_000), 6_000);
  assert.equal(isRunning(db), true);
  db.close();
});

test("pause, resume and advance refuse a clock that was never started", () => {
  const db = fresh();
  for (const call of [() => pauseClock(db), () => resumeClock(db), () => advanceClock(db, 1)]) {
    assert.throws(call, (error) => error instanceof ClockError && error.code === "clock_not_started");
  }
  db.close();
});

test("a negative advance is refused rather than moving the world backwards", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });
  assert.throws(() => advanceClock(db, -1), (error) => error.code === "bad_advance");
  assert.throws(() => advanceClock(db, Number.NaN), (error) => error.code === "bad_advance");
  db.close();
});

test("pausing twice and resuming twice are both harmless", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });
  pauseClock(db, { now: T0 + 5_000 });
  pauseClock(db, { now: T0 + 9_000 });
  assert.equal(elapsedMs(db, T0 + 9_000), 5_000, "the second pause must not bank the paused interval");

  resumeClock(db, { now: T0 + 9_000 });
  resumeClock(db, { now: T0 + 12_000 });
  assert.equal(elapsedMs(db, T0 + 12_000), 8_000, "the second resume must not restart the interval");
  db.close();
});

test("restarting the clock puts the world back at zero", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });
  advanceClock(db, 90_000, { now: T0 });

  // This is what reset does: the accepted start includes a timeline that has
  // not run yet, so the clock has to go back to the beginning with it.
  startClock(db, { anchor: "a", now: T0 + 500_000 });
  assert.equal(elapsedMs(db, T0 + 500_000), 0);
  assert.equal(isRunning(db), true);
  db.close();
});

test("reset clears the clock, and the runtime can start a new one", () => {
  const db = fresh();
  startClock(db, { anchor: "a", now: T0 });
  advanceClock(db, 10_000, { now: T0 });

  resetState(db);
  assert.equal(clockState(db, { now: T0 }).started, false);

  startClock(db, { anchor: "a", now: T0 });
  assert.equal(elapsedMs(db, T0 + 3_000), 3_000);
  db.close();
});

// ---- the world's own clock -----------------------------------------------
//
// A world is authored at a fixed anchor, and a message somebody sends is stamped
// by the provider with the real clock. Started at its authored anchor, a world
// written for 2026-08-28 puts everything a user does either far above or far
// below its whole history, and the view looks like it is not refreshing. `up`
// rebases so the world's now tracks the session's now; these two tests are the
// property that makes that true, and the fallback that keeps a world without a
// source starting anyway.

test("a session rebase moves the world's anchor onto the day it is started", () => {
  const state = mkdtempSync(join(tmpdir(), "worldfixture-rebase-"));
  try {
    const result = rebaseForSession(join(ROOT, "dist/business.saas-company.v2"), state, { quiet: true });
    assert.equal(result.rebased, true, "the checkout ships worlds/business.saas-company.v2, so this must rebase");

    const world = JSON.parse(readFileSync(join(result.artifactPath, "world.json"), "utf8"));
    const anchor = Date.parse(world.clock.anchor);
    const behindByDays = (Date.now() - anchor) / 86_400_000;
    // Rebasing lands the anchor on a working hour near now, not on this instant.
    assert.ok(behindByDays > -2 && behindByDays < 7, `anchor ${world.clock.anchor} is ${behindByDays} days from now`);

    const authored = JSON.parse(readFileSync(join(ROOT, "dist/business.saas-company.v2/world.json"), "utf8"));
    assert.notEqual(world.clock.anchor, authored.clock.anchor, "a rebased world must not keep the anchor it was built at");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("a world with no source on disk starts at its authored anchor rather than failing", () => {
  const state = mkdtempSync(join(tmpdir(), "worldfixture-rebase-"));
  try {
    const built = join(ROOT, "dist/business.saas-company.v2");
    // An npm install ships `dist/` and no `worlds/`: nothing to rebase from.
    const result = rebaseForSession(join(ROOT, "dist/no-such-world"), state, { quiet: true });
    assert.equal(result.rebased, false);
    assert.equal(result.artifactPath, join(ROOT, "dist/no-such-world"), "it hands back the artifact it was given");
    assert.match(result.reason, /no world source/);
    assert.ok(built);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
