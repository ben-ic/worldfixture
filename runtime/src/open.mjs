// `worldfixture open` — open the running instance's Workbench in a browser.
//
// THE WHOLE POINT IS THAT THE PORT IS NOT KNOWN. The Workbench listens on a
// stable port INSIDE the container and on whatever host port the launcher could
// get. `worldfixture open` is the documented way to reach it precisely so a
// user never has to know which one they got, and an
// implementation that opened `http://localhost:8080` would be wrong twice over:
// 8080 is the HTTP target site, not the Workbench, and any preferred port can
// have fallen back. So the URL comes from `WORKBENCH_URL` in the bindings this
// instance recorded, and from nowhere else.
//
// LAUNCHING IS INJECTED. `launch` is a parameter with a real default, so the
// tests below drive the whole command — record lookup, availability check, error
// messages — without a browser window appearing on anybody's screen.
//
// SUPPORTED PLATFORMS. macOS is supported and tested. Linux and Windows have
// their conventional openers wired and are untested here; `open` says so rather
// than failing with `ENOENT` from a command the user never typed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { hostBindings, inspectHostInstance } from "./host-launcher.mjs";

const execFileAsync = promisify(execFile);

// Tested on darwin. The other two are the conventional openers and are wired
// rather than guessed at call time; `TESTED_PLATFORMS` is what the CLI reports.
export const OPENERS = {
  darwin: (url) => ["open", [url]],
  linux: (url) => ["xdg-open", [url]],
  win32: (url) => ["cmd", ["/c", "start", "", url]],
};

export const TESTED_PLATFORMS = ["darwin"];

export class OpenError extends Error {
  constructor(code, message, repair) {
    super(message);
    this.code = code;
    this.repair = repair;
  }
}

async function defaultLaunch(url, platform = process.platform) {
  const opener = OPENERS[platform];
  if (!opener) {
    throw new OpenError(
      "unsupported_platform",
      `this platform (${platform}) has no browser opener`,
      `Open it yourself: ${url}`,
    );
  }

  const [command, args] = opener(url);
  try {
    await execFileAsync(command, args, { timeout: 15_000 });
  } catch (error) {
    throw new OpenError(
      "opener_failed",
      `${command} could not open the Workbench: ${String(error.message).trim().split("\n")[0]}`,
      `Open it yourself: ${url}`,
    );
  }
}

// Find the instance, read its real Workbench URL, prove the Workbench answers,
// then open it. Each step fails with the component, the cause and one repair.
export async function openWorkbench({
  stateDir,
  platform = process.platform,
  launch = (url) => defaultLaunch(url, platform),
  fetchImpl = fetch,
  inspect = inspectHostInstance,
  bindings = hostBindings,
  timeoutMs = 10_000,
} = {}) {
  const instance = await inspect(stateDir);
  if (!instance) {
    throw new OpenError(
      "no_instance",
      "no instance is running, so there is no Workbench to open",
      "Start one: `worldfixture up`.",
    );
  }

  const url = bindings(stateDir)?.WORKBENCH_URL;
  if (!url) {
    throw new OpenError(
      "no_workbench",
      "this instance recorded no Workbench address",
      "The Workbench is optional. Everything it shows is also in `worldfixture status --verbose` and `worldfixture env`.",
    );
  }

  // Asked, not assumed. A recorded URL survives a Workbench that died inside a
  // container that is still running, and opening a browser at a dead port shows
  // the user a connection error with no explanation of whose it is.
  let response;
  try {
    response = await fetchImpl(`${url.replace(/\/$/, "")}/readyz`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new OpenError(
      "workbench_unreachable",
      `the Workbench at ${url} did not answer: ${String(error.message).trim().split("\n")[0]}`,
      "Check the instance: `worldfixture status`. If it is running, restart it with `worldfixture down` then `worldfixture up`.",
    );
  }

  if (!response.ok) {
    throw new OpenError(
      "workbench_unreachable",
      `the Workbench at ${url} answered ${response.status}`,
      "Check the instance: `worldfixture status`.",
    );
  }

  await launch(url);
  return { url, platform, tested: TESTED_PLATFORMS.includes(platform) };
}
