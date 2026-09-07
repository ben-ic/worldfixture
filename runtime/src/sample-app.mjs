import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const RECORD = "sample-app.json";

export function sampleAppPath(packageRoot) {
  return join(packageRoot, "examples/demo_app");
}

export function sampleAppAvailable(packageRoot) {
  const root = sampleAppPath(packageRoot);
  return existsSync(join(root, "package.json"))
    && existsSync(join(root, "package-lock.json"))
    && existsSync(join(root, "src/server/main.mjs"))
    && existsSync(join(root, "dist/index.html"));
}

export async function askForSampleApp({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) return false;
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question("Launch the Account Desk demo app? Press Enter, or type n to skip: ")).trim().toLowerCase();
    return answer !== "n" && answer !== "no";
  } finally {
    prompt.close();
  }
}

export async function askToOpenBrowser(subject, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) return false;
  const prompt = createInterface({ input, output });
  try {
    const answer = (await prompt.question(`Open ${subject} in your browser? Press Enter, or type n to skip: `)).trim().toLowerCase();
    return answer !== "n" && answer !== "no";
  } finally {
    prompt.close();
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} stopped with ${signal ?? `status ${code}`}`));
    });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ready(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Account Desk did not answer at ${url} within ${timeoutMs / 1000} seconds`);
}

async function installDependencies(root, onInstall) {
  if (existsSync(join(root, "node_modules"))) return;
  onInstall();
  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
}

export async function connectSampleApp(workbenchUrl, applicationUrl) {
  const session = await fetch(`${workbenchUrl}/api/session`);
  if (!session.ok) throw new Error(`Workbench session check returned HTTP ${session.status}`);
  const generation = session.headers.get("x-worldfixture-generation") ?? (await session.json()).generation;
  const response = await fetch(`${workbenchUrl}/api/world/connection`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worldfixture-generation": generation },
    body: JSON.stringify({ applicationUrl }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Workbench connection returned HTTP ${response.status}`);
  }
}

export async function startSampleApp({ packageRoot, stateDir, bindings, world, workbenchUrl, onInstall = () => {} }) {
  const root = sampleAppPath(packageRoot);
  if (!sampleAppAvailable(packageRoot)) throw new Error("this WorldFixture package does not contain Account Desk");
  await installDependencies(root, onInstall);
  stopSampleApp(stateDir);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logPath = join(stateDir, "sample-app.log");
  const output = openSync(logPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [join(root, "src/server/main.mjs")], {
      cwd: root,
      detached: true,
      stdio: ["ignore", output, output],
      env: {
        ...process.env,
        ...bindings,
        WORLDFIXTURE_WORLD_ID: world.id,
        WORLDFIXTURE_WORLD_VERSION: world.version,
        ACCOUNT_DESK_PORT: String(port),
        ACCOUNT_DESK_SQLITE_PATH: join(stateDir, "account-desk.sqlite"),
      },
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  const failed = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(
      `Account Desk stopped before it was ready with ${signal ?? `status ${code}`}`,
    )));
  });
  try {
    await Promise.race([ready(url), failed]);
    await connectSampleApp(workbenchUrl, url);
  } catch (error) {
    try {
      if (Number.isInteger(child.pid)) process.kill(-child.pid, "SIGTERM");
    } catch (stopError) {
      if (stopError.code !== "ESRCH") throw new AggregateError([error, stopError], "Account Desk did not start and its process could not be stopped");
    }
    throw error;
  }
  writeFileSync(join(stateDir, RECORD), `${JSON.stringify({ pid: child.pid, url, logPath }, null, 2)}\n`);
  return { pid: child.pid, url, logPath };
}

export function stopSampleApp(stateDir) {
  const path = join(stateDir, RECORD);
  if (!existsSync(path)) return false;
  const record = JSON.parse(readFileSync(path, "utf8"));
  try { process.kill(-record.pid, "SIGTERM"); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  rmSync(path, { force: true });
  return true;
}
