// Build or pull every container image the service manifests name, before the
// tests that need them run.
//
// WHY THIS EXISTS. `ensureImage` in the supervisor builds a missing image on
// demand, inside whatever budget the caller gave the start. That is right for a
// developer -- it happens once and then never again -- and wrong for CI, which
// starts from an empty Docker cache every time. Building Cyrus from a Debian
// base takes longer than the 300-second readiness budget `cli.test.mjs` allows,
// so 23 runtime tests failed with `up never became ready` and nothing in the
// message said an image build was the reason.
//
// The tags come from the manifests rather than from a list here, because a list
// here would drift the first time a service changed its tag and the failure
// would look like the one above all over again.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const emulators = join(root, "emulators");

function manifests() {
  return readdirSync(emulators, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(emulators, entry.name, "service.json"))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }));
}

const run = (args) => execFileSync("docker", args, { stdio: "inherit" });

function has(tag) {
  try {
    execFileSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let prepared = 0;
for (const { path, manifest } of manifests()) {
  const container = manifest.runtime?.container;
  if (!container?.tag) continue;
  if (has(container.tag)) {
    console.log(`have    ${container.tag}`);
    continue;
  }

  if (container.build) {
    // The build context is resolved the way the supervisor resolves it: relative
    // to the directory the manifest lives in.
    const context = resolve(dirname(path), container.build);
    const args = ["build"];
    if (container.platform) args.push("--platform", container.platform);
    args.push("-t", container.tag, context);
    console.log(`build   ${container.tag}`);
    run(args);
  } else {
    console.log(`pull    ${container.tag}`);
    run(["pull", container.tag]);
  }
  prepared += 1;
}

console.log(`${prepared} image(s) prepared`);
