// Run as root in the product image. Numeric UID 1001 models the non-root Linux
// host reading a Docker bind mount; macOS file sharing masks this ownership bug.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const bin = '/opt/worldfixture/runtime/bin/worldfixture.mjs';
const state = '/state';
const report = { checks: [], status: 'running' };
let runtime;
const check = (name, condition) => {
  assert.ok(condition, name);
  report.checks.push(name);
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const cli = async args => {
  try {
    return (await execute(process.execPath, [bin, ...args, '--state', state], {
      uid: 1001, gid: 1001, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    })).stdout;
  } catch (error) {
    // env prints credentials. Do not include buffered command output in a
    // failing assertion or a CI log, even when the child exits unsuccessfully.
    throw new Error(`Non-root CLI ${args.join(' ')} failed (${error.code ?? 'unknown'})`);
  }
};
async function start() {
  runtime = spawn(process.execPath, [bin, 'up', '--world', 'business.saas-company:v2',
    '--only', 'domain', '--state', state, '--no-rebase'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  runtime.stdout.on('data', bytes => { output += bytes; });
  runtime.stderr.resume();
  const deadline = Date.now() + 120_000;
  while (!output.includes('Stop with Ctrl-C')) {
    if (runtime.exitCode !== null) throw new Error(`Runtime startup exited (${runtime.exitCode})`);
    if (Date.now() >= deadline) throw new Error('Runtime startup timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function stop() {
  if (!runtime || runtime.exitCode !== null) return;
  const child = runtime;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime stop timed out')); }, 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGINT');
  });
  runtime = null;
}
async function readAsHost(stage, version) {
  const active = json(`${state}/active-generation.json`);
  const environment = JSON.parse(await cli(['env', '--json']));
  check(`${stage}: non-root env`, typeof environment.DOMAIN_TOKEN === 'string' && environment.DOMAIN_TOKEN.length > 0);
  check(`${stage}: selected world`, active.world.id === 'business.saas-company' && active.world.version === version);
  for (const args of [['status'], ['events'], ['clock', '--json'], ['switch', '--status']]) {
    await cli(args);
    check(`${stage}: non-root ${args[0]}`, true);
  }
  for (const path of [
    `${state}/bindings.json`, `${state}/environment.lock.json`, `${state}/active-generation.json`,
    `${active.stateDir}/credentials.json`, `${active.stateDir}/bindings.json`,
    '/project-private/generated-secrets.json', `${state}/control.sock`,
  ]) {
    const info = statSync(path);
    check(`${stage}: private owner ${path}`, info.uid === 1001 && info.gid === 1001 && (info.mode & 0o777) === 0o600);
  }
  // SQLite opens must also work for host commands. Check sidecar ownership while
  // the runtime has the database open, not just after shutdown removes them.
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${active.stateDir}/state.sqlite${suffix}`;
    if (existsSync(path)) {
      const info = statSync(path);
      check(`${stage}: SQLite owner ${suffix || 'database'}`, info.uid === 1001 && info.gid === 1001);
    }
  }
  const service = statSync(`${state}/service-owned/sentinel`);
  check(`${stage}: service ownership unchanged`, service.uid === 4321 && service.gid === 4321 && (service.mode & 0o777) === 0o600);
  return environment;
}
try {
  assert.equal(process.platform, 'linux', 'Run this check in the product image');
  assert.equal(process.getuid(), 0, 'The product writes as root; the CLI reader runs as UID 1001');
  process.env.WORLDFIXTURE_SINGLE_CONTAINER = '1';
  process.env.WORLDFIXTURE_GENERATED_SECRETS_PATH = '/project-private/generated-secrets.json';
  for (const directory of [state, '/project-private']) {
    mkdirSync(directory, { recursive: true }); chownSync(directory, 1001, 1001);
  }
  mkdirSync(`${state}/service-owned`, { mode: 0o700 });
  writeFileSync(`${state}/service-owned/sentinel`, 'service data', { mode: 0o600 });
  chownSync(`${state}/service-owned/sentinel`, 4321, 4321);
  chownSync(`${state}/service-owned`, 4321, 4321);
  await start();
  const original = await readAsHost('startup', 'v2');
  await cli(['reset']);
  await readAsHost('reset', 'v2');
  for (const version of ['v3', 'v2']) {
    await cli(['switch', `business.saas-company:${version}`, '--no-rebase']);
    const current = await readAsHost(`switch-${version}`, version);
    check(`switch-${version}: credentials rotated`, current.DOMAIN_TOKEN !== original.DOMAIN_TOKEN);
    await cli(['switch', '--without-application']);
    await cli(['clock', 'start', '0s']);
    await cli(['reset']);
    await readAsHost(`switch-${version}-reset`, version);
  }
  await stop();
  await start();
  await readAsHost('restart', 'v2');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  try { await stop(); }
  catch (error) { report.status = 'failed'; report.cleanup_error = error.message; process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
