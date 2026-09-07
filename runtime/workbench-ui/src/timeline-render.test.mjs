import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import "../../../tests/helpers/loopback-only.mjs";

const server = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  server: { middlewareMode: true, hmr: false, ws: false, watch: null }, logLevel: "silent" });
after(() => server.close());
const { Timeline, TimelineControls, TimelineRecords, TimelineAxis, TimelineOutcome } = await server.ssrLoadModule("/src/screens/Timeline.jsx");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const sample = { receivedAt: 0, status: { mode: "setup", sampled_at_ms: 0,
  clock: { started: true, elapsed_ms: 0, running: false }, repeat: { enabled: false, eligible: true, cycle: 1, status: "idle" } } };

test("the complete Timeline first render works before clock or record responses exist", () => {
  const markup = render(Timeline, { onChanged() {} });
  assert.match(markup, /<h1>Timeline<\/h1>/);
  assert.match(markup, /Waiting for the runtime clock/);
  assert.doesNotMatch(markup, /No scheduled records|Advance forward|Apply position and start/);
});

test("setup can choose the starting position before delivery and keeps data when looping", () => {
  const markup = render(TimelineControls, { sample, onCommand() {} });
  assert.match(markup, /Setup · paused before delivery/);
  assert.match(markup, /Start at elapsed time/);
  assert.match(markup, /Apply position and start/);
  assert.match(markup, /at or before this position/);
  assert.match(markup, /Keep provider data, manual changes, and delivery history/);
  assert.doesNotMatch(markup, /baseline restore|reset.and.repeat/);
  assert.doesNotMatch(markup, /checked=""|Advance forward|type="range"/);
});

test("running controls are forward-only, paused is visible, and ineligible repeat cannot be enabled", () => {
  const paused = { ...sample, status: { ...sample.status, mode: "paused", clock: { started: true, elapsed_ms: 30000, running: false },
    repeat: { ...sample.status.repeat, eligible: false, reason: "The authored arc has no positive duration" } } };
  const markup = render(TimelineControls, { sample: paused, onCommand() {} });
  assert.match(markup, /Ⅱ Paused/);
  assert.match(markup, /Resume/);
  assert.match(markup, /Advance forward/);
  assert.match(markup, /type="checkbox" disabled=""/);
  assert.match(markup, /positive duration/);
  assert.doesNotMatch(markup, /Start at elapsed time|Apply position and start|type="range"/);
});

test("resetting disables every clock mutation and hides the old operation result before cycle or clock changes", () => {
  const played = { action: "advance", accepted: true, rows: [{ id: "old-delivered-record", status: "delivered", event_id: "old-event" }] };
  for (const mode of ["resetting", "initializing", "stopped"]) {
    const status = { ...sample.status, mode, clock: { ...sample.status.clock, started: true, elapsed_ms: 30000 } };
    const markup = render(TimelineControls, { sample: { ...sample, status }, onCommand() {} });
    const controls = markup.match(/<(?:button|input)\b[^>]*>/g);
    assert.ok(controls.length > 0);
    for (const control of controls) assert.match(control, /disabled=""/, `${mode}: ${control}`);
    assert.equal(render(TimelineOutcome, { played, status }), "");
  }
  const failed = { ...sample.status, mode: "failed" };
  assert.match(render(TimelineOutcome, { played, status: failed }), /old-delivered-record/, "Failure evidence remains inspectable");
});

test("all outcome states have text and shapes, and causal evidence is visible in escaped record details", () => {
  const states = ["pending", "in_flight", "delivered", "failed", "skipped", "uncertain"];
  const rows = states.map((status, index) => ({ id: `arrival-${index}`, seq: index + 1, due_at: 0, type: "custom", status,
    caused_by: "event-cause", payload: { body: "<script>authored content</script>", nested: { recipients: ["person.one", "person.two"] } },
    error: status === "failed" ? "<script>failure</script>" : undefined }));
  const markup = render(TimelineRecords, { rows });
  for (const label of ["Pending", "In flight", "Delivered", "Failed", "Skipped", "Uncertain"]) assert.ok(markup.includes(label));
  assert.equal((markup.match(/<details/g) ?? []).length, states.length);
  assert.match(markup, /Caused by/);
  assert.match(markup, /event-cause/);
  assert.match(markup, /&lt;script&gt;failure&lt;\/script&gt;/);
  assert.match(markup, /Event payload/);
  assert.match(markup, /&lt;script&gt;authored content&lt;\/script&gt;/);
  assert.match(markup, /person.one/);
  assert.match(markup, /person.two/);
  assert.match(markup, /&quot;nested&quot;: \{/);
  assert.doesNotMatch(markup, /<script>/);
});

test("overlapping axis marks name every loaded event and open groups without a draggable clock", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({ id: `event-${index}`, seq: index + 1, due_at: 0, type: "custom", status: "pending" }));
  const markup = render(TimelineAxis, { sample, rows, window: { from: 0, span: 30000 }, onSelect() {} });
  assert.match(markup, /2000 loaded events/);
  assert.match(markup, /2000 Pending/);
  assert.match(markup, /Grouped events · number shows the count/);
  assert.match(markup, /Timeline legend/);
  assert.match(markup, /Future stays open/);
  assert.match(markup, /Moving this view does not move the clock/);
  assert.doesNotMatch(markup, /role="slider"|type="range"|draggable="true"/);
});

test("a changed plot bucket cannot appear selected solely because it reuses the previous slot index", () => {
  const rows = [{ id: "event-one", seq: 1, due_at: 0, type: "custom", status: "pending", payload: {} }];
  const window = { from: 0, span: 30000 };
  const oldRange = { key: 0, from: 0, to: 5000 };
  const changed = render(TimelineAxis, { sample, rows, window, selectedGroup: oldRange, onSelect() {} });
  assert.doesNotMatch(changed, /aria-pressed="true"/);
  const sameRange = render(TimelineAxis, { sample, rows, window, selectedGroup: { key: 99, from: 0, to: 2500 }, onSelect() {} });
  assert.match(sameRange, /aria-pressed="true"/);
});
