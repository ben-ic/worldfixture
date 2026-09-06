// Test infrastructure for the world matrix. Containers have a unique owner label;
// cleanup never searches for or removes another developer's running instance.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { translateBindings } from "../../runtime/src/host-launcher.mjs";

const execute = promisify(execFile);
const SECRET_KEY = /token|secret|password|authorization|cookie|private.?key/i;

export function redact(value, secrets = []) {
  const known = secrets.filter((entry) => typeof entry === "string" && entry.length >= 4)
    .sort((a, b) => b.length - a.length);
  const visit = (node) => {
    if (typeof node === "string") {
      let result = node;
      for (const secret of known) result = result.replaceAll(secret, "[redacted]");
      return result.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
        .replace(/((?:token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key,
        SECRET_KEY.test(key) && typeof item !== "boolean" ? "[redacted]" : visit(item)]));
    }
    return node;
  };
  return visit(value);
}

export function credentialValues(value) {
  const result = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        if (SECRET_KEY.test(key) && typeof item === "string") result.push(item);
        // An overlay's tokens object contains login and scope metadata. Those
        // strings are world facts, not credentials to erase from the evidence.
        if (key === "tokens" && item && typeof item === "object") result.push(...Object.keys(item));
        walk(item);
      }
    }
  };
  walk(value);
  return result;
}

export function responseInventory(responses) {
  return responses.map(({ provider, path, body, status }) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { provider, path, status, bytes: Buffer.byteLength(text ?? ""),
      sha256: createHash("sha256").update(text ?? "").digest("hex") };
  });
}

export function mappedBindings(bindings, ports) {
  const map = new Map();
  for (const [internal, published] of Object.entries(ports ?? {})) {
    if (!published?.length) continue;
    if (published[0].HostIp !== "127.0.0.1") throw new Error(`test port ${internal} is not bound to loopback`);
    map.set(Number(internal.split("/")[0]), { hostPort: Number(published[0].HostPort) });
  }
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value !== "string" || !/^https?:\/\//.test(value)) continue;
    const url = new URL(value);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`${name} does not address the isolated test container`);
    if (!map.has(Number(url.port))) throw new Error(`${name} has no published test port`);
  }
  return translateBindings(bindings, map);
}

export async function docker(args, options = {}) {
  return execute("docker", args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024, ...options });
}

export function containerArguments({ image, artifactPath, name, owner, exposedPorts }) {
  if (!exposedPorts.length) throw new Error("the test image declares no ports");
  return ["run", "--detach", "--name", name, "--label", `worldfixture.coupling.owner=${owner}`,
    ...exposedPorts.flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
    "--mount", `type=bind,src=${artifactPath},dst=/world,readonly`,
    "--entrypoint", "/usr/bin/tini", image, "--", "node", "runtime/bin/worldfixture.mjs",
    "up", "--world-path", "/world", "--service-root", "/opt/worldfixture/emulators",
    "--state", "/state", "--no-rebase"];
}

export async function removeOwnedContainer(name, owner, run = docker) {
  let result;
  try { result = await run(["inspect", name]); }
  catch (error) {
    if (/\bno such (object|container):/i.test(error.stderr ?? "")) return false;
    throw error;
  }
  const [inspection] = JSON.parse(result.stdout);
  if (inspection.Config?.Labels?.["worldfixture.coupling.owner"] !== owner) {
    throw new Error(`refusing to remove container without this test's owner label: ${name}`);
  }
  await run(["rm", "--force", name]);
  return true;
}

export async function waitForReady(name, { timeoutMs = 180_000, run = docker, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const [inspection] = JSON.parse((await run(["inspect", name])).stdout);
    const logs = await run(["logs", "--tail", "200", name]);
    const text = logs.stdout + logs.stderr;
    if (!inspection.State.Running) throw new Error(`world exited ${inspection.State.ExitCode}:\n${text}`);
    if (text.includes("Stop with Ctrl-C")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`world did not become ready within ${timeoutMs} ms`);
}

export async function readRunBindings(name, run = docker) {
  const result = await run(["exec", name, "node", "-e",
    "process.stdout.write(require('node:fs').readFileSync('/state/bindings.json','utf8'))"]);
  return JSON.parse(result.stdout);
}

export async function readRunCredentialSet(name, run = docker) {
  const result = await run(["exec", name, "node", "--input-type=module", "-e",
    "import {readRunCredentials} from './runtime/src/credentials.mjs'; process.stdout.write(JSON.stringify(readRunCredentials('/state')))"]);
  return JSON.parse(result.stdout);
}

export async function pauseRunClock(name, run = docker) {
  // The CLI does not expose clock controls yet. Call the existing runtime clock
  // API for this test's own run; no emulator database or clock arithmetic changes.
  const result = await run(["exec", name, "node", "--input-type=module", "-e",
    "import {openState} from './runtime/src/state.mjs'; import {pauseClock,clockState} from './runtime/src/clock.mjs'; const db=openState('/state/state.sqlite'); try {const before=clockState(db); if(before.started)pauseClock(db); process.stdout.write(JSON.stringify(clockState(db)))} finally {db.close()}"]);
  return JSON.parse(result.stdout);
}
