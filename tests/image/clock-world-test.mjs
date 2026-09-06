// Product-image proof for authored clock arcs. Every mutation goes through the
// product CLI/control API; provider evidence comes from Slack and IMAP reads.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { credential } from '../../runtime/src/credentials.mjs';
import { loadArtifact } from './coupling-artifacts.mjs';
import { readImapMailbox } from './coupling-mail-probes.mjs';
import { containerArguments, credentialValues, docker, mappedBindings, readRunBindings, readRunCredentialSet, redact, removeOwnedContainer, waitForReady } from './coupling-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const saveJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const bodyText = value => String(value ?? '').replaceAll('\r\n', '\n').replace(/\n+$/, '');
export const CLOCK_CASES = [
  { name: 'starter', count: 1, end: 30, setup: true, start: 0 },
  { name: 'alien-short', variant: 'short', count: 4, end: 30, setup: true, start: 10 },
  { name: 'alien-long', variant: 'long', count: 2000, end: 604800, setup: false, start: 302 },
];
export function selectClockCases(names) {
  if (names === undefined) return CLOCK_CASES;
  assert.ok(names.length && new Set(names).size === names.length, 'Case names must be nonempty and unique');
  for (const name of names) assert.ok(CLOCK_CASES.some(row => row.name === name), `Unknown clock case: ${name}`);
  return CLOCK_CASES.filter(row => names.includes(row.name));
}
function inventory(directory) {
  const result = {};
  const visit = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) { const data = readFileSync(path); result[path.slice(directory.length + 1)] = { sha256: sha(data), size: data.length }; }
  } };
  visit(directory); return result;
}
export async function prepareClockCase({ definition, outputPath, python = process.env.PYTHON ?? 'python3', seed = 'coupling-p5-2026-09-06', signal }) {
  const output = resolve(outputPath); assert.ok(!existsSync(output), `Clock evidence already exists: ${output}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const source = join(output, 'source'), entry = join(source, 'world.json');
  if (definition.variant) {
    mkdirSync(source);
    await execute(python, [join(ROOT, 'tests/fixtures/alien-world.py'), '--seed', seed, '--variant', definition.variant, '--output', entry], { signal });
  } else cpSync(join(ROOT, 'examples/minimal-world'), source, { recursive: true });
  const artifactPath = join(output, 'artifact');
  await execute(python, ['-m', 'worldfixture_compiler', 'build', entry, '--output', artifactPath], {
    cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'compiler') }, maxBuffer: 8 * 1024 * 1024, signal });
  const artifact = loadArtifact(artifactPath);
  assert.ok(artifact.checks.every(row => row.status === 'passed'), 'Frozen artifact integrity');
  assert.equal(artifact.world.timeline.length, definition.count);
  assert.equal(Math.max(...artifact.world.timeline.map(row => row.after_seconds)), definition.end);
  assert.ok(artifact.world.timeline.every(row => ['incoming-email', 'chat-message'].includes(row.kind)), 'This reader requires declared Slack or SMTP arrivals');
  assert.ok(artifact.world.timeline.filter(row => row.kind === 'incoming-email').every(row => (row.payload.via ?? 'smtp') === 'smtp'));
  const files = inventory(artifactPath); assert.deepEqual(Object.keys(files).sort(), [...Object.keys(artifact.manifest.files), 'manifest.json'].sort());
  const evidence = { input: definition.variant ? { generator: 'tests/fixtures/alien-world.py', seed, variant: definition.variant } : { source: 'examples/minimal-world/world.json', changes: [] },
    identity: artifact.identity, source_files: inventory(source), artifact_files: files, count: definition.count, arc_end_seconds: definition.end };
  saveJson(join(output, 'source-evidence.json'), evidence); return { artifact, evidence };
}

export async function readTimelinePages(request, { limit = 137, fromMs, toMs } = {}) {
  let after = 0, epoch, total; const rows = [], seen = new Set();
  for (let page = 0; page < 10000; page++) {
    const query = new URLSearchParams({ after: String(after), limit: String(limit), ...(fromMs === undefined ? {} : { fromMs: String(fromMs) }), ...(toMs === undefined ? {} : { toMs: String(toMs) }) });
    const body = await request(`/api/timeline?${query}`);
    assert.ok(Array.isArray(body.data) && typeof body.has_more === 'boolean', 'Timeline pagination metadata is required');
    assert.ok(Number.isSafeInteger(body.total_count) && body.total_count >= 0, 'Timeline count is required');
    assert.ok(Number.isSafeInteger(body.epoch) && body.epoch >= 1, 'Timeline epoch is required');
    epoch ??= body.epoch; total ??= body.total_count;
    assert.equal(body.epoch, epoch, 'Timeline generation changed during pagination'); assert.equal(body.total_count, total);
    for (const row of body.data) {
      assert.ok(row.id && !seen.has(row.id), 'Duplicate or missing timeline identity');
      assert.ok(Number.isSafeInteger(row.seq) && row.seq > after, 'Timeline cursor must increase');
      after = row.seq; seen.add(row.id); rows.push(row);
    }
    assert.equal(body.next_cursor, after, 'Timeline next cursor must name the last row');
    if (!body.has_more) { assert.equal(rows.length, total, 'Timeline pagination omitted records'); return rows; }
    assert.ok(body.data.length, 'Empty timeline page cannot have more rows');
  }
  throw new Error('Timeline exceeded the paging limit');
}
export function assertAuthoredRows(world, rows) {
  assert.equal(rows.length, world.timeline.length, 'Every authored arrival must remain inspectable');
  const byId = new Map(rows.map(row => [row.id, row])); assert.equal(byId.size, rows.length);
  const ordered = [...world.timeline].sort((a, b) => a.after_seconds - b.after_seconds || a.id.localeCompare(b.id));
  assert.deepEqual(rows.map(row => row.id), ordered.map(row => row.id), 'Authored row order');
  for (const arrival of world.timeline) {
    const row = byId.get(arrival.id); assert.ok(row, `Missing arrival ${arrival.id}`);
    assert.equal(row.type, arrival.kind); assert.equal(row.due_at, arrival.after_seconds * 1000);
    assert.deepEqual(row.payload, arrival.payload); assert.equal(row.caused_by, null, 'Authored arrivals are not invented causal effects');
    assert.ok(['pending', 'in_flight', 'delivered', 'failed', 'skipped', 'uncertain'].includes(row.status));
  }
}
export function assertBoundary(world, rows, elapsedMs) {
  assertAuthoredRows(world, rows);
  for (const row of rows) assert.equal(row.status, row.due_at <= elapsedMs ? 'delivered' : 'pending', `Arrival ${row.id} at setup boundary`);
}
export function assertAcceptedWorldTimes(world, rows, events) {
  const byId = new Map(events.map(row => [row.id, row]));
  for (const row of rows.filter(row => row.status === 'delivered')) {
    const event = byId.get(row.event_id); assert.ok(event, `No accepted event for ${row.id}`);
    assert.equal(event.occurred_at, new Date(Date.parse(world.clock.anchor) + row.due_at).toISOString(), `World timestamp for ${row.id}`);
    assert.equal(event.caused_by, row.command_id); assert.equal(event.provider_evidence.arrival, row.id);
    const payload = world.timeline.find(arrival => arrival.id === row.id).payload;
    assert.equal(event.actor_id, row.type === 'chat-message' ? payload.author_id : payload.to_id);
  }
}
async function readEvents(request) {
  let after = 0; const all = [], ids = new Set();
  for (let page = 0; page < 10000; page++) {
    const body = await request(`/api/inspect/events?after=${after}`); assert.ok(Array.isArray(body.events));
    if (!body.events.length) return all;
    for (const row of body.events) { assert.ok(row.seq > after && !ids.has(row.id), 'Event pagination must make progress'); after = row.seq; ids.add(row.id); all.push(row); }
  }
  throw new Error('Event pagination exceeded limit');
}
async function slackPages(request, method, field, params = {}) {
  const all = [], cursors = new Set(), ids = new Set(); let cursor;
  for (let page = 0; page < 10000; page++) {
    const body = await request(`/api/${method}`, { method: 'POST', body: { limit: 200, ...params, ...(cursor ? { cursor } : {}) } });
    assert.equal(body.ok, true, `Slack ${method}: ${body.error}`); assert.ok(Array.isArray(body[field]));
    for (const row of body[field]) { const id = row.id ?? row.ts; assert.ok(id && !ids.has(id), `Slack ${method} duplicate identity`); ids.add(id); all.push(row); }
    const next = body.response_metadata?.next_cursor;
    if (!next) { assert.notEqual(body.has_more, true, `Slack ${method} omitted a continuation cursor`); return all; }
    assert.ok(body[field].length && !cursors.has(next), 'Slack pagination did not progress'); cursors.add(next); cursor = next;
  }
  throw new Error('Slack exceeded pagination limit');
}
export function assertProviderArrivals(world, rows, snapshot) {
  const byId = new Map(rows.map(row => [row.id, row])), people = new Map(world.people.map(row => [row.id, row]));
  for (const arrival of world.timeline) {
    const row = byId.get(arrival.id); assert.ok(row);
    if (!['pending', 'delivered'].includes(row.status)) throw new Error(`${arrival.id}: ${row.status}: ${row.error ?? 'inspect saved outcome'}`);
    const expectedCount = row.status === 'delivered' ? 1 : 0, payload = arrival.payload;
    if (arrival.kind === 'chat-message') {
      const matches = (snapshot.slack[payload.channel_id] ?? []).filter(message => message.text === payload.text);
      assert.equal(matches.length, expectedCount, `Public Slack arrival count for ${arrival.id}`);
      if (matches.length) { const user = snapshot.users.filter(user => (user.profile?.email ?? user.email) === people.get(payload.author_id).email); assert.equal(user.length, 1); assert.equal(matches[0].user, user[0].id, `Slack author for ${arrival.id}`); }
    } else {
      const matches = (snapshot.mail[payload.to_id]?.messages ?? []).filter(message => message.headers['x-worldfixture-arrival'] === arrival.id);
      assert.equal(matches.length, expectedCount, `Public IMAP arrival count for ${arrival.id}`);
      if (matches.length) {
        const mail = matches[0]; assert.equal(mail.headers.subject, payload.subject); assert.equal(bodyText(mail.body_text), bodyText(payload.body_text));
        assert.equal(mail.headers.from, people.get(payload.from_id).email); assert.equal(mail.headers.to, people.get(payload.to_id).email);
        assert.equal(Date.parse(mail.headers.date), Date.parse(world.clock.anchor) + arrival.after_seconds * 1000, `Mail Date for ${arrival.id}`);
      }
    }
  }
}

export function requestReader(base, responses, { token, generation, signal, phase, timeoutMs = 1200000, fetchImpl = fetch } = {}) {
  return async (path, options = {}) => {
    const response = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, { method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(generation ? { 'X-WorldFixture-Generation': generation } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = raw; }
    responses.push({ phase, path, method: options.method ?? 'GET', status: response.status, body, sha256: sha(raw) });
    if (!response.ok) { const error = new Error(`${path}: HTTP ${response.status}: ${body.error ?? raw}`); error.response = body; throw error; }
    if (generation) assert.equal(response.headers.get('X-WorldFixture-Generation'), generation, 'Workbench response belongs to another generation');
    return body;
  };
}
export async function workbenchRequestReader(base, responses, options = {}) {
  const session = await requestReader(base, responses, options)('/api/session');
  assert.equal(session.managed, true, 'Normal CLI launch must expose a managed session');
  assert.equal(session.phase, 'ready', 'Workbench session must be ready');
  assert.ok(typeof session.generation === 'string' && session.generation.length, 'Workbench generation is required');
  return requestReader(base, responses, { ...options, generation: session.generation });
}
async function providerSnapshot({ artifact, bindings, credentials, responses, signal, phase, readMailbox = readImapMailbox }) {
  const snapshot = { slack: {}, users: [], mail: {} }, world = artifact.world;
  const channels = [...new Set(world.timeline.filter(row => row.kind === 'chat-message').map(row => row.payload.channel_id))];
  if (channels.length) {
    assert.ok(bindings.SLACK_BASE_URL && bindings.SLACK_TOKEN, 'Selected Slack API and token are required');
    const request = requestReader(bindings.SLACK_BASE_URL, responses, { token: bindings.SLACK_TOKEN, signal, phase, timeoutMs: 45000 });
    const live = await slackPages(request, 'conversations.list', 'channels'); snapshot.users = await slackPages(request, 'users.list', 'members');
    for (const id of channels) {
      const source = world.communication.channels.find(row => row.id === id), matches = live.filter(row => row.name === source.name); assert.equal(matches.length, 1, `Source channel ${id}`);
      snapshot.slack[id] = await slackPages(request, 'conversations.history', 'messages', { channel: matches[0].id });
    }
  }
  for (const id of new Set(world.timeline.filter(row => row.kind === 'incoming-email').map(row => row.payload.to_id))) {
    signal?.throwIfAborted(); const person = world.people.find(row => row.id === id), user = artifact.projections.mail?.users.find(row => row.id === id);
    assert.ok(bindings.IMAP_HOST_PORT && user?.password_ref, `Source mailbox ${id} has a public binding and credential`);
    assert.equal(user.login, person.email); assert.equal(user.email, person.email);
    const result = await readMailbox({ address: bindings.IMAP_HOST_PORT, login: person.email, password: credential(credentials, user.password_ref), mailbox: 'INBOX', timeoutMs: 60000 });
    snapshot.mail[id] = result; responses.push({ phase, provider: 'imap', path: `${id}/INBOX`, status: 'OK', body: result });
  }
  return snapshot;
}

export async function runClockMatrix({ image, reportPath, python, seed, prepareOnly = false, caseNames, signal }) {
  const definitions = selectClockCases(caseNames), directory = resolve(reportPath);
  assert.ok(!existsSync(directory), 'Refusing to overwrite clock evidence');
  if (!prepareOnly) assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'Use an immutable image ID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = randomBytes(12).toString('hex'), report = { api_version: 'worldfixture.clock-image-matrix/v1', image, started_at: new Date().toISOString(), checks: [], cases: [],
    scope: 'Starter and alien authored arcs, setup/start boundary, public CLI/API clock control, full timeline and event paging, and actual Slack/IMAP content. Repeat and application-database behavior require separate image evidence.' };
  const reportSecrets = [];
  const save = () => saveJson(join(directory, 'report.json'), redact(report, reportSecrets));
  try {
    let ports;
    if (!prepareOnly) { const [inspection] = JSON.parse((await docker(['image', 'inspect', image])).stdout); assert.equal(inspection.Id, image); ports = Object.keys(inspection.Config.ExposedPorts); report.image_id = inspection.Id; }
    for (const [index, definition] of definitions.entries()) {
      signal?.throwIfAborted(); const name = `wf-clock-${owner}-${index}`, item = { ...definition, checks: [], responses: [], snapshots: [], launch: definition.setup ? 'CLI up --setup --no-rebase' : `CLI up --start-at ${definition.start}s --no-rebase` }; report.cases.push(item); save();
      let secrets = [], bindings, request, heartbeat;
      const check = (label, work) => { try { work(); item.checks.push({ check: label, status: 'passed' }); } catch (error) { item.checks.push({ check: label, status: 'failed', detail: error.message }); } };
      try {
        const { artifact, evidence } = await prepareClockCase({ definition, outputPath: join(directory, definition.name), python, seed, signal }); item.source_evidence = evidence;
        if (prepareOnly) { item.scope = 'Prepared only; no live clock, provider, or timeline API proof'; continue; }
        console.log(`${definition.name}: starting immutable image`);
        heartbeat = setInterval(() => console.log(`${definition.name}: clock image checks still running`), 30000); heartbeat.unref();
        const args = containerArguments({ image, artifactPath: artifact.path, name, owner, exposedPorts: ports }); args.push(...(definition.setup ? ['--setup'] : ['--start-at', `${definition.start}s`]));
        await docker(args, { timeout: 60000, signal }); await waitForReady(name, { timeoutMs: 360000, signal });
        const [inspection] = JSON.parse((await docker(['inspect', name])).stdout); assert.equal(inspection.Image, image);
        bindings = mappedBindings(await readRunBindings(name), inspection.NetworkSettings.Ports); const credentials = await readRunCredentialSet(name);
        secrets = [...credentialValues(bindings), ...Object.values(credentials.values ?? {})]; reportSecrets.push(...secrets);
        assert.equal(credentials.world.id, artifact.world.id); assert.equal(credentials.world.version, artifact.world.version);
        request = await workbenchRequestReader(bindings.WORKBENCH_URL, item.responses, { signal, phase: 'clock' });
        const cli = async (words = []) => {
          const result = await docker(['exec', name, 'node', 'runtime/bin/worldfixture.mjs', 'clock', ...words, '--state', '/state', '--json'], { timeout: 1200000, signal });
          const body = JSON.parse(result.stdout.trim()); item.responses.push({ via: 'CLI', args: ['clock', ...words, '--json'], status: 0, body }); return body;
        };
        const take = async phase => {
          const rows = await readTimelinePages(request), clock = await request('/api/clock');
          item.snapshots.push({ phase, clock, rows }); check(`${phase}.all-authored-records`, () => assertAuthoredRows(artifact.world, rows)); save(); return { rows, clock };
        };
        if (definition.setup) {
          const initial = await take('setup'); check('setup.no-delivery', () => { assert.equal(initial.clock.mode, 'setup'); assert.equal(initial.clock.clock.elapsed_ms, 0); assert.ok(initial.rows.every(row => row.status === 'pending')); });
          const initialContent = await providerSnapshot({ artifact, bindings, credentials, responses: item.responses, signal, phase: 'setup' });
          check('setup.public-arrivals-absent', () => assertProviderArrivals(artifact.world, initial.rows, initialContent));
          await request('/api/clock', { method: 'POST', body: { action: 'start', duration: `${definition.start}s` } });
        }
        const paused = await cli(['pause']); assert.equal(paused.clock.running, false);
        const boundary = await take('start-boundary'); check('start.exact-boundary-included', () => assertBoundary(artifact.world, boundary.rows, definition.start * 1000));
        const window = await readTimelinePages(request, { limit: 2, fromMs: definition.start * 1000, toMs: definition.start * 1000 });
        check('timeline.exact-time-window', () => assert.deepEqual(window.map(row => row.id).sort(), artifact.world.timeline.filter(row => row.after_seconds === definition.start).map(row => row.id).sort()));
        check('clock.cli-and-api-agree', () => assert.equal(boundary.clock.clock.elapsed_ms, paused.clock.elapsed_ms));
        const beforeContent = await providerSnapshot({ artifact, bindings, credentials, responses: item.responses, signal, phase: 'start-boundary' });
        check('start.public-content', () => assertProviderArrivals(artifact.world, boundary.rows, beforeContent));
        const stillPaused = await request('/api/clock');
        check('pause.time-is-stable', () => { assert.equal(stillPaused.clock.elapsed_ms, paused.clock.elapsed_ms); assert.equal(stillPaused.clock.world_now, paused.clock.world_now); });
        const delta = definition.variant === 'long' ? '1w' : `${definition.end * 1000 - stillPaused.clock.elapsed_ms}ms`;
        assert.ok(definition.variant === 'long' || definition.end * 1000 >= stillPaused.clock.elapsed_ms, 'Setup consumed the next test boundary');
        if (definition.name === 'starter') await cli(['advance', delta]);
        else await request('/api/clock', { method: 'POST', body: { action: 'advance', duration: delta } });
        const final = await take('advanced'); check('advance.all-arrivals-delivered', () => { assert.ok(final.rows.every(row => row.status === 'delivered')); assert.equal(final.clock.timeline.pending, 0); assert.equal(final.clock.timeline.next_due_ms, null); assert.equal(final.clock.clock.running, false); });
        const accepted = await readEvents(request); check('advance.accepted-world-timestamps', () => assertAcceptedWorldTimes(artifact.world, final.rows, accepted));
        const finalContent = await providerSnapshot({ artifact, bindings, credentials, responses: item.responses, signal, phase: 'advanced' });
        check('advance.public-content-and-identities', () => assertProviderArrivals(artifact.world, final.rows, finalContent));
        const again = await cli(['advance', '0s']); check('advance.second-call-no-delivery', () => assert.deepEqual(again.played, []));
        const repeated = await take('second-advance'); check('advance.same-timeline-records', () => assert.deepEqual(repeated.rows, final.rows));
        const repeatedContent = await providerSnapshot({ artifact, bindings, credentials, responses: item.responses, signal, phase: 'second-advance' });
        check('advance.no-duplicate-provider-writes', () => { assertProviderArrivals(artifact.world, repeated.rows, repeatedContent); assert.deepEqual(repeatedContent, finalContent); });
        const repeatedEvents = await readEvents(request);
        check('advance.accepted-events-unchanged', () => assert.deepEqual(repeatedEvents, accepted));
      } catch (error) {
        item.checks.push({ check: 'clock.case', status: 'failed', failure_kind: signal?.aborted ? 'cancelled' : 'measured_failure', detail: error.message, ...(error.response ? { response: error.response } : {}) });
        if (bindings?.WORKBENCH_URL) try { const inspect = requestReader(bindings.WORKBENCH_URL, item.responses, { phase: 'failure-inspection', timeoutMs: 45000 }); item.failure_state = { clock: await inspect('/api/clock'), rows: await readTimelinePages(inspect) }; } catch (error) { item.inspection_error = error.message; }
      } finally {
        clearInterval(heartbeat);
        if (!prepareOnly) {
          try { const credentials = await readRunCredentialSet(name); secrets.push(...Object.values(credentials.values ?? {})); } catch { /* A failed launch may not create credentials. */ }
          try { const logs = await docker(['logs', '--tail', '300', name]); writeFileSync(join(directory, `${definition.name}.log`), redact(logs.stdout + logs.stderr, secrets)); } catch { /* A failed launch may not create a container. */ }
          try { await removeOwnedContainer(name, owner); } catch (error) { item.checks.push({ check: 'clock.cleanup', status: 'failed', detail: error.message }); }
        }
        reportSecrets.push(...secrets); Object.assign(item, redact(item, secrets)); save();
      }
    }
  } catch (error) { report.checks.push({ check: 'clock.matrix', status: 'failed', detail: error.message }); }
  report.finished_at = new Date().toISOString(); report.failed_checks = [...report.checks, ...report.cases.flatMap(item => item.checks)].filter(row => row.status === 'failed').length;
  report.status = report.failed_checks ? 'failed' : prepareOnly ? 'prepared' : 'passed'; save(); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { image: { type: 'string' }, report: { type: 'string' }, python: { type: 'string' }, seed: { type: 'string' }, case: { type: 'string', multiple: true }, 'prepare-only': { type: 'boolean', default: false } } });
  assert.ok(values.report, '--report is required');
  const abort = new AbortController(); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(signal)));
  const report = await runClockMatrix({ image: values.image, reportPath: values.report, python: values.python, seed: values.seed, caseNames: values.case, prepareOnly: values['prepare-only'], signal: abort.signal });
  console.log(`Clock matrix ${report.status}: ${report.failed_checks} failed checks`); process.exitCode = report.failed_checks ? 1 : 0;
}
