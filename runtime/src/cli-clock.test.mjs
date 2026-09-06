import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { clockCommandInput, parse, prepareContainerArgs } from "./cli.mjs";

const execute = promisify(execFile);
const cli = new URL("../bin/worldfixture.mjs", import.meta.url).pathname;

test("clock syntax validates the operation and duration before runtime access", () => {
  assert.deepEqual(clockCommandInput([]), { action: "status" });
  assert.deepEqual(clockCommandInput(["advance", "1w"]), { action: "advance", duration: "1w" });
  assert.deepEqual(clockCommandInput(["start", "0s"]), { action: "start", duration: "0s" });
  assert.throws(() => clockCommandInput(['start']));
  assert.throws(() => clockCommandInput(['start', '-1s']));
  for (const args of [["advance"], ["advance", "-1s"], ["advance", "Infinitys"], ["advance", "9007199254740992ms"], ["pause", "1s"], ["rewind", "1m"], ["advance", "1s", "extra"]]) {
    assert.throws(() => clockCommandInput(args), undefined, JSON.stringify(args));
  }
  assert.deepEqual(parse(["--setup", "--repeat"]).flags, { setup: true, repeat: true });
});

test("invalid starting positions refuse launch before project or state writes", async t => {
  const root = mkdtempSync(join(tmpdir(), "wf-clock-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const flags of [["--start-at", "-1s"], ["--start-at", "1year"], ["--start-at", "1e100s"], ["--setup", "--start-at", "5m"]]) {
    await assert.rejects(execute(process.execPath, [cli, "up", ...flags, "--state", join(root, "state"), "--project-dir", join(root, "project")], {
      cwd: root, env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "0" },
    }), error => error.code === 1 && /failed:/.test(error.stdout));
    assert.deepEqual(readdirSync(root), [], flags.join(" "));
  }
});

test("container launch retains clock options and refuses invalid values before artifact staging", t => {
  const root = mkdtempSync(join(tmpdir(), "wf-clock-args-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const world = new URL("../../dist/business.saas-company.v2", import.meta.url).pathname;
  const state = join(root, "state");
  assert.throws(() => prepareContainerArgs(world, state, { "start-at": "bad" }));
  assert.equal(existsSync(state), false);
  assert.deepEqual(prepareContainerArgs(world, state, { "start-at": "90s", repeat: true, "no-rebase": true }),
    ["--world-path", "/state/input-world", "--no-rebase", "--start-at", "90s", "--repeat"]);
  assert.deepEqual(prepareContainerArgs(world, state, { setup: true }), ["--world-path", "/state/input-world", "--setup"]);
});
