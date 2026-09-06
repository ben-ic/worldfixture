// Real package installation and public CLI flow outside this checkout.
// Leaves only its own test world and app running for browser review.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';

const exec = promisify(execFile);
const source = resolve(import.meta.dirname, '..');
const sourceFiles = ['package.json', 'package-lock.json', 'src', 'tests', 'scripts', 'README.md', 'COVERAGE.md', 'DATABASE_TESTS.md', 'FIRST_RUN_TESTS.md', 'IMPLEMENTATION_PLAN.md', 'index.html', 'vite.config.mjs'];
const env = { ...process.env, ACCOUNT_DESK_PORT: '0' };
for (const key of Object.keys(env)) if (/^(?:WORLDFIXTURE_|POSTGRES_|MYSQL_|ACCOUNT_DESK_DATABASE|ACCOUNT_DESK_STORAGE_)/.test(key)) delete env[key];
async function command(cwd, program, args, extra = {}) {
  try { return await exec(program, args, { cwd, env: { ...env, ...extra }, timeout: 300000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { throw new Error(`${program} ${args.slice(0, 2).join(' ')} failed (${error.code || 'unknown exit'}). Raw command output is not printed because it can contain bindings.`); }
}
async function copySource(directory) {
  for (const file of sourceFiles) await cp(join(source, file), join(directory, file), { recursive: true });
}
if (process.argv[2] === '--refresh') {
  const directory = await realpath(resolve(process.argv[3] || ''));
  const marker = JSON.parse(await readFile(join(directory, 'first-run-report.json'), 'utf8'));
  assert.equal(marker.kind, 'account-desk-first-run/v1');
  assert.equal(await realpath(marker.project), directory);
  assert.ok(directory.startsWith(await realpath(tmpdir()) + '/account-desk-first-run-'));
  await copySource(directory);
  await command(directory, 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']);
  await command(directory, 'npm', ['run', 'build']);
  console.log(`Updated and rebuilt this owned test app: ${directory}`);
  console.log(`Browser URL: ${marker.origin || 'Not started'}`);
  console.log('Static UI updates are ready. If server code changed, restart only the recorded test app process. The test world was not reset.');
  process.exit(0);
}
const replaceWorld = process.argv[2] === '--replace-world';
const restart = process.argv[2] === '--restart' || replaceWorld;
if (replaceWorld && !process.env.ACCOUNT_DESK_TEST_IMAGE) throw new Error('--replace-world requires ACCOUNT_DESK_TEST_IMAGE and explicit approval to discard this test world.');
if (process.argv.length > 2 && !restart) throw new Error('Use no arguments for a fresh test, --refresh, --restart, or --replace-world <owned test project>.');
const resumedDirectory = restart ? await realpath(resolve(process.argv[3] || '')) : null;
const previous = restart ? JSON.parse(await readFile(join(resumedDirectory, 'first-run-report.json'), 'utf8')) : null;
if (restart) {
  assert.equal(previous.kind, 'account-desk-first-run/v1');
  assert.equal(await realpath(previous.project), resumedDirectory);
  assert.ok(resumedDirectory.startsWith(await realpath(tmpdir()) + '/account-desk-first-run-'));
  // Retain the address already opened by the user during final browser QA.
  if (previous.origin) env.ACCOUNT_DESK_PORT = new URL(previous.origin).port;
}
const image = (replaceWorld ? process.env.ACCOUNT_DESK_TEST_IMAGE : previous?.image) || process.env.ACCOUNT_DESK_TEST_IMAGE || 'worldfixture:account-desk';
const { stdout: inspectedImage } = await command(source, 'docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
const imageId = inspectedImage.trim();
assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
const directory = resumedDirectory || await mkdtemp(join(tmpdir(), 'account-desk-first-run-'));
const reportPath = join(directory, 'first-run-report.json');
const report = previous || { kind: 'account-desk-first-run/v1', project: directory, startedAt: new Date().toISOString(), image: imageId, node: process.version, checks: [], status: 'running', retainedForBrowserReview: true };
if (restart) { report.restartedAt = new Date().toISOString(); report.status = 'running'; delete report.error; }
if (replaceWorld) {
  await writeFile(join(directory, `before-world-replacement-${Date.now()}.json`), `${JSON.stringify(previous, null, 2)}\n`, { mode: 0o600 });
  report.previousImage = report.image;
  report.image = imageId;
  report.worldReplacedAt = new Date().toISOString();
  report.checks = [];
}
const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await save();
console.log(`First-run project: ${directory}`);
console.log(`Exact local image: ${imageId}`);
const cli = (args, extra) => command(directory, 'npx', ['--no-install', 'worldfixture', ...args], extra);
try {
  if (restart) {
    assert.ok(Number.isInteger(report.launcherPid) && report.launcherPid > 1);
    const { stdout: cwd } = await command(directory, 'lsof', ['-a', '-p', String(report.launcherPid), '-d', 'cwd', '-Fn']);
    const processDirectory = cwd.split('\n').find(line => line.startsWith('n'))?.slice(1);
    assert.equal(await realpath(processDirectory), await realpath(directory), 'Only the recorded app in its owned test project may be restarted.');
    const { stdout: processInfo } = await command(directory, 'ps', ['-p', String(report.launcherPid), '-o', 'pgid=,command=']);
    assert.ok(new RegExp(`^\\s*${report.launcherPid}\\s+.*worldfixture`).test(processInfo), 'The recorded PID must still lead the expected npx WorldFixture process group.');
    process.kill(-report.launcherPid, 'SIGTERM');
    await pause(1500);
    console.log('Stopped only the verified test app process group. The world remains running.');
  }
  await copySource(directory);
  await mkdir(join(directory, '.worldfixture'), { recursive: true });
  if (!restart) await writeFile(join(directory, '.worldfixture/project.json'), `${JSON.stringify({ api_version: 'worldfixture.project/v1', services: ['postgres'], application_url: 'http://127.0.0.1:15175' }, null, 2)}\n`);
  console.log('Install a separate dependency tree with npm ci.');
  try { await command(directory, 'npm', ['ci', '--offline', '--no-audit', '--no-fund']); report.install = 'npm ci --offline (new dependency tree; cached package archives)'; }
  catch { await command(directory, 'npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']); report.install = 'npm ci --prefer-offline (new dependency tree)'; }
  const installed = JSON.parse(await readFile(join(directory, 'node_modules/worldfixture/package.json'), 'utf8'));
  report.cliVersion = installed.version;
  assert.equal(installed.name, 'worldfixture');
  assert.ok(!(await realpath(join(directory, 'node_modules'))).startsWith(source), 'Dependencies must not link back to the checkout.');
  report.checks.push('Clean app dependency installation outside checkout');
  await command(directory, 'npm', ['run', 'build']);
  report.checks.push('Production Vite build');
  await save();
  if (replaceWorld) {
    console.log('Replace only this approved test world. Later provider changes will be removed.');
    await cli(['down']);
  }
  if (!restart || replaceWorld) {
    console.log('Start this isolated world with the installed npx flow.');
    await cli(['up', '--image', imageId]);
  }
  report.worldStarted = true;
  const logPath = join(directory, `app-process-${Date.now()}.log`);
  report.appLog = logPath;
  const log = openSync(logPath, 'a', 0o600);
  const child = spawn('npx', ['--no-install', 'worldfixture', 'run', '--', 'npm', 'run', 'start'], { cwd: directory, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  report.launcherPid = child.pid;
  report.processGroup = child.pid;
  report.appCommand = `ACCOUNT_DESK_PORT=${env.ACCOUNT_DESK_PORT} npx --no-install worldfixture run -- npm run start`;
  delete report.origin;
  await save();
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const logText = await readFile(logPath, 'utf8');
    const match = /^Account Desk: (http:\/\/127\.0\.0\.1:\d+)$/m.exec(logText);
    if (match) { report.origin = match[1]; break; }
    await pause(500);
  }
  assert.ok(report.origin, 'The installed app must print its dynamic local address. Inspect only its private app-process.log.');
  console.log(`App URL: ${report.origin}`);
  console.log(`Detached npx process group: ${report.processGroup}`);
  await writeFile(join(directory, '.worldfixture/project.json'), `${JSON.stringify({ api_version: 'worldfixture.project/v1', services: ['postgres'], application_url: report.origin }, null, 2)}\n`);
  async function request(path, input, acceptFailure = false) {
    const response = await fetch(report.origin + path, { ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), signal: AbortSignal.timeout(180000) });
    const body = await response.json();
    if (!acceptFailure) assert.ok(response.ok, `${path} returned HTTP ${response.status}: ${typeof body.error === 'string' ? body.error : 'Request failed'}`);
    return { response, body };
  }
  let state;
  const loading = Date.now();
  while (Date.now() - loading < 240000) {
    state = (await request('/api/state')).body;
    if (state.services?.length && state.services.every(service => !service.selected || !['loading', 'starting'].includes(service.state))) break;
    await pause(1000);
  }
  assert.ok(state?.world?.id && state.world.id !== 'unbound');
  assert.equal(state.storage.kind, 'postgres');
  report.world = state.world;
  report.services = state.services.map(({ id, name, selected, state, error }) => ({ id, name, selected, state, ...(error ? { error } : {}) }));
  await save();
  assert.ok(report.services.every(service => !service.selected || service.state === 'ready'), `Service readiness failures: ${report.services.filter(service => service.selected && service.state !== 'ready').map(service => service.id).join(', ')}`);
  const html = await (await fetch(report.origin)).text();
  assert.match(html, /<div id="root"><\/div>/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)].map(match => match[1]);
  assert.ok(assets.length >= 2, 'Built HTML must reference JavaScript and CSS assets.');
  for (const asset of assets) assert.equal((await fetch(report.origin + asset)).status, 200);
  report.checks.push('Actual production server on dynamic port; built UI assets; all selected service reads ready');
  async function waitRun(id) {
    const start = Date.now();
    while (Date.now() - start < 600000) {
      const run = (await request(`/api/runs/${encodeURIComponent(id)}`)).body;
      if (run.status !== 'running') return run;
      await pause(750);
    }
    throw new Error('Verification run exceeded ten minutes. Inspect the retained local test app.');
  }
  console.log('Run read verification through the app API.');
  const readRun = await waitRun((await request('/api/verify', {})).body.id);
  await writeFile(join(directory, 'read-verification.json'), `${JSON.stringify(readRun, null, 2)}\n`, { mode: 0o600 });
  report.readRun = { id: readRun.id, status: readRun.status, summary: readRun.summary };
  await save();
  assert.equal(readRun.status, 'passed', `Read checks failed: ${readRun.results.filter(item => item.status === 'failed').map(item => item.service).join(', ')}`);
  console.log('Preview exact local writes, prove approval is required, then approve this isolated test plan.');
  const beforePlan = (await request('/api/state')).body;
  const plan = (await request('/api/verify/plan', {})).body;
  assert.ok(plan.id && plan.steps?.length);
  await writeFile(join(directory, 'write-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  const afterPlan = (await request('/api/state')).body;
  assert.equal(afterPlan.receipts.length, beforePlan.receipts.length, 'A plan must not create an app write receipt.');
  const refused = await request('/api/verify', { planId: plan.id }, true);
  assert.ok(refused.response.status >= 400, 'Write verification must require explicit approval.');
  const writes = await waitRun((await request('/api/verify', { planId: plan.id, approved: true })).body.id);
  await writeFile(join(directory, 'write-verification.json'), `${JSON.stringify(writes, null, 2)}\n`, { mode: 0o600 });
  report.writeRun = { id: writes.id, status: writes.status, summary: writes.summary, unready: plan.steps.filter(step => !step.ready).map(({ action, reason }) => ({ action, reason })) };
  await save();
  const expected = plan.steps.filter(step => step.ready);
  assert.ok(expected.length);
  for (const step of expected) assert.equal(writes.results.find(result => result.action === step.action)?.status, 'passed', `Ready write/readback failed: ${step.action}`);
  assert.equal(writes.status, 'passed', 'Every planned write must pass. Inspect write-plan.json for missing prerequisites and write-verification.json for failures.');
  const duplicate = (await request('/api/verify', { planId: plan.id, approved: true })).body;
  assert.equal(duplicate.id, writes.id, 'Repeated approval must return the same write run.');
  assert.ok(isDeepStrictEqual(duplicate.results, writes.results), 'Repeated approval must return the current saved results, not the initial running snapshot.');
  report.checks.push('Read verification; write preview; refused missing approval; every ready write/readback; repeated approval identity');
  // UI download serializes this same persisted run object. Save and parse it as
  // JSON evidence; a later browser test must still click the download control.
  assert.ok(isDeepStrictEqual(JSON.parse(await readFile(join(directory, 'write-verification.json'), 'utf8')), (await request(`/api/runs/${encodeURIComponent(writes.id)}`)).body), 'Saved JSON export must match the persisted run API response.');
  report.checks.push('Persisted JSON evidence round-trip matches API run export');
  console.log('Run customer workflow, draft, repeat-approval, and connector seed tests.');
  const appTest = await cli(['run', '--', 'node', 'tests/app-live.mjs'], { ACCOUNT_DESK_URL: report.origin, ACCOUNT_DESK_ALLOW_TEST_WRITES: '1' });
  const lines = appTest.stdout.trim().split('\n');
  report.applicationTest = JSON.parse(lines.at(-1));
  report.checks.push('Four-service customer workflow; draft persistence; no repeated write; connector plan and approved seed');
  const conformance = JSON.parse((await cli(['connector', 'check', report.origin, '--scale', 'smoke', '--json'])).stdout);
  assert.equal(conformance.ready, true);
  report.connector = { ready: true, checks: conformance.checks.map(({ name, ok }) => ({ name, ok })) };
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await save();
  console.log(`First-run checks passed. App remains running at ${report.origin}`);
} catch (error) {
  report.status = 'failed'; report.error = error.message.split('\n')[0].slice(0, 500); report.completedAt = new Date().toISOString();
  await save();
  console.error(`First-run check failed: ${report.error}`);
  process.exitCode = 1;
} finally {
  console.log(`Evidence: ${reportPath}`);
  if (report.origin) console.log(`Browser review URL: ${report.origin}`);
  if (report.launcherPid) console.log(`Owned app launcher PID/process group: ${report.launcherPid}`);
  console.log(`Stop only this test world later: cd '${directory}' && npx --no-install worldfixture down`);
}
