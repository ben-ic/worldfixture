// `worldfixture build` and `worldfixture validate`, without starting a container.
//
// The one thing that has to be right about this command is the `docker run` it
// composes: which directory is mounted where, which way round read-only goes,
// and which compiler line runs. So the runner is injected and the arguments are
// read, rather than a container being started to find out afterwards.
//
// The refusals are tested for the same reason they exist: a wrong path, a file
// that is not a world, or an output directory with somebody else's files in it
// should all be answered before Docker is ever reached.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BuildError,
  buildWorldSource,
  compilerArguments,
  defaultOutput,
  inspectSource,
  validateWorldSource,
} from "./build.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "runtime/bin/worldfixture.mjs");

const scratch = [];
after(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));

function directory() {
  const path = mkdtempSync(join(tmpdir(), "worldfixture-build-"));
  scratch.push(path);
  return path;
}

const MANIFEST = {
  api_version: "worldfixture.world-manifest/v1",
  world: { id: "demo.two-people", version: "v2" },
  fragments: ["backbones/people.json"],
};

// A world source on disk, in the shape the compiler reads: a manifest beside the
// fragments it names.
function worldSource(source = MANIFEST) {
  const path = directory();
  mkdirSync(join(path, "backbones"), { recursive: true });
  writeFileSync(join(path, "world.json"), `${JSON.stringify(source, null, 2)}\n`);
  writeFileSync(join(path, "backbones/people.json"), "{}\n");
  return path;
}

// A runner that records what it was asked to run and reports success.
function recorder(code = 0) {
  const calls = [];
  return {
    calls,
    runner: async (args) => {
      calls.push(args);
      const output = args.find(value => value.endsWith(',target=/output'))?.slice('type=bind,source='.length, -',target=/output'.length);
      if (output && code === 0) {
        const artifact = join(output, 'artifact');
        rmSync(artifact, { recursive: true, force: true }); mkdirSync(artifact);
        writeFileSync(join(artifact, 'manifest.json'), JSON.stringify({ api_version: 'worldfixture.world-artifact/v1' }));
      }
      return code;
    },
  };
}

test("a source directory is found by the world.json inside it", () => {
  const path = worldSource();

  const inspected = inspectSource(path);

  assert.equal(inspected.sourceDir, path);
  assert.equal(inspected.sourceFile, "world.json");
  assert.equal(inspected.id, "demo.two-people");
  assert.equal(inspected.version, "v2");
});

// The directory is what gets mounted either way, because a manifest's fragments
// are resolved against it.
test("naming the source file gives the same source as naming its directory", () => {
  const path = worldSource();

  assert.deepEqual(inspectSource(join(path, "world.json")), inspectSource(path));
});

test("a self-contained world source is read from its own top level", () => {
  const path = directory();
  writeFileSync(join(path, "world.json"), JSON.stringify({
    api_version: "worldfixture.world-source/v1",
    id: "demo.flat",
    version: "v1",
  }));

  assert.equal(inspectSource(path).id, "demo.flat");
});

test("a path that does not exist is refused with the path and what to point at", () => {
  const missing = join(directory(), "nowhere");

  assert.throws(() => inspectSource(missing), (error) => {
    assert.ok(error instanceof BuildError);
    assert.equal(error.code, "source_missing");
    assert.match(error.message, new RegExp(missing));
    assert.match(error.repair, /world\.json/);
    return true;
  });
});

test("a directory with no world.json names the file it wanted", () => {
  const path = directory();

  assert.throws(() => inspectSource(path), (error) => {
    assert.equal(error.code, "source_missing");
    assert.match(error.repair, new RegExp(join(path, "world.json")));
    return true;
  });
});

test("a file that is not a world source says which api_version it declared", () => {
  const path = directory();
  writeFileSync(join(path, "world.json"), JSON.stringify({ api_version: "something.else/v1" }));

  assert.throws(() => inspectSource(path), (error) => {
    assert.equal(error.code, "not_a_world_source");
    assert.match(error.message, /"something\.else\/v1"/);
    return true;
  });
});

test("broken JSON is reported as broken JSON, not as a missing world", () => {
  const path = directory();
  writeFileSync(join(path, "world.json"), "{ not json");

  assert.throws(() => inspectSource(path), (error) => {
    assert.equal(error.code, "source_unreadable");
    return true;
  });
});

// The mount directions are the whole safety story of this command: the user's
// source cannot be written to, and nothing but the output directory can be.
test("build mounts the source read-only and the output read-write", () => {
  const args = compilerArguments({
    command: "build",
    image: "worldfixture:local",
    sourceDir: "/home/ada/my-world",
    sourceFile: "world.json",
    outputDir: "/home/ada/dist/demo.v1",
    user: "501:20",
  });

  assert.ok(args.includes("type=bind,source=/home/ada/my-world,target=/world,readonly"));
  assert.ok(args.includes("type=bind,source=/home/ada/dist/demo.v1,target=/output"));
  assert.deepEqual(args.slice(-7), [
    "worldfixture:local", "-m", "worldfixture_compiler", "build", "/world/world.json", "--output", "/output/artifact",
  ]);
  assert.ok(args.includes("--user"));
  assert.ok(args.includes("501:20"));
});

test("validate mounts nothing writable and asks for no output", () => {
  const args = compilerArguments({
    command: "validate",
    image: "worldfixture:local",
    sourceDir: "/home/ada/my-world",
    sourceFile: "world.json",
  });

  assert.equal(args.filter((value) => value === "--mount").length, 1);
  assert.ok(!args.includes("--output"));
  assert.ok(!args.includes("--user"));
  assert.deepEqual(args.slice(-4), ["-m", "worldfixture_compiler", "validate", "/world/world.json"]);
});

test("an unnamed output lands in dist beside the id and version", () => {
  assert.equal(
    defaultOutput({ id: "demo.two-people", version: "v2" }, "/home/ada/app"),
    "/home/ada/app/dist/demo.two-people.v2",
  );
});

test("a build writes to the directory it reports", async () => {
  const source = worldSource();
  const workspace = directory();
  const { calls, runner } = recorder();

  const built = await buildWorldSource({ source, image: "worldfixture:local", runner, directory: workspace });

  assert.equal(built.outputDir, join(workspace, "dist/demo.two-people.v2"));
  assert.ok(calls[0].some(value => value.startsWith(`type=bind,source=${join(workspace, 'dist/.demo.two-people.v2-build-')}`) && value.endsWith(',target=/output')));
  assert.equal(existsSync(join(built.outputDir, 'manifest.json')), true);
  assert.deepEqual(readdirSync(join(workspace, 'dist')), ['demo.two-people.v2']);
});

// A relative --output is relative to where the user is standing, not to the
// world they are compiling.
test("a relative output is resolved against the working directory", async () => {
  const source = worldSource();
  const workspace = directory();
  const { runner } = recorder();

  const built = await buildWorldSource({
    source, output: "artifacts/mine", image: "worldfixture:local", runner, directory: workspace,
  });

  assert.equal(built.outputDir, join(workspace, "artifacts/mine"));
});

test("an output inside the source is refused before anything is mounted", async () => {
  const source = worldSource();
  const { calls, runner } = recorder();

  await assert.rejects(
    buildWorldSource({ source, output: join(source, "dist"), image: "worldfixture:local", runner }),
    (error) => {
      assert.equal(error.code, "output_inside_source");
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

// A rebuild after a world lost a pack must not leave the old pack behind, so a
// previous artifact is replaced whole.
test("a previous artifact in the output directory is replaced", async () => {
  const source = worldSource();
  const workspace = directory();
  const output = join(workspace, "dist/demo.two-people.v2");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "manifest.json"), JSON.stringify({ api_version: "worldfixture.world-artifact/v1" }));
  mkdirSync(join(output, 'packs'));
  writeFileSync(join(output, "packs/stale.json"), "{}");

  await buildWorldSource({ source, image: "worldfixture:local", runner: recorder().runner, directory: workspace });

  assert.deepEqual(readdirSync(output), ['manifest.json']);
});

test('a failed or absent compiler output preserves the previous artifact and removes staging', async () => {
  const source = worldSource(), workspace = directory(), output = join(workspace, 'artifact');
  mkdirSync(output);
  const manifest = JSON.stringify({ api_version: 'worldfixture.world-artifact/v1' });
  writeFileSync(join(output, 'manifest.json'), manifest);
  writeFileSync(join(output, 'world.json'), '{"id":"previous"}');
  for (const runner of [recorder(1).runner, async args => {
    const staged = args.find(value => value.endsWith(',target=/output')).slice('type=bind,source='.length, -',target=/output'.length);
    rmSync(join(staged, 'artifact'), { recursive: true }); return 0;
  }]) {
    await assert.rejects(buildWorldSource({ source, output, image: 'worldfixture:local', runner }));
    assert.equal(readFileSync(join(output, 'manifest.json'), 'utf8'), manifest);
    assert.equal(readFileSync(join(output, 'world.json'), 'utf8'), '{"id":"previous"}');
    assert.deepEqual(readdirSync(workspace), ['artifact']);
  }
});

test("an output directory holding anything else is refused rather than deleted", async () => {
  const source = worldSource();
  const output = directory();
  writeFileSync(join(output, "thesis.txt"), "years of work");
  const { calls, runner } = recorder();

  await assert.rejects(
    buildWorldSource({ source, output, image: "worldfixture:local", runner }),
    (error) => {
      assert.equal(error.code, "output_occupied");
      return true;
    },
  );
  assert.deepEqual(readdirSync(output), ["thesis.txt"]);
  assert.equal(calls.length, 0);
});

test("a compiler that exits non-zero fails the build and says which source", async () => {
  const source = worldSource();
  const { runner } = recorder(1);

  await assert.rejects(
    buildWorldSource({ source, image: "worldfixture:local", runner, directory: directory() }),
    (error) => {
      assert.equal(error.code, "build_failed");
      assert.match(error.message, new RegExp(join(source, "world.json")));
      return true;
    },
  );
});

test("a compiler that rejects a source fails validate", async () => {
  const source = worldSource();
  const { runner } = recorder(1);

  await assert.rejects(
    validateWorldSource({ source, image: "worldfixture:local", runner }),
    (error) => {
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );
});

// The command line itself: a refusal that happens before Docker must still read
// like every other refusal this CLI prints, and must not be a stack trace.
test("the CLI refuses a missing source with a cause, a state line and a repair", async () => {
  const missing = join(directory(), "nowhere");

  const { stdout, code } = await run(process.execPath, [BIN, "build", missing], { cwd: ROOT })
    .catch((error) => ({ stdout: error.stdout, code: error.code }));

  assert.equal(code, 1);
  assert.match(stdout, /build failed: there is nothing at /);
  assert.match(stdout, /No world state changed\./);
  assert.match(stdout, /world\.json/);
  assert.ok(!stdout.includes("at Object."), stdout);
});

test("the CLI prints what build is for when it is given nothing", async () => {
  const { stdout, code } = await run(process.execPath, [BIN, "build"], { cwd: ROOT })
    .catch((error) => ({ stdout: error.stdout, code: error.code }));

  assert.equal(code, 1);
  assert.match(stdout, /worldfixture build <source>/);
  assert.match(stdout, /no Python/);
});

test("build and validate are listed in the top-level help", async () => {
  const { stdout } = await run(process.execPath, [BIN, "help"], { cwd: ROOT });

  assert.match(stdout, /worldfixture build <source>/);
  assert.match(stdout, /worldfixture validate <source>/);
  assert.match(stdout, /worldfixture up --world-path <dir>/);
});

// The bug this closes: the first screen ends with "Try this" and one command,
// and it printed a bare `worldfixture ...`. Somebody who installed the way the
// README tells them to -- `npx worldfixture up` -- has no `worldfixture` on
// their PATH, so the very first thing the product invites them to do answers
// `command not found`. A first-use run hit it within a minute of publishing.
test("a suggested command is written the way the reader actually invokes it", async () => {
  const { invocation } = await import("./cli.mjs");
  const root = "/opt/worldfixture";

  assert.equal(invocation("/app/node_modules/worldfixture/runtime/bin/worldfixture.mjs", root), "npx worldfixture");
  assert.equal(invocation("/usr/local/bin/worldfixture", root), "worldfixture");
  assert.equal(invocation(undefined, root), "worldfixture");

  // A checkout has no shim at all, so neither of the above would run. It names
  // the file, absolutely rather than as `node ../../../../..`.
  const fromCheckout = invocation(`${root}/runtime/bin/worldfixture.mjs`, root);
  assert.match(fromCheckout, /^node \//);
  assert.match(fromCheckout, /worldfixture\.mjs$/);
});

// The bug this closes: the README told the reader to `cp -r examples/minimal-world`,
// which works from a checkout and leaves an npm install with nothing to copy --
// the starter world is inside `node_modules` at a path nobody should have to
// name. The starter world is the whole reason authoring one is approachable,
// because the profile compiles seven domains that must be declared even empty.
test("new copies the starter world and refuses to overwrite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "worldfixture-new-"));
  const target = join(directory, "my-world");

  try {
    const first = await run(process.execPath, [BIN, "new", target], { cwd: ROOT })
      .catch((error) => ({ stdout: error.stdout, code: error.code }));
    assert.equal(first.code ?? 0, 0, first.stdout + first.stderr);
    assert.equal(existsSync(join(target, "world.json")), true);
    assert.equal(existsSync(join(target, "fragments/core.json")), true);
    assert.match(first.stdout, /Copied the starter world/);

    const again = await run(process.execPath, [BIN, "new", target], { cwd: ROOT })
      .catch((error) => ({ stdout: error.stdout, code: error.code }));
    assert.equal(again.code, 1);
    assert.match(again.stdout, /already exists/);
    assert.match(again.stdout, /does not exist yet/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
