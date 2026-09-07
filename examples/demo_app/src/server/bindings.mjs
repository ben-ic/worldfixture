import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export async function loadEnvironment(input = process.env) {
  if (input.WORLDFIXTURE_WORLD_ID && input.WORLDFIXTURE_TOKEN) return { ...input };
  // Use only the installed CLI. Never read the WorldFixture run directory.
  try {
    const { stdout } = await exec('npx', ['--no-install', 'worldfixture', 'env', '--json'], { env: input, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
    const bindings = JSON.parse(stdout);
    const values = Object.fromEntries(Object.entries(bindings).filter(([, value]) => typeof value === 'string'));
    return { ...input, ...values };
  } catch {
    // The UI explains missing connections. A process launched with `run` can
    // already have all bindings even when metadata discovery is unavailable.
    return { ...input };
  }
}
