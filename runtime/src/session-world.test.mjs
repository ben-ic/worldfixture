import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { rebaseForSession, repairFor } from "./session-world.mjs";
import { inspectWorldArtifact } from "./world-catalogue.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILT = join(ROOT, "dist/business.saas-company.v2");

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-session-world-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a renamed artifact finds its exact source and produces a verified session", (t) => {
  const root = temporary(t);
  const renamed = join(root, "renamed artifact");
  cpSync(BUILT, renamed, { recursive: true });
  const original = readFileSync(join(renamed, "manifest.json"));
  const result = rebaseForSession(renamed, join(root, "state"), { quiet: true });
  assert.equal(result.rebased, true, result.reason);
  const checked = inspectWorldArtifact(result.artifactPath);
  assert.equal(checked.valid, true, checked.errors.join("; "));
  assert.equal(checked.id, "business.saas-company");
  assert.equal(checked.version, "v2");
  assert.deepEqual(readFileSync(join(renamed, "manifest.json")), original);
  assert.deepEqual(readdirSync(join(root, "state")), ["world"]);
});

test("compiler failure preserves an input that is also the previous session", (t) => {
  const state = temporary(t);
  const input = join(state, "world");
  cpSync(BUILT, input, { recursive: true });
  const before = readFileSync(join(input, "manifest.json"));
  const result = rebaseForSession(input, state, {
    quiet: true,
    runCompiler() { throw new Error("controlled compiler failure"); },
  });
  assert.equal(result.rebased, false);
  assert.match(result.reason, /controlled compiler failure/);
  assert.deepEqual(readFileSync(join(input, "manifest.json")), before);
  assert.equal(inspectWorldArtifact(input).valid, true);
  assert.deepEqual(readdirSync(state), ["world"]);
});

// THE FAILURE THIS NAMES. A checkout without the compiler's Python dependency
// installed reported `ModuleNotFoundError: No module named 'jsonschema'` on a
// line about world dates, started the world sixteen days behind today, and
// never said which command fixes it.
test("a rebase that cannot run at all names the command that fixes it", (t) => {
  const state = temporary(t);
  const input = join(state, "world");
  cpSync(BUILT, input, { recursive: true });
  const result = rebaseForSession(input, state, {
    quiet: true,
    runCompiler() {
      throw Object.assign(new Error("Command failed"), {
        stderr: "Traceback (most recent call last):\n  File \"<string>\", line 1\nModuleNotFoundError: No module named 'jsonschema'",
      });
    },
  });
  assert.equal(result.rebased, false);
  assert.match(result.reason, /No module named 'jsonschema'/);
  assert.match(result.repair, /missing its jsonschema dependency/);
  assert.match(result.repair, /pip install -r requirements\.txt/);
});

test("a missing python3 is named as a missing python3, not as a compiler that refused", (t) => {
  const state = temporary(t);
  const input = join(state, "world");
  cpSync(BUILT, input, { recursive: true });
  const result = rebaseForSession(input, state, {
    quiet: true,
    runCompiler() { throw Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }); },
  });
  assert.equal(result.rebased, false);
  assert.match(result.repair, /python3 is not on PATH/);
});

// A compiler that ran and rejected the source is a different problem, and
// advice invented for it would send somebody to install something they have.
test("a compiler that ran and refused the source is given no repair to follow", (t) => {
  const state = temporary(t);
  const input = join(state, "world");
  cpSync(BUILT, input, { recursive: true });
  const result = rebaseForSession(input, state, {
    quiet: true,
    runCompiler() { throw new Error("world.yaml: person maya-chen has no email"); },
  });
  assert.equal(result.rebased, false);
  assert.equal(result.repair, null);
});

test("the repair is decided from the cause, not from the wording of a traceback", () => {
  assert.equal(repairFor({ code: "ENOENT" }, "spawn python3 ENOENT").startsWith("python3 is not on PATH"), true);
  assert.match(repairFor({}, "ModuleNotFoundError: No module named 'yaml'"), /missing its yaml dependency/);
  assert.equal(repairFor({}, "the compiler rejected this world"), null);
});

test("unverified source leaves the artifact and state unchanged", (t) => {
  const root = temporary(t);
  const state = join(root, "state");
  const result = rebaseForSession(BUILT, state, {
    quiet: true,
    sourceRoots: [],
    runCompiler() { assert.fail("unverified source must not run the compiler"); },
  });
  assert.equal(result.rebased, false);
  assert.equal(result.artifactPath, BUILT);
  assert.match(result.reason, /no world source verified/);
  assert.equal(existsSync(state), false);
});

test("a compiler result with no verified artifact cannot replace the previous session", (t) => {
  const state = temporary(t);
  cpSync(BUILT, join(state, "world"), { recursive: true });
  const before = readFileSync(join(state, "world", "manifest.json"));
  const result = rebaseForSession(BUILT, state, { quiet: true, runCompiler() {} });
  assert.equal(result.rebased, false);
  assert.match(result.reason, /failed validation/);
  assert.deepEqual(readFileSync(join(state, "world", "manifest.json")), before);
  assert.deepEqual(readdirSync(state), ["world"]);
});

test("source edits after selection cannot change the next session", (t) => {
  const root = temporary(t);
  const source = join(root, "source");
  cpSync(join(ROOT, "worlds/business.saas-company.v2"), source, { recursive: true });
  const state = join(root, "state");
  const previous = join(state, "world");
  cpSync(BUILT, previous, { recursive: true });
  const before = readFileSync(join(previous, "manifest.json"));
  const result = rebaseForSession(BUILT, state, {
    quiet: true,
    sourceRoots: [source],
    runCompiler(command, args, options) {
      const sourceFile = join(source, "world.json");
      const changed = JSON.parse(readFileSync(sourceFile, "utf8"));
      changed.title = "Content changed after selection";
      writeFileSync(sourceFile, JSON.stringify(changed));
      return execFileSync(command, args, options);
    },
  });
  assert.equal(result.rebased, false);
  assert.match(result.reason, /source changed after artifact selection/);
  assert.deepEqual(readFileSync(join(previous, "manifest.json")), before);
  assert.deepEqual(readdirSync(state), ["world"]);
});
