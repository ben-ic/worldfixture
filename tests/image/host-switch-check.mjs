import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { connectorWorld } from '../../runtime/src/connector.mjs';
import { hostBindings, hostInstance } from '../../runtime/src/host-launcher.mjs';
import { packsReference } from '../../runtime/src/packs-doc.mjs';
import { loadArtifact } from './coupling-artifacts.mjs';

const execute = promisify(execFile);
const [image, sourceA, sourceB, reportPath] = process.argv.slice(2);
assert.ok(image && sourceA && sourceB && reportPath, 'Usage: host-switch-check.mjs <image> <artifact-A> <artifact-B> <new-report-directory>');
const output = resolve(reportPath); mkdirSync(output, { recursive: true });
const root = mkdtempSync('/private/tmp/wf-host-switch-'), state = join(root, 'state');
const cliPath = resolve('runtime/bin/worldfixture.mjs');
const report = { status: 'running', image, state, checks: [], responses: [], scope: 'Normal host CLI, imported artifacts, domain credential rotation, application PostgreSQL preservation, reconnect gate, active connector docs/plan/seed payloads, run/env agreement, and return switch. Full provider coverage is separate.' };
const save = () => writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const check = (name, work) => { work(); report.checks.push({ check: name, status: 'passed' }); save(); };
const cli = args => execute(process.execPath, [cliPath, ...args, '--state', state, '--project-dir', root],
  { env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '0', WORLDFIXTURE_IMAGE: image }, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
let container, current, applicationToken;
const applicationRequests = [], applicationEvents = [];
const application = createServer(async (request, response) => {
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  try {
    if (request.url === '/.well-known/worldfixture') return send(200, {
      api_version: 'worldfixture.connector/v1', application: { id: 'host-switch-check', name: 'Host switch check' },
      capabilities: { plan: true, seed: true, event: true, status: true, reset: false }, accepts: [],
    });
    if (request.headers.authorization !== `Bearer ${applicationToken}`) return send(401, { error: 'Application token does not match' });
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : null;
    applicationRequests.push({ path: request.url, world: body?.world, body });
    if (request.url === '/__worldfixture/plan') return send(200, {
      api_version: 'worldfixture.connector-plan/v1', summary: 'Accept the selected world', mappings: [], counts: {}, warnings: [],
    });
    if (request.url === '/__worldfixture/seed') return send(200, {
      api_version: 'worldfixture.connector-receipt/v1', status: 'applied', idempotency_key: body.idempotency_key,
      summary: 'Recorded the complete seed request for comparison with connector documentation', counts: { requests: 1 }, references: [],
    });
    if (request.url === '/__worldfixture/status') return send(200, { api_version: 'worldfixture.connector-status/v1', state: 'empty', receipts: [] });
    if (request.url === '/__worldfixture/events') {
      applicationEvents.push(body);
      const quote = value => `'${String(value).replaceAll("'", "''")}'`;
      await sql(`INSERT INTO accepted_events(event_id) VALUES (${quote(body.event_id)})`);
      return send(200, { api_version: 'worldfixture.connector-receipt/v1', status: 'applied', event_id: body.event_id, counts: { events: 1 }, references: [] });
    }
    send(404, { error: 'Unknown application route' });
  } catch (error) { send(500, { error: error.message }); }
});
const sql = async statement => {
  const internal = JSON.parse(readFileSync(join(state, 'bindings.json')));
  return (await execute('docker', ['exec', '--env', 'PGPASSWORD', container, '/usr/lib/postgresql/15/bin/psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-h', internal.POSTGRES_HOST, '-p', String(internal.POSTGRES_PORT), '-U', internal.POSTGRES_USERNAME, '-d', internal.POSTGRES_DATABASE, '-c', statement],
  { env: { ...process.env, PGPASSWORD: internal.POSTGRES_PASSWORD }, timeout: 30000 })).stdout.trim();
};
const domain = async (path, { token = current.DOMAIN_TOKEN, method = 'GET', body } = {}) => {
  const response = await fetch(`${current.DOMAIN_BASE_URL}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json(); report.responses.push({ path, method, status: response.status, body: value }); save(); return { status: response.status, body: value };
};
const checkConnectorPayload = async (label, artifact, applicationUrl) => {
  const source = connectorWorld(artifact.path, { scale: 'full' });
  const reference = packsReference(source).trim();
  const docs = (await cli(['connector', 'docs', '--scale', 'full'])).stdout;
  const prompt = (await cli(['connector', 'prompt', applicationUrl, '--scale', 'full'])).stdout;
  const before = applicationRequests.length;
  await cli(['connector', 'plan', applicationUrl, '--scale', 'full', '--json']);
  await cli(['connector', 'seed', applicationUrl, '--scale', 'full', '--json']);
  const requests = applicationRequests.slice(before).filter(row => ['/__worldfixture/plan', '/__worldfixture/seed'].includes(row.path));
  check(`${label}.active-docs-match-real-plan-and-seed`, () => {
    assert.deepEqual(requests.map(row => row.path), ['/__worldfixture/plan', '/__worldfixture/seed']);
    assert.ok(docs.includes(reference), 'CLI documentation includes the current complete pack reference');
    assert.ok(prompt.includes(reference), 'CLI prompt includes the current complete pack reference');
    for (const { body } of requests) {
      assert.deepEqual(body.world, source.world);
      assert.deepEqual(body.packs, source.packs);
      assert.equal(packsReference({ world: body.world, packs: body.packs, scale: source.scale }).trim(), reference);
      for (const [pack, collections] of Object.entries(body.packs)) {
        for (const [name, rows] of Object.entries(collections)) {
          assert.ok(docs.includes(`\`${pack}.${name}\``), `${pack}.${name} is documented`);
          if (Array.isArray(rows) && rows.length === 0) assert.ok(reference.includes(`### \`${pack}.${name}\`\n\nDeclared empty array`), `${pack}.${name} remains explicitly empty`);
        }
      }
    }
  });
};
try {
  await new Promise(resolve => application.listen(0, '127.0.0.1', resolve));
  const applicationUrl = `http://host.docker.internal:${application.address().port}`;
  const { stdout } = await execute('docker', ['image', 'inspect', image, '--format', '{{.Id}}']); report.image_id = stdout.trim();
  const artifacts = [sourceA, sourceB].map((source, index) => {
    const sourceArtifact = loadArtifact(resolve(source)); assert.ok(sourceArtifact.checks.every(row => row.status === 'passed'));
    const target = join(output, `artifact-${index}`); cpSync(sourceArtifact.path, target, { recursive: true });
    const frozen = loadArtifact(target); assert.equal(frozen.identity.digest, sourceArtifact.identity.digest); return frozen;
  });
  report.artifacts = artifacts.map(row => row.identity);
  mkdirSync(join(root, '.worldfixture'), { recursive: true });
  writeFileSync(join(root, '.worldfixture/project.json'), JSON.stringify({ api_version: 'worldfixture.project/v1', application_url: 'http://localhost:3000', services: ['postgres'] }));
  save();
  const launch = await cli(['up', '--world-path', artifacts[0].path, '--only', 'domain', '--no-rebase', '--setup']);
  writeFileSync(join(output, 'launch.log'), launch.stdout + launch.stderr);
  container = hostInstance(state).container_id; report.container_id = container;
  current = hostBindings(state); const first = current, firstSession = JSON.parse((await cli(['switch', '--status'])).stdout);
  const initialEnv = JSON.parse((await cli(['env', '--json'])).stdout);
  check('initial-cli-env-includes-active-connection', () => { assert.equal(initialEnv.WORLDFIXTURE_TOKEN, first.WORLDFIXTURE_TOKEN); assert.equal(initialEnv.WORKBENCH_URL, first.WORKBENCH_URL); });
  check('normal-host-ready-and-generation', () => { assert.equal(firstSession.phase, 'ready'); assert.equal(firstSession.world.id, artifacts[0].world.id); assert.ok(current.POSTGRES_PASSWORD); });
  await sql("CREATE TABLE switch_notes (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO switch_notes VALUES (1, 'keep through world switch'); CREATE TABLE accepted_events(event_id text);");
  applicationToken = current.WORLDFIXTURE_TOKEN;
  await cli(['switch', '--connect', applicationUrl]);
  check('initial-connector-handshake-uses-active-artifact', () => assert.equal(applicationRequests.find(row => row.world)?.world.artifact_sha256, firstSession.world.artifact_sha256));
  await checkConnectorPayload('initial', artifacts[0], applicationUrl);
  const startedAt = await sql('SELECT pg_postmaster_start_time()');
  const baseline = await domain('/v1/collections/identity.people');
  check('initial-world-public-identity', () => { assert.equal(baseline.status, 200); assert.equal(baseline.body.world.id, artifacts[0].world.id); });
  const manual = await domain('/v1/collections/social.posts', { method: 'POST', body: { record: { id: 'post.host-switch-manual', author_id: artifacts[0].world.people[0].id, title: 'Manual record', body: 'Removed by switch.' }, actor_id: artifacts[0].world.people[0].id } });
  check('manual-provider-write', () => assert.equal(manual.status, 201));
  const switched = JSON.parse((await cli(['switch', artifacts[1].path, '--no-rebase', '--json'])).stdout);
  current = hostBindings(state);
  const switchedEnv = JSON.parse((await cli(['env', '--json'])).stdout);
  check('switched-cli-env-includes-new-connection', () => { assert.equal(switchedEnv.WORLDFIXTURE_TOKEN, current.WORLDFIXTURE_TOKEN); assert.notEqual(switchedEnv.WORLDFIXTURE_TOKEN, initialEnv.WORLDFIXTURE_TOKEN); assert.equal(switchedEnv.WORKBENCH_URL, current.WORKBENCH_URL); });
  const runOutput = await execute(process.execPath, [cliPath, 'run', '--state', state, '--project-dir', root, '--', process.execPath, '-e',
    'process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(name => [name, process.env[name]]))))', JSON.stringify(Object.keys(switchedEnv))],
  { env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '0', WORLDFIXTURE_IMAGE: image }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  check('switched-run-receives-the-same-current-values-as-env', () => {
    const values = JSON.parse(runOutput.stdout);
    assert.ok(Object.keys(switchedEnv).every(name => values[name] === switchedEnv[name]), 'Child values equal every current env export');
  });
  check('imported-host-artifact-and-stable-ports', () => {
    assert.equal(switched.world.id, artifacts[1].world.id); assert.notEqual(switched.generation, firstSession.generation);
    assert.equal(current.DOMAIN_BASE_URL, first.DOMAIN_BASE_URL); assert.equal(current.POSTGRES_URL, first.POSTGRES_URL);
    assert.equal(hostInstance(state).requested_world.id, artifacts[1].world.id);
    assert.equal(switched.reconnect_required, true);
  });
  const denied = await domain('/v1/collections/identity.people', { token: first.DOMAIN_TOKEN });
  const second = await domain('/v1/collections/identity.people');
  check('old-token-refused-new-world-readable', () => { assert.equal(denied.status, 401); assert.equal(second.status, 200); assert.equal(second.body.world.id, artifacts[1].world.id); });
  check('postgres-password-preserved', () => assert.equal(current.POSTGRES_PASSWORD, first.POSTGRES_PASSWORD));
  const rows = await sql('SELECT value FROM switch_notes WHERE id=1'), stillStarted = await sql('SELECT pg_postmaster_start_time()');
  check('postgres-process-and-row-preserved', () => { assert.equal(rows, 'keep through world switch'); assert.equal(stillStarted, startedAt); });
  await assert.rejects(cli(['clock', 'start', '0s']), error => /mapping/.test(error.stdout));
  check('delivery-blocked-before-reconnect', () => {});
  await assert.rejects(cli(['switch', '--without-application']), error => /requires an application connector/.test(error.stdout));
  check('required-connector-cannot-be-omitted', () => {});
  const pending = JSON.parse((await cli(['clock', '--json'])).stdout);
  check('new-timeline-still-unapplied', () => { assert.equal(pending.mode, 'setup'); assert.equal(pending.clock.elapsed_ms, 0); assert.equal(pending.timeline.delivered, 0); });
  const requestsBeforeConfirmation = applicationRequests.length;
  await assert.rejects(cli(['switch', '--connect', applicationUrl]), error => /not ready/.test(error.stdout));
  check('old-application-token-cannot-confirm-new-world', () => { assert.equal(applicationRequests.length, requestsBeforeConfirmation); assert.equal(applicationEvents.length, 0); });
  applicationToken = current.WORLDFIXTURE_TOKEN;
  await cli(['switch', '--connect', applicationUrl]);
  check('new-connector-handshake-uses-new-artifact', () => assert.equal(applicationRequests.findLast(row => row.world)?.world.artifact_sha256, switched.world.artifact_sha256));
  await checkConnectorPayload('switched', artifacts[1], applicationUrl);
  await cli(['clock', 'start', '0s']); await cli(['clock', 'pause']); await cli(['clock', 'advance', '3s']);
  const accepted = await sql('SELECT count(*) FROM accepted_events');
  check('confirmed-new-world-delivers-one-application-event', () => { assert.equal(accepted, '1'); assert.equal(applicationEvents.length, 1); assert.equal(applicationEvents[0].event_id, `wf:${encodeURIComponent(artifacts[1].world.id)}:${encodeURIComponent(artifacts[1].world.version)}:arrival.application`); });
  const returned = JSON.parse((await cli(['switch', artifacts[0].path, '--no-rebase', '--json'])).stdout);
  current = hostBindings(state);
  const restored = await domain('/v1/collections/social.posts');
  check('return-removes-provider-write-and-creates-generation', () => { assert.equal(returned.world.id, artifacts[0].world.id); assert.notEqual(returned.generation, firstSession.generation); assert.equal(restored.body.data.length, 0); });
  const remaining = await sql('SELECT value FROM switch_notes WHERE id=1'), finalStarted = await sql('SELECT pg_postmaster_start_time()');
  check('postgres-survives-return-switch', () => { assert.equal(remaining, rows); assert.equal(finalStarted, startedAt); });
  const retainedEvents = await sql('SELECT count(*) FROM accepted_events');
  const requestCount = applicationRequests.length;
  await assert.rejects(cli(['clock', 'start', '0s']), error => /mapping/.test(error.stdout));
  check('return-keeps-application-data-and-requires-new-mapping', () => { assert.equal(retainedEvents, '1'); assert.equal(applicationRequests.length, requestCount); assert.equal(returned.reconnect_required, true); });
  applicationToken = current.WORLDFIXTURE_TOKEN;
  await checkConnectorPayload('returned', artifacts[0], applicationUrl);
  await cli(['switch', '--without-application']);
  const clock = JSON.parse((await cli(['clock', 'start', '0s', '--json'])).stdout);
  check('confirmed-current-generation-can-start', () => assert.equal(clock.mode, 'running'));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; if (error.stdout) report.cli_output = error.stdout;
  process.exitCode = 1;
} finally {
  report.application_requests = applicationRequests; report.application_events = applicationEvents;
  try { await cli(['down']); report.stopped = true; } catch (error) { report.cleanup_error = error.message; process.exitCode = 1; }
  await new Promise(resolve => application.close(resolve));
  save(); console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: join(output, 'report.json'), error: report.error }));
}
