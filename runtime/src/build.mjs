// `worldfixture build` and `worldfixture validate` — compile a world source
// into an artifact.
//
// THE COMPILER RUNS IN THE PRODUCT IMAGE, NOT ON THE HOST. Using a world has
// never needed a toolchain: the image ships prebuilt artifacts and `up` mounts
// one. Making a world needed the git checkout and Python 3, so somebody who
// installed with `npx worldfixture` could start the worlds we wrote and could
// not write one. The image already carries `compiler/`, `schemas/` and Python
// 3.11 -- the same three things the checkout build uses -- so the command binds
// the user's source in read-only, binds an output directory in read-write, and
// runs the same `python3 -m worldfixture_compiler` line the Dockerfile runs.
// The user needs Docker and Node, which they needed anyway.
//
// EVERY CHECK THAT CAN HAPPEN ON THE HOST HAPPENS ON THE HOST. Starting a
// container costs a second or two and a pull the first time, and "that path
// does not exist" does not need either. So the source is found, parsed, and
// checked for a world envelope here; only a source that could plausibly compile
// is sent.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// What `load_world` in the compiler accepts as a source root: one self-contained
// world, or a manifest that names fragment files beside it.
const SOURCE_VERSIONS = new Set([
  "worldfixture.world-source/v1",
  "worldfixture.world-manifest/v1",
]);

const ARTIFACT_VERSION = "worldfixture.world-artifact/v1";

// The CLI prints these itself so a refusal has a cause and a repair and no
// stack trace, the same way `OpenError` and `HostLauncherError` are handled.
export class BuildError extends Error {
  constructor(code, message, repair) {
    super(message);
    this.name = "BuildError";
    this.code = code;
    this.repair = repair;
  }
}

// Find the world source, and say what it is.
//
// A source is a directory containing `world.json`, or that file by name. Both
// are accepted because both are what people type, and the directory is what
// actually gets mounted either way: a manifest's fragments are resolved
// relative to the file's own directory and the compiler refuses a fragment path
// that leaves it.
export function inspectSource(sourcePath) {
  const path = resolve(sourcePath);
  if (!existsSync(path)) {
    throw new BuildError(
      "source_missing",
      `there is nothing at ${path}`,
      "Point it at the directory that holds your world.json, or at the world.json file itself.",
    );
  }

  const file = statSync(path).isDirectory() ? join(path, "world.json") : path;
  if (!existsSync(file)) {
    throw new BuildError(
      "source_missing",
      `${path} is a directory with no world.json in it`,
      `Create ${join(path, "world.json")}, or name the source file directly.`,
    );
  }

  let source;
  try {
    source = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new BuildError(
      "source_unreadable",
      `${file} is not readable JSON: ${String(error.message).trim().split("\n")[0]}`,
      "Fix the JSON syntax and run this again.",
    );
  }

  const apiVersion = source?.api_version;
  if (!SOURCE_VERSIONS.has(apiVersion)) {
    throw new BuildError(
      "not_a_world_source",
      `${file} declares api_version ${JSON.stringify(apiVersion ?? null)}, which is not a world source`,
      `A world source declares one of: ${[...SOURCE_VERSIONS].join(", ")}.`,
    );
  }

  // A manifest keeps the world envelope one level down, under `world`, because
  // the rest of the file lists fragments. Both shapes carry an id and a version
  // and this is the only place that has to know which is which.
  const world = apiVersion === "worldfixture.world-manifest/v1" ? (source.world ?? {}) : source;
  if (!world.id || !world.version) {
    throw new BuildError(
      "not_a_world_source",
      `${file} has no world id and version`,
      "A world declares an id such as `demo.my-world` and a version such as `v1`.",
    );
  }

  return { sourceDir: dirname(file), sourceFile: basename(file), id: world.id, version: world.version };
}

// Where a build lands when nobody said. `dist/<id>.<version>` is the layout the
// repository, the Dockerfile and the README already use, so a world built by
// hand sits where a reader expects to find one.
export function defaultOutput(source, directory = process.cwd()) {
  return resolve(directory, "dist", `${source.id}.${source.version}`);
}

// Make the output directory empty before the compiler writes into it.
//
// The compiler writes the files it produces and removes nothing, so a rebuild
// after a world lost a pack would leave that pack's file behind and the artifact
// would claim records the manifest no longer attests to. Replacing the directory
// is only safe for something this command itself produced, so anything else with
// files in it is refused rather than deleted.
function prepareOutput(outputDir) {
  if (existsSync(outputDir)) {
    if (!statSync(outputDir).isDirectory()) {
      throw new BuildError(
        "output_occupied",
        `${outputDir} is a file, not a directory`,
        "Choose an --output path that is a directory, or does not exist yet.",
      );
    }
    if (readdirSync(outputDir).length > 0) {
      const manifest = join(outputDir, "manifest.json");
      const built = existsSync(manifest)
        ? JSON.parse(readFileSync(manifest, "utf8"))?.api_version === ARTIFACT_VERSION
        : false;
      if (!built) {
        throw new BuildError(
          "output_occupied",
          `${outputDir} already holds files that are not a world artifact`,
          "Choose an empty --output directory, so nothing of yours is replaced.",
        );
      }
      rmSync(outputDir, { recursive: true, force: true });
    }
  }
  mkdirSync(outputDir, { recursive: true });
}

// The `docker run` for one compile.
//
// Kept as a pure function so the tests can read the arguments rather than start
// a container to find out what was mounted where.
export function compilerArguments({ command, image, sourceDir, sourceFile, outputDir, user }) {
  const args = [
    "run", "--rm",
    "--mount", `type=bind,source=${sourceDir},target=/world,readonly`,
  ];
  if (outputDir) args.push("--mount", `type=bind,source=${outputDir},target=/output`);
  // The container is root by default, and on Linux that leaves an artifact the
  // user who asked for it cannot delete. Running as the caller writes files they
  // own. Everything the compiler reads inside the image is world-readable.
  if (user) args.push("--user", user);
  // The compiler package is on the image's PYTHONPATH already. Byte-code caching
  // would be the one thing it tried to write outside /output, and as a non-root
  // user that fails; Python only warns, but the warning is noise in the middle
  // of a build.
  args.push("--env", "PYTHONDONTWRITEBYTECODE=1");
  args.push("--entrypoint", "python3", image);
  args.push("-m", "worldfixture_compiler", command, `/world/${sourceFile}`);
  if (outputDir) args.push("--output", "/output");
  return args;
}

// The caller's own identity, where the platform has one. Windows has no uid.
export function currentUser() {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return `${process.getuid()}:${process.getgid()}`;
}

// `docker` with its output going straight to the terminal.
//
// The compiler's own progress and its errors are what the user needs to read,
// so they are streamed rather than buffered and reprinted. A missing `docker`
// arrives here as a spawn ENOENT and is left to travel: the CLI catches that in
// one place and explains how to install Docker.
function streamDocker(args) {
  return new Promise((settle, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code, signal) => settle(signal ? 1 : (code ?? 1)));
  });
}

async function compile({ command, source, image, outputDir, runner, user }) {
  const args = compilerArguments({
    command,
    image,
    sourceDir: source.sourceDir,
    sourceFile: source.sourceFile,
    outputDir,
    user,
  });
  const code = await runner(args);
  if (code !== 0) {
    throw new BuildError(
      command === "build" ? "build_failed" : "validation_failed",
      `the compiler rejected ${join(source.sourceDir, source.sourceFile)}`,
      "The compiler's own message is above; it names the record it refused and why.",
    );
  }
}

export async function validateWorldSource({ source, image, runner = streamDocker, user = currentUser() }) {
  const inspected = inspectSource(source);
  await compile({ command: "validate", source: inspected, image, runner, user });
  return inspected;
}

export async function buildWorldSource({
  source,
  output,
  image,
  runner = streamDocker,
  user = currentUser(),
  directory = process.cwd(),
}) {
  const inspected = inspectSource(source);
  const outputDir = output ? resolve(directory, output) : defaultOutput(inspected, directory);

  // An output directory inside the source would be mounted read-only at /world
  // and written to at /output at the same time, which Docker allows and which
  // then produces an artifact that is also an input to its own next build.
  if (outputDir === inspected.sourceDir || outputDir.startsWith(`${inspected.sourceDir}/`)) {
    throw new BuildError(
      "output_inside_source",
      `${outputDir} is inside the world source at ${inspected.sourceDir}`,
      "Build to a directory outside the source, such as `dist/`.",
    );
  }

  prepareOutput(outputDir);
  await compile({ command: "build", source: inspected, image, outputDir, runner, user });
  return { ...inspected, outputDir };
}
