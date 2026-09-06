// Run in the product image with /world, this script at /check.mjs, and
// --add-host connector.fixture:127.0.0.1. The application uses real PostgreSQL.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execute = promisify(execFile), stateDir = '/state';
const report = { checks: [], responses: [], application_requests: [] };
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({ check: name, status: 'passed' }); };
const waitFor = async (read, message, timeout = 30000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
};
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
let bindings, generation, child, exited, output = '', exitResult;
const sql = async statement => (await execute('/usr/lib/postgresql/15/bin/psql',
  ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', bindings.POSTGRES_HOST, '-p', String(bindings.POSTGRES_PORT),
    '-U', bindings.POSTGRES_USERNAME, '-d', bindings.POSTGRES_DATABASE, '-c', statement],
  { env: { ...process.env, PGPASSWORD: bindings.POSTGRES_PASSWORD }, timeout: 15000 })).stdout.trim();
const server = createServer(async (request, response) => {
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  try {
    if (request.url === '/.well-known/worldfixture') return json(200, {
      api_version: 'worldfixture.connector/v1', application: { id: 'repeat-check', name: 'Repeat Check' }, capabilities: { event: true },
    });
    if (request.url !== '/__worldfixture/events' || request.method !== 'POST') return json(404, { error: 'Unknown application route' });
    if (request.headers.authorization !== `Bearer ${bindings.WORLDFIXTURE_TOKEN}`) return json(401, { error: 'Incorrect application token' });
    let body = ''; for await (const chunk of request) body += chunk;
    const event = JSON.parse(body);
    report.application_requests.push(event);
    // No application-level deduplication: a repeated HTTP mutation would add a
    // second row and fail this test. The runtime receipt must prevent it.
    await sql(`INSERT INTO accepted_events(event_id,envelope) VALUES(${quote(event.event_id)},${quote(JSON.stringify(event))}::jsonb)`);
    return json(200, { api_version: 'worldfixture.connector-receipt/v1', status: 'applied', event_id: event.event_id, counts: { events: 1 }, references: [] });
  } catch (error) { json(500, { error: error.message }); }
});
const clock = async input => {
  assert.ok(generation, 'The repeat check must pin the managed session before clock requests');
  const response = await fetch(`${bindings.WORKBENCH_URL}/api/clock`, { headers: { 'content-type': 'application/json', 'X-WorldFixture-Generation': generation }, ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
  const value = await response.json();
  report.responses.push({ path: '/api/clock', status: response.status, body: value });
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(response.headers.get('X-WorldFixture-Generation'), generation, 'Reset or repeat must retain the session generation'); return value;
};
const cli = async args => {
  const result = await execute(process.execPath, ['runtime/bin/worldfixture.mjs', ...args, '--state', stateDir], { timeout: 120000 });
  return result.stdout;
};
const domain = async (path, input) => {
  const response = await fetch(bindings.DOMAIN_BASE_URL + path, { headers: { authorization: `Bearer ${bindings.DOMAIN_TOKEN}`, 'content-type': 'application/json' },
    ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
  const body = await response.json(); report.responses.push({ path, status: response.status, body });
  assert.ok(response.ok, JSON.stringify(body)); return body;
};
try {
  await new Promise(resolve => server.listen(19321, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['runtime/bin/worldfixture.mjs', 'up', '--world-path', '/world', '--state', stateDir,
    '--service-root', '/opt/worldfixture/emulators', '--only', 'domain', '--no-rebase', '--setup', '--application-url', 'http://connector.fixture:19321'], {
    env: { ...process.env, WORLDFIXTURE_PROJECT_CONFIG: JSON.stringify({ api_version: 'worldfixture.project/v1', application_url: 'http://connector.fixture:19321', services: ['postgres'] }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  exited = new Promise(resolve => child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); }));
  await waitFor(() => { if (exitResult) throw new Error(`CLI exited during startup: ${output}`); return existsSync(`${stateDir}/bindings.json`); }, 'CLI did not publish ready bindings', 120000);
  bindings = JSON.parse(readFileSync(`${stateDir}/bindings.json`));
  const sessionResponse = await fetch(`${bindings.WORKBENCH_URL}/api/session`), session = await sessionResponse.json();
  assert.ok(sessionResponse.ok && session.managed === true && session.phase === 'ready' && typeof session.generation === 'string' && session.generation.length, 'Normal CLI managed session is required');
  generation = session.generation; report.responses.push({ path: '/api/session', status: sessionResponse.status, body: session });
  const setup = await clock();
  check('setup.before-delivery', setup.mode === 'setup' && setup.clock.elapsed_ms === 0 && (await domain('/v1/collections/social.posts')).total_count === 0);
  await sql('CREATE TABLE application_notes(id text PRIMARY KEY, body text); CREATE TABLE accepted_events(event_id text, envelope jsonb); INSERT INTO application_notes VALUES (\'manual-app-row\',\'Keep this application data\')');
  const databaseStarted = await sql('SELECT pg_postmaster_start_time()');
  await domain('/v1/collections/social.posts', { actor_id: 'person.one', record: { id: 'post.manual', author_id: 'person.one', title: 'Manual provider change', body: 'Removed on repeat.' } });
  await clock({ action: 'start', duration: '0s', enabled: true });
  await cli(['clock', 'pause']);
  const first = JSON.parse(await cli(['clock', 'advance', '3s', '--json']));
  check('first-pass.outcomes', first.timeline.delivered === 2 && first.timeline.skipped === 1 && first.timeline.failed === 0);
  check('first-pass.paused', first.clock.running === false);
  check('first-pass.application-once', report.application_requests.length === 1 && await sql('SELECT count(*) FROM accepted_events') === '1');
  check('connector.identity-and-time', report.application_requests[0].event_id === 'wf:test.clock-repeat:v1:arrival.application'
    && report.application_requests[0].occurred_at === '2031-01-01T00:00:02.000Z');
  await cli(['clock', 'resume']);
  await waitFor(async () => (await clock()).repeat.cycle >= 2, 'Repeat did not restore a second cycle');
  const secondStart = JSON.parse(await cli(['clock', 'pause', '--json']));
  check('repeat.new-cycle', secondStart.repeat.cycle === 2);
  const baseline = await domain('/v1/collections/social.posts');
  check('repeat.removes-manual-provider-record', !baseline.data.some(row => row.id === 'post.manual'));
  check('repeat.preserves-application-data', await sql('SELECT body FROM application_notes WHERE id=\'manual-app-row\'') === 'Keep this application data');
  check('repeat.preserves-database-process', await sql('SELECT pg_postmaster_start_time()') === databaseStarted);
  const second = JSON.parse(await cli(['clock', 'advance', '3s', '--json']));
  check('second-pass.outcomes', second.timeline.delivered === 2 && second.timeline.skipped === 1 && second.timeline.failed === 0);
  check('second-pass.domain-replayed', (await domain('/v1/collections/social.posts')).data.some(row => row.id === 'post.scheduled'));
  check('second-pass.application-not-replayed', report.application_requests.length === 1 && await sql('SELECT count(*) FROM accepted_events') === '1');
  await clock({ action: 'repeat', enabled: false });
  await cli(['reset']);
  check('normal-reset.domain-baseline', (await domain('/v1/collections/social.posts')).total_count === 0);
  check('normal-reset.application-data-and-receipt', await sql('SELECT count(*) FROM application_notes') === '1' && await sql('SELECT count(*) FROM accepted_events') === '1');
  check('normal-reset.database-process', await sql('SELECT pg_postmaster_start_time()') === databaseStarted);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; report.output = output; process.exitCode = 1; }
finally {
  if (child && !exitResult) { child.kill('SIGINT'); await exited; }
  await new Promise(resolve => server.close(resolve));
  report.cli_exit = exitResult;
  console.log(JSON.stringify(report));
}
