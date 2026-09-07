import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, prepareContainerArgs } from './cli.mjs';
import { readEnvironmentFile, verifyEnvironmentRequest } from './environment-file.mjs';
import { defaultEnvironment } from './environments.mjs';
import { loadManifests } from './manifests.mjs';
import { resolveEnvironment } from './resolve.mjs';
import { prepareSwitchWorld } from './switch-world.mjs';

const ROOT = join(import.meta.dirname, '../..');
const BIN = join(ROOT, 'runtime/bin/worldfixture.mjs');
const SAMPLE = join(ROOT, 'examples/environments/node-red.json');
const WORLD = join(ROOT, 'dist/business.saas-company.v3');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), 'worldfixture-cli-environment-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
function cli(args, cwd) {
  return execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 15000,
    env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '0' } });
}

test('environment input validates the existing schema and rejects conflicting or repeated flags', t => {
  const root = scratch(t), file = join(root, 'environment.json');
  const valid = readEnvironmentFile(SAMPLE);
  for (const input of [null, {}, { ...valid, requires: [] }, { ...valid, requires: 'notion' },
    { ...valid, requires: ['notion'] }, { ...valid, bindings: { NOTION_TOKEN: 'literal-secret' } },
    { ...valid, target: { kind: 'http', command: ['node', 'app.mjs'] } }]) {
    writeFileSync(file, JSON.stringify(input));
    assert.throws(() => readEnvironmentFile(file), /invalid|not valid|providers only/i);
  }
  writeFileSync(file, '{'); assert.throws(() => readEnvironmentFile(file), /Cannot load environment/);
  assert.throws(() => readEnvironmentFile(join(root, 'missing.json')), /Cannot load environment/);
  assert.throws(() => parse(['--environment', SAMPLE, '--environment', SAMPLE]), /more than once/);
  assert.throws(() => parse(['--environment']), /needs a value/);
  for (const args of [
    ['--environment', SAMPLE, '--only', 'github'],
    ['--environment', file],
    ['--environment', SAMPLE, '--world', 'consumer.retail-brand:v1'],
  ]) {
    assert.throws(() => cli(['up', '--state', join(root, 'state'), ...args], root));
    assert.equal(existsSync(join(root, '.worldfixture')), false);
    assert.equal(existsSync(join(root, 'state')), false);
  }
  for (const bad of [
    { ...valid, requires: ['unknown.profile.v1'], bindings: {} },
    { ...valid, bindings: { BAD: 'github.repositories.v1/unknown' } },
    { ...valid, target: { kind: 'none', identity: 'unknown-person' } },
  ]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => cli(['up', '--environment', file], root));
    assert.equal(existsSync(join(root, '.worldfixture')), false);
  }
});

test('container staging freezes the parsed request and forwards its container path', t => {
  const root = scratch(t), file = join(root, 'input.json'), state = join(root, 'state');
  const spec = readEnvironmentFile(SAMPLE);
  writeFileSync(file, JSON.stringify(spec));
  writeFileSync(file, '{}'); // The accepted in-memory request must be used.
  const args = prepareContainerArgs(WORLD, state, { environment: file, setup: true }, undefined, spec);
  assert.deepEqual(args, ['--world-path', '/state/input-world', '--environment', '/state/environment-request.json', '--setup']);
  assert.deepEqual(json(join(state, 'environment-request.json')), spec);
  assert.doesNotThrow(() => verifyEnvironmentRequest(state, spec));
  assert.throws(() => verifyEnvironmentRequest(state, { ...spec, requires: ['slack.messaging.v1'] }), /different environment/);
  prepareContainerArgs(WORLD, state);
  assert.equal(existsSync(join(state, 'environment-request.json')), false);
  assert.throws(() => verifyEnvironmentRequest(state, spec), /different environment/);
});

test('explicit capabilities retain their bindings and required dependencies without default providers', t => {
  const environmentSpec = readEnvironmentFile(SAMPLE);
  const spec = defaultEnvironment('business.saas-company:v3', { environmentSpec, identity: 'maya-chen', includeProviders: true, includeS3: true, includePostgres: true });
  assert.deepEqual(spec.requires, environmentSpec.requires);
  assert.deepEqual(spec.bindings, environmentSpec.bindings);
  assert.equal(spec.execution.mode, 'selected-capabilities');
  assert.equal(spec.target.identity, 'maya-chen');
  assert.equal(environmentSpec.target, undefined);
  const upload = defaultEnvironment('business.saas-company:v3', {
    identity: 'maya-chen', environmentSpec: { ...environmentSpec, requires: ['notion.file-uploads.v1'], bindings: {} },
  });
  const uploadLock = resolveEnvironment(upload, { manifests: loadManifests(join(ROOT, 'emulators')), artifactPath: WORLD });
  assert.deepEqual(Object.keys(uploadLock.capabilities).sort(), ['aws.s3.objects.v1', 'notion.file-uploads.v1']);
  const root = scratch(t);
  const switched = prepareSwitchWorld({ selector: 'business.saas-company:v2', noRebase: true }, {
    generation: 'environment-switch', stateDir: root, environmentOptions: { environmentSpec },
  });
  assert.deepEqual(Object.keys(switched.lock.capabilities).sort(), [...environmentSpec.requires].sort());
  assert.equal(switched.lock.world.version, 'v2');
  assert.deepEqual(Object.keys(switched.lock.bindings).sort(), Object.keys(environmentSpec.bindings).sort());
});

test('the real CLI starts exactly three providers on loopback, exports ready bindings, and stops their process', { timeout: 60000 }, async t => {
  const root = scratch(t), state = join(root, 'state');
  const child = spawn(process.execPath, [BIN, 'up', '--direct', '--environment', SAMPLE, '--state', state, '--no-rebase', '--setup', '--no-sample-app'], {
    cwd: root, env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '0',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${new URL('../../tests/helpers/loopback-only.mjs', import.meta.url).href}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stopped = false;
  const stop = async () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) }); child.kill('SIGTERM'); await exited; stopped = true;
  };
  t.after(stop);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`CLI readiness timed out: ${output}`)), 40000);
    const finish = fn => { clearTimeout(timeout); fn(); };
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('Stop with Ctrl-C')) finish(resolve); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => finish(() => reject(error)));
    child.once('exit', code => finish(() => reject(new Error(`CLI exited ${code}: ${output}`))));
  });
  assert.match(output, /Selected world: business.saas-company:v3 \(environment\)/);
  const lock = json(join(state, 'environment.lock.json'));
  assert.deepEqual(Object.keys(lock.capabilities).sort(), [...readEnvironmentFile(SAMPLE).requires].sort());
  assert.deepEqual(lock.services.find(row => row.name === 'emulate').ports.map(row => row.name).sort(), ['github', 'notion', 'slack']);
  const bindings = JSON.parse(cli(['env', '--state', state, '--json'], root));
  for (const name of ['GITHUB', 'SLACK', 'NOTION']) assert.ok(bindings[`${name}_TOKEN`] && bindings[`${name}_BASE_URL`]);
  for (const name of ['GOOGLE', 'STRIPE', 'S3']) assert.equal(bindings[`${name}_BASE_URL`], undefined);
  assert.equal(cli(['run', '--state', state, '--', process.execPath, '-e',
    'console.log(["GITHUB", "SLACK", "NOTION"].every(name => process.env[name + "_TOKEN"] && process.env[name + "_BASE_URL"]))'], root).trim(), 'true');
  const headers = { authorization: `Bearer ${bindings.NOTION_TOKEN}`, 'Notion-Version': '2026-03-11', 'content-type': 'application/json' };
  const response = await fetch(`${bindings.NOTION_BASE_URL}/v1/search`, { method: 'POST', headers,
    body: JSON.stringify({ filter: { property: 'object', value: 'page' }, page_size: 100 }) });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).results.length > 0);
  const processes = execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().split(/\s+/)).filter(row => Number(row[1]) === child.pid && row.slice(2).join(' ').includes('src/main.mjs')).map(row => Number(row[0]));
  assert.equal(processes.length, 1);
  await stop();
  for (const pid of processes) assert.throws(() => process.kill(pid, 0), /ESRCH/);
  for (const name of ['GITHUB', 'SLACK', 'NOTION']) await assert.rejects(fetch(bindings[`${name}_BASE_URL`], { signal: AbortSignal.timeout(1000) }));
  assert.equal(existsSync(join(state, 'bindings.json')), false);
});
