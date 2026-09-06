import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startupProgress } from "./cli.mjs";
import { publishProgress } from "./supervisor.mjs";

const ESCAPE = "";
const ERASE = `\r${ESCAPE}[2K`;

const PORTS = [
  { name: "smtp", hostPort: 2525 }, { name: "imap", hostPort: 1143 },
  { name: "s3", hostPort: 8333 }, { name: "postgres", hostPort: 5432 },
  { name: "mysql", hostPort: 3306 }, { name: "site", hostPort: 8080 },
];

// Capture what the launch writes, with the terminal answer under our control.
function render({ tty, stateDir, ports = PORTS } = {}) {
  const written = [];
  const realWrite = process.stdout.write;
  const realTty = process.stdout.isTTY;
  const realColour = process.env.NO_COLOR;
  process.stdout.isTTY = tty;
  // Colour is a separate question from layout, and every assertion here is
  // about the words.
  process.env.NO_COLOR = "1";
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  let elapsed = 0;
  const progress = startupProgress({ stateDir, ports, now: () => (elapsed += 1000) });
  const restore = () => {
    process.stdout.write = realWrite;
    process.stdout.isTTY = realTty;
    if (realColour === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = realColour;
  };
  return { progress, written, restore, output: () => written.join("") };
}

// A state directory with just enough in it for the launch to name the world's
// own numbers: which vendors this run publishes, and how much mail it carries.
function worldAt(vendors, { messages = 0 } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-progress-"));
  writeFileSync(join(stateDir, "environment.lock.json"), JSON.stringify({
    capabilities: Object.fromEntries(vendors.map((name) => [`${name}.thing.v1`, { service: "emulate", port: name }])),
  }));
  if (messages > 0) {
    mkdirSync(join(stateDir, "world"), { recursive: true });
    writeFileSync(join(stateDir, "world/world.json"), JSON.stringify({
      communication: { mail: Array.from({ length: messages }, (_unused, index) => ({ id: index })) },
    }));
  }
  return stateDir;
}

function inWorld(vendors, options, body) {
  const stateDir = worldAt(vendors, options);
  try {
    body(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// THE URL THAT ARRIVED TOO EARLY. `up` printed the Workbench address about two
// seconds in, which is roughly a hundred seconds before the world behind it has
// any mail, files or databases in it. The one actionable thing in the terminal
// invited somebody into a world that was not there yet.
test("nothing is announced before it can actually be used", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir });
    try {
      progress.update({ phase: "starting", services: { emulate: "starting", mail: "starting" } });
      assert.equal(output(), "", "a world that is still loading has nothing to offer yet");

      progress.update({ phase: "starting", services: { emulate: "running" } });
      assert.match(output(), /✓ {2}slack/);
      assert.ok(!output().includes("mail over smtp"), output());
    } finally {
      restore();
    }
  });
});

// Each part of the world, in the words somebody came for, with the address it
// answers on. The runtime's own names -- `emulate`, `s3`, `http-targets` --
// name parts of this program rather than parts of a world.
test("each part of the world is named the way the reader will use it", () => {
  inWorld(["slack", "github", "google", "notion", "stripe", "twilio"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir });
    try {
      progress.update({
        phase: "starting",
        services: { emulate: "running", mail: "running", s3: "running", postgres: "running", "http-targets": "running" },
      });
      const lines = output().trimEnd().split("\n");

      assert.match(lines[0], /✓ {2}slack, github, google, notion, stripe\s+6 emulators/);
      assert.match(lines[1], /✓ {2}mail over smtp and imap\s+:2525 · :1143/);
      assert.match(lines[2], /✓ {2}object storage, s3 compatible\s+:8333/);
      assert.match(lines[3], /✓ {2}postgres, seeded to match\s+:5432/);
      assert.equal(lines.length, 5);

      assert.ok(!output().includes("emulate"), output());
      assert.ok(!output().includes("http-targets"), output());
      assert.ok(!/\d of \d services/.test(output()), output());
    } finally {
      restore();
    }
  });
});

// A Postgres-only project printed `postgres, seeded to match  :5432 · :3306`,
// naming a MySQL port that no MySQL was listening on.
test("only the databases this run started are named, with only their ports", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir });
    try {
      progress.update({ phase: "starting", services: { postgres: "running" } });
      assert.match(output(), /postgres, seeded to match\s+:5432\s*$/m);
      assert.ok(!output().includes("3306"), output());
    } finally {
      restore();
    }
  });
});

test("two databases are one line naming both", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir });
    try {
      progress.update({ phase: "starting", services: { postgres: "running", mysql: "running" } });
      assert.match(output(), /postgres and mysql, seeded to match\s+:5432 · :3306/);
    } finally {
      restore();
    }
  });
});

// The count is this run's, not the catalogue's: `--only slack,github` starts
// two emulators and has to say two.
test("the emulator count is counted from what this run actually started", () => {
  inWorld(["slack", "github"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir });
    try {
      progress.update({ phase: "starting", services: { emulate: "running" } });
      assert.match(output(), /✓ {2}slack, github\s+2 emulators/);
    } finally {
      restore();
    }
  });
});

// An address this run did not choose is left off rather than guessed at: a port
// number somebody types into an application has to be a real one.
test("a port the launch does not know is left out rather than invented", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir, ports: [] });
    try {
      progress.update({ phase: "starting", services: { mail: "running" } });
      assert.match(output(), /✓ {2}mail over smtp and imap\s*$/m);
      assert.ok(!/:\d+/.test(output()), output());
    } finally {
      restore();
    }
  });
});

// Waiting on something with nothing on the screen to account for the wait is
// the exact failure this replaced.
test("a service this list has never heard of still gets a line of its own", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: false, stateDir });
    try {
      progress.update({ phase: "starting", services: { "some-new-thing": "running" } });
      assert.match(output(), /✓ {2}some-new-thing/);
    } finally {
      restore();
    }
  });
});

// A launch log full of redrawn spinners is worse than no progress at all.
test("piped output prints each part once, never repeats itself, and carries no escapes", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, written, restore } = render({ tty: false, stateDir });
    try {
      const services = { emulate: "running", mail: "starting" };
      for (let attempt = 0; attempt < 20; attempt += 1) progress.update({ phase: "starting", services });
      assert.equal(written.length, 1, written.join(""));
      progress.update({ phase: "starting", services: { mail: "running" } });
      assert.equal(written.length, 2, written.join(""));
      // Nothing is rewritten when there is no cursor to move.
      progress.done();
      assert.equal(written.length, 2);
      assert.ok(!written.join("").includes(ESCAPE), "no escape sequences down a pipe");
    } finally {
      restore();
    }
  });
});

// A CLI, not a display: one trailing line carries the clock, and it is erased
// before anything permanent is printed under it.
test("a terminal keeps one live line and erases it before printing beneath it", () => {
  inWorld(["slack"], {}, (stateDir) => {
    const { progress, written, restore, output } = render({ tty: true, stateDir });
    try {
      progress.begin();
      assert.ok(written[0].startsWith(ERASE), "the live line starts by taking its own row");
      assert.match(output(), /starting the world/);

      progress.update({ phase: "starting", services: { emulate: "running", mail: "starting" } });
      const permanent = written.filter((chunk) => chunk.endsWith("\n"));
      assert.equal(permanent.length, 1, written.join("|"));
      assert.match(permanent[0], /✓ {2}slack/);
      // The row the clock was on is cleared before the tick is written into it.
      assert.equal(written[written.indexOf(permanent[0]) - 1], ERASE);

      progress.done();
      assert.ok(output().endsWith(ERASE), "the live line is taken back when the launch is over");
    } finally {
      restore();
    }
  });
});

// A count that runs backwards -- 4 of 4, then 2 of 4 -- reads as something
// breaking, and recording the baseline genuinely restarts every service.
test("the clock says where the time is going, without a count that goes backwards", () => {
  inWorld([], {}, (stateDir) => {
    const { progress, restore, output } = render({ tty: true, stateDir });
    try {
      progress.begin();
      progress.update({ phase: "starting", services: { emulate: "running", mail: "starting" } });
      assert.match(output(), /\d+s {2}loading/);
      progress.update({ phase: "capturing-baseline", services: {} });
      assert.match(output(), /recording the accepted state/);
      assert.ok(!/\d of \d/.test(output()), output());
      progress.done();
    } finally {
      restore();
    }
  });
});

// Mail is the long pole on any world that has one. Saying why turns a stall
// into a number that is going somewhere.
test("the wait on mail is counted in the world's own messages", () => {
  inWorld([], { messages: 3069 }, (stateDir) => {
    const { progress, restore, output } = render({ tty: true, stateDir });
    try {
      progress.begin();
      progress.update({ phase: "starting", services: { emulate: "running", mail: "starting" } });
      assert.match(output(), /delivering 3,069 messages into Local Mail/);
      progress.done();
    } finally {
      restore();
    }
  });
});

test("an instance with nothing to report writes nothing at all", () => {
  const { progress, written, restore } = render({ tty: false });
  try {
    progress.update({ phase: "starting", services: {} });
    assert.equal(written.length, 0);
  } finally {
    restore();
  }
});

// The container publishes it; the host reads it. Best-effort, because a run
// must not fail because a progress file could not be written.
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

// A caller in the same process gets the same report the container writes to
// disk, which is what lets `up --direct` say what is loading rather than
// running the whole ninety seconds in silence.
test("progress reaches a caller in this process, and a caller that throws cannot stop the run", () => {
  const seen = [];
  publishProgress({
    onProgress: (progress) => seen.push(progress),
    phase: "starting",
    serviceStates: new Map([["mail", "starting"]]),
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].services, { mail: "starting" });

  assert.doesNotThrow(() => publishProgress({
    onProgress: () => { throw new Error("the caller's renderer is broken"); },
    phase: "starting",
    serviceStates: new Map(),
  }));
});
