import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startupProgress } from "./cli.mjs";
import { publishProgress } from "./supervisor.mjs";

const CLEAR = "\r\u001b[2K";

// Capture what the renderer writes, with the terminal answer under our control.
function render({ tty }) {
  const written = [];
  const realWrite = process.stdout.write;
  const realTty = process.stdout.isTTY;
  process.stdout.isTTY = tty;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  const progress = startupProgress();
  const restore = () => {
    process.stdout.write = realWrite;
    process.stdout.isTTY = realTty;
  };
  return { progress, written, restore };
}

// The silence this closes: `up` printed the Workbench URL after about a second
// and then nothing for another ninety, because the host could only watch for
// `bindings.json` to appear. The container knew the whole time that everything
// was up except mail, which was delivering 3,069 messages over LMTP.
// It also has to say it in the reader's words. The first version printed the
// runtime's own names and counts -- "2 of 4 services ready, waiting on mail, s3"
// -- and nothing else on the screen mentions four services, while `s3` and
// `emulate` name parts of this program rather than parts of a world.
test("progress names what is left in the reader's words, and how long it has been", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    progress.update({ phase: "starting", services: { emulate: "running", "http-targets": "running", mail: "starting", s3: "starting" } });
    const line = written.join("");

    assert.match(line, /Local Mail and file storage/);
    assert.match(line, /everything else is ready/);
    assert.match(line, /Loading\s+\d+s/);
    // No internal service names, and no count that matches nothing on screen.
    assert.ok(!line.includes("emulate"), line);
    assert.ok(!line.includes("http-targets"), line);
    assert.ok(!/\d of \d services/.test(line), line);
  } finally {
    restore();
  }
});

// Naming what is ready meant agreeing a verb with a list whose head could be
// singular or plural -- "the provider APIs is ready". The reader is waiting on
// what is LEFT; what is done only has to reassure.
test("what is finished reassures without having to agree with a verb", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    progress.update({ phase: "starting", services: { emulate: "running", mail: "starting" } });
    const line = written.join("");
    assert.match(line, /Local Mail; everything else is ready/);
    assert.ok(!/\bis ready\b.*\bAPIs\b|APIs is/.test(line), line);
  } finally {
    restore();
  }
});

test("nothing ready yet means no reassurance clause at all", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    progress.update({ phase: "starting", services: { emulate: "starting", mail: "starting" } });
    const line = written.join("");
    assert.match(line, /the provider APIs and Local Mail/);
    assert.ok(!line.includes("everything else"), line);
  } finally {
    restore();
  }
});

// Recording the accepted state stops every service and starts it again, so the
// count genuinely runs backwards -- 4 of 4, then 2 of 4. A number going
// backwards reads as something breaking, so the phase is shown instead.
test("the baseline phase shows what it is doing rather than a count that goes backwards", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    progress.update({ phase: "capturing-baseline", services: { emulate: "running", mail: "starting" } });
    const line = written.join("");
    assert.match(line, /recording the accepted state/);
    assert.ok(!/\d of \d/.test(line), line);
  } finally {
    restore();
  }
});

// A progress display that fills a CI log with thousands of identical lines is
// worse than no progress display.
test("piped output prints each distinct state once and never repeats itself", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    const state = { phase: "starting", services: { emulate: "running", mail: "starting" } };
    for (let i = 0; i < 20; i += 1) progress.update(state);
    progress.update({ phase: "starting", services: { emulate: "running", mail: "running" } });
    assert.equal(written.length, 2, written.join(""));
    // Nothing to erase when there is no cursor to move.
    progress.done();
    assert.equal(written.length, 2);
  } finally {
    restore();
  }
});

test("a terminal rewrites one line and clears it when the wait is over", () => {
  const { progress, written, restore } = render({ tty: true });
  try {
    progress.update({ phase: "starting", services: { emulate: "running", mail: "starting" } });
    progress.update({ phase: "starting", services: { emulate: "running", mail: "running" } });
    progress.done();
    const output = written.join("");
    assert.ok(output.includes(CLEAR), "the line is rewritten in place");
    assert.ok(output.endsWith(CLEAR), "the line is cleared when it is done");
    // One line rewritten, not a scrolling log.
    assert.equal(output.split("\n").length, 2);
  } finally {
    restore();
  }
});

test("an instance with no services to report writes nothing to the screen", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    progress.update({ phase: "starting", services: {} });
    assert.equal(written.length, 0);
  } finally {
    restore();
  }
});

// The container publishes it; the host reads it. Best-effort, because a run must
// not fail because a progress file could not be written.
test("the runtime publishes its phase and every service state where the host can read it", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-progress-"));
  try {
    publishProgress({
      stateDir,
      phase: "starting",
      serviceStates: new Map([["emulate", "running"], ["mail", "starting"]]),
    });

    const written = JSON.parse(readFileSync(join(stateDir, "progress.json"), "utf8"));
    assert.equal(written.api_version, "worldfixture.progress/v1");
    assert.equal(written.phase, "starting");
    assert.deepEqual(written.services, { emulate: "running", mail: "starting" });
    assert.ok(Number.isFinite(Date.parse(written.updated_at)));

    assert.doesNotThrow(() => publishProgress({ stateDir: undefined, phase: "starting", serviceStates: new Map() }));
    assert.doesNotThrow(() => publishProgress({ stateDir: "/nowhere/at/all", phase: "starting", serviceStates: new Map() }));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
