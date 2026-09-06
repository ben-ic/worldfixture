import assert from "node:assert/strict";
import test from "node:test";
import { acceptClockSample, clockSample, elapsedLabel, followTimeWindow, initialTimeWindow, interpolatedElapsed,
  readClockCommandResponse, readTimelineWindow, reconcileTimelinePage, recordsForView, timelineReadReady, timeWindowFromInputs, visibleEventGroups } from "./timeline-model.mjs";

const row = (seq, due_at, status = "pending") => ({ seq, id: `arrival-${seq}`, due_at, type: "custom-arrival", status });
const activeStatus = { mode: "paused", clock: { started: true } };
const page = (data, { total = data.length, cycle = 1, more = false, cursor = null } = {}) =>
  ({ data, total_count: total, cycle, has_more: more, next_cursor: cursor });
const sample = (elapsed_ms, { cycle = 1, sampled_at_ms = 100, running = true, receivedAt = 1000 } = {}) =>
  clockSample({ sampled_at_ms, clock: { elapsed_ms, running }, repeat: { cycle }, timeline: { next_due_ms: null } }, receivedAt);

test("a moving cursor interpolates locally, reconciles pause/advance, and resets only with the runtime cycle", () => {
  const running = sample(2000);
  assert.equal(interpolatedElapsed(running, 2250), 3250);
  const paused = sample(3250, { running: false, sampled_at_ms: 110, receivedAt: 2250 });
  assert.equal(interpolatedElapsed(paused, 999999), 3250);
  const advanced = sample(90000, { running: false, sampled_at_ms: 120 });
  assert.equal(interpolatedElapsed(advanced, 999999), 90000);
  assert.equal(acceptClockSample(advanced, paused), advanced);
  const reset = sample(0, { cycle: 2, sampled_at_ms: 90, running: false });
  assert.equal(acceptClockSample(advanced, reset), reset);
  assert.equal(acceptClockSample(reset, advanced), reset);
  assert.throws(() => clockSample({ clock: { elapsed_ms: -1 } }, 0), /valid clock sample/);
});

test("an elapsed view has an open future and follows time beyond every known arrival", () => {
  const initial = initialTimeWindow({ clock: { elapsed_ms: 0 }, timeline: { next_due_ms: 30000 } });
  const week = 7 * 24 * 60 * 60 * 1000;
  const later = followTimeWindow(initial, week);
  assert.ok(later.from <= week && later.from + later.span > week);
  assert.equal(later.span, initial.span);
  assert.equal(elapsedLabel(week + 90000), "t+1w 1m 30s");
  assert.equal(elapsedLabel(0), "t+0s");
});

test("four close arrivals and two thousand overlapping arrivals remain individually accessible", () => {
  const close = [row(1, 0), row(2, 10000), row(3, 10000, "failed"), row(4, 30000, "skipped")];
  const groups = visibleEventGroups(close, { from: 0, span: 30000 }, 3);
  assert.deepEqual(groups.flatMap(group => group.rows.map(item => item.id)).sort(), close.map(item => item.id).sort());
  assert.deepEqual(groups.find(group => group.rows.length === 2).outcomes, { pending: 1, failed: 1 });
  const many = Array.from({ length: 2000 }, (_, index) => row(index + 1, 7 * 24 * 60 * 60 * 1000));
  const bucket = visibleEventGroups(many, { from: 0, span: 7 * 24 * 60 * 60 * 1000 }, 12);
  assert.equal(bucket.length, 1);
  assert.equal(bucket[0].rows.length, 2000);
  assert.equal(new Set(bucket[0].rows.map(item => item.id)).size, 2000);
  const spread = many.map((item, index) => ({ ...item, due_at: index * 7 * 24 * 60 * 60 * 1000 / 1999 }));
  const week = timeWindowFromInputs("0", "1", "weeks");
  assert.equal(visibleEventGroups(spread, week, 12).flatMap(group => group.rows).length, 2000);
  assert.deepEqual(timeWindowFromInputs("1", "2", "seconds"), { from: 1000, span: 2000 });
  for (const args of [["-1", "1", "days"], ["0", "0", "seconds"], ["1e20", "1", "weeks"], ["", "1", "seconds"]]) {
    assert.throws(() => timeWindowFromInputs(...args));
  }
});

test("append sequence keeps a new causal row behind elapsed time and updates prior outcomes", () => {
  const first = reconcileTimelinePage(null, page([row(1, 0), row(2, 10000)]));
  const caused = { ...row(3, 500), caused_by: "accepted-event", command_id: "command-id" };
  const second = reconcileTimelinePage(first, page([row(1, 0, "delivered"), caused], { total: 3 }));
  assert.deepEqual(second.rows.map(item => item.id), ["arrival-1", "arrival-3", "arrival-2"]);
  assert.equal(second.rows[0].status, "delivered");
  assert.equal(second.rows[1].caused_by, "accepted-event");
  const reset = reconcileTimelinePage(second, page([row(1, 0)], { cycle: 2 }));
  assert.deepEqual(reset.rows.map(item => item.id), ["arrival-1"]);
  assert.equal(reset.rows[0].status, "pending");
});

test("first clock sample, reset, and view changes cannot expose absent or stale record data", async () => {
  const window = { from: 0, span: 30000 };
  assert.equal(recordsForView(null, undefined, null, activeStatus), null);
  assert.equal(recordsForView(null, 1, window, activeStatus), null);
  const loaded = await readTimelineWindow(async () => page([row(1, 10000)], { more: true, cursor: 1, total: 2 }), window);
  assert.equal(recordsForView(loaded, 1, window, activeStatus), loaded);
  assert.equal(recordsForView(loaded, undefined, window, activeStatus), null);
  assert.equal(recordsForView(loaded, 2, window, activeStatus), null, "The prior cycle must not supply counts or a load-more button");
  assert.equal(recordsForView(loaded, 1, { from: 30000, span: 30000 }, activeStatus), null, "A prior time window must not supply rows or totals");
  assert.equal(recordsForView(loaded, 1, { from: 0, span: 10000 }, activeStatus), null);
  const empty = await readTimelineWindow(async () => page([], { cycle: 2 }), window);
  assert.equal(recordsForView(empty, 2, window, activeStatus).total, 0, "A measured empty page is different from an absent response");
});

test("reset hides old rows before the clock is cleared or the cycle increases, but failed deliveries stay inspectable", async () => {
  const window = { from: 0, span: 30000 };
  const loaded = await readTimelineWindow(async () => page([row(1, 10000, "delivered")]), window);
  for (const mode of ["resetting", "initializing", "stopped"]) {
    const status = { mode, clock: { started: true } };
    assert.equal(timelineReadReady(status), false, mode);
    assert.equal(recordsForView(loaded, 1, window, status), null, `${mode} must hide prior rows even with the same cycle`);
  }
  assert.equal(recordsForView(loaded, 1, window, { mode: "paused", clock: { started: false } }), null);
  const failed = { mode: "failed", clock: { started: true } };
  assert.equal(recordsForView(loaded, 1, window, failed), loaded, "A delivery failure must keep its evidence visible");
});

test("window paging uses append sequence, keeps every record, and rejects failed or changing reads", async () => {
  const requested = [];
  const all = [row(1, 0), row(2, 10000), row(3, 500)];
  const read = async url => {
    const query = new URL(url, "http://test").searchParams;
    requested.push(query);
    return query.has("after") ? page([all[2]], { total: 3 }) : page(all.slice(0, 2), { total: 3, more: true, cursor: 2 });
  };
  const result = await readTimelineWindow(read, { from: 0, span: 30000 }, 2);
  assert.equal(requested[1].get("after"), "2");
  assert.equal(requested[1].get("fromMs"), "0");
  assert.equal(requested[1].get("toMs"), "30000");
  assert.deepEqual(result.rows.map(item => item.seq), [1, 3, 2]);
  assert.equal(result.hasMore, false);
  await assert.rejects(readTimelineWindow(async () => { throw new Error("HTTP 503"); }, { from: 0, span: 1 }), /HTTP 503/);
  await assert.rejects(readTimelineWindow(async () => page([row(1, 0)], { more: true, cursor: 1 }), { from: 0, span: 1 }, 2), /cursor did not advance/);
  let calls = 0;
  await assert.rejects(readTimelineWindow(async () => page([row(1, 0)], { cycle: ++calls, more: true, cursor: calls }), { from: 0, span: 1 }, 2), /reset during this read/);
});

test("failed advance retains accepted and failed outcomes from the controller response", async () => {
  const result = { ...sample(30000, { running: false }).status, played: [row(1, 0, "delivered"), row(2, 10000, "failed")] };
  const response = new Response(JSON.stringify({ error: "Delivery failed", code: "timeline_delivery_failed", state_changed: true, result }), { status: 409 });
  const outcome = await readClockCommandResponse(response);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.error, "Delivery failed");
  assert.deepEqual(outcome.status.played.map(item => item.status), ["delivered", "failed"]);
  assert.equal(outcome.status.clock.running, false);
  await assert.rejects(readClockCommandResponse(new Response("unavailable", { status: 503 })), /not JSON/);
});
