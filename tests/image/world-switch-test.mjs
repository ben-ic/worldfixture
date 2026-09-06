// One managed session, one port map, four generations. All writes use normal
// product APIs. Provider contents come from the existing source-backed readers.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { SINGLE_CONTAINER_PORTS } from '../../runtime/src/ports.mjs';
import { loadArtifact } from './coupling-artifacts.mjs';
import { containerArguments, credentialValues, docker, mappedBindings, redact, removeOwnedContainer, waitForReady } from './coupling-runner.mjs';
import { prepareWorkbenchCase } from './workbench-world-test.mjs';
import { readTimelinePages } from './clock-world-test.mjs';
import { paginate, probeWorld } from './coupling-probes.mjs';
import { probeExtraWorld, SUPPLEMENTAL_PROVIDERS } from './coupling-extra-probes.mjs';
import { probeGoogleWorld } from './coupling-google-probes.mjs';
import { probeFinanceWorld } from './coupling-finance-probes.mjs';
import { probeRelationshipsWorld } from './coupling-relationships-probes.mjs';
import { probeNotionWorld } from './coupling-notion-probes.mjs';
import { probeMailWorld } from './coupling-mail-probes.mjs';
import { observeFeeds } from './coupling-temporal-probes.mjs';
import { probeOldProviderCredentials, probeRetiredListeners } from './world-switch-retired-probes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const saveJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const ids = rows => rows.map(row => row.id).sort();
export const SWITCH_SEQUENCE = ['A', 'B', 'alien', 'A'];

function inventory(root) {
  const found = {};
  const visit = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) { const bytes = readFileSync(path); found[relative(root, path)] = { sha256: sha(bytes), size: bytes.length }; }
  } }; visit(root); return found;
}
export async function prepareSwitchInputs({ outputPath, python = process.env.PYTHON ?? 'python3', seed = 'coupling-p6-switch-2026-09-06', signal }) {
  const root = resolve(outputPath); assert.ok(!existsSync(root), 'Refusing to overwrite switch inputs'); mkdirSync(root, { recursive: true, mode: 0o700 });
  const result = {};
  for (const [name, world] of [['A', 'business.saas-company.v2'], ['B', 'consumer.retail-brand.v1']]) {
    result[name] = await prepareWorkbenchCase({ sourcePath: join(ROOT, 'worlds', world, 'world.json'), outputPath: join(root, name), python, signal });
  }
  const alien = join(root, 'alien'); mkdirSync(alien);
  const originalPath = join(alien, 'original-source.json'), entry = join(alien, 'world.json');
  await execute(python, [join(ROOT, 'tests/fixtures/alien-world.py'), '--seed', seed, '--variant', 'short', '--output', originalPath], { signal });
  const original = JSON.parse(readFileSync(originalPath)), source = structuredClone(original);
  assert.equal(source.communication.channels.length, 1);
  source.communication.channels[0].name = 'general'; saveJson(entry, source);
  const expected = structuredClone(original); expected.communication.channels[0].name = 'general'; assert.deepEqual(source, expected);
  const output = join(alien, 'artifact');
  await execute(python, ['-m', 'worldfixture_compiler', 'build', entry, '--output', output], { cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'compiler') }, signal, maxBuffer: 8 * 1024 * 1024 });
  const artifact = loadArtifact(output); assert.ok(artifact.checks.every(check => check.status === 'passed'));
  assert.deepEqual(artifact.world, source); assert.equal(source.timeline.length, 4);
  result.alien = { artifact, evidence: { seed, variant: 'short', original_source_sha256: sha(readFileSync(originalPath)), source_sha256: sha(readFileSync(entry)),
    changes: [{ field: 'communication.channels[0].name', before: original.communication.channels[0].name, after: 'general' }] } };
  for (const [name, item] of Object.entries(result)) {
    item.containerPath = `/switch-inputs/${relative(root, item.artifact.path).split('\\').join('/')}`;
    item.evidence.identity = item.artifact.identity;
    item.evidence.files = inventory(join(root, name));
    assert.ok(item.artifact.world.communication.channels.some(channel => channel.name === 'general'));
  }
  assert.notEqual(result.A.artifact.world.people.find(person => person.primary).id, result.B.artifact.world.people.find(person => person.primary).id);
  assert.notEqual(result.alien.artifact.world.communication.channels[0].id, result.A.artifact.world.communication.channels.find(channel => channel.name === 'general').id);
  saveJson(join(root, 'inputs.json'), Object.fromEntries(Object.entries(result).map(([name, item]) => [name, item.evidence])));
  return result;
}

export function assertGeneration({ artifact, session, active, lock, world, bindings, credentials, clock, timeline, overview }) {
  const expected = { id: artifact.identity.id, version: artifact.identity.version, artifact_sha256: artifact.identity.digest };
  assert.equal(session.managed, true); assert.equal(session.phase, 'ready'); assert.ok(session.generation);
  assert.deepEqual(session.world, expected); assert.deepEqual(active.world, expected);
  assert.equal(active.generation, session.generation); assert.equal(active.phase, 'ready');
  assert.deepEqual({ id: lock.world.id, version: lock.world.version, artifact_sha256: lock.world.artifact_sha256 }, expected);
  assert.deepEqual(world, artifact.world);
  assert.equal(credentials.world.id, expected.id); assert.equal(credentials.world.version, expected.version);
  if (credentials.generation !== undefined) assert.equal(credentials.generation, session.generation);
  const primary = artifact.world.people.find(person => person.primary); assert.ok(primary);
  assert.equal(lock.target.identity, primary.id);
  for (const declaration of Object.values(lock.bindings)) if (declaration.person) assert.equal(declaration.person, primary.id);
  assert.deepEqual(Object.keys(bindings).filter(key => !['WORKBENCH_URL', 'WORLDFIXTURE_TOKEN'].includes(key)).sort(), Object.keys(lock.bindings).sort());
  assert.equal(overview.generation, session.generation); assert.deepEqual(ids(overview.people), ids(artifact.world.people));
  assert.equal(overview.world.artifact_sha256, expected.artifact_sha256);
  assert.equal(clock.mode, 'setup'); assert.equal(clock.clock.elapsed_ms, 0); assert.equal(clock.clock.running, false);
  const authored = artifact.world.timeline.filter(row => lock.execution.timeline.active.includes(row.id));
  assert.deepEqual(ids(timeline), ids(authored));
  for (const row of timeline) {
    const source = authored.find(value => value.id === row.id);
    assert.equal(row.type, source.kind); assert.equal(row.due_at, source.after_seconds * 1000); assert.deepEqual(row.payload, source.payload); assert.equal(row.status, 'pending');
  }
}
export function assertCredentialRotation(previous, current) {
  const oldValues = new Set(Object.values(previous.values));
  assert.ok(Object.keys(current.values).length);
  for (const value of Object.values(current.values)) assert.ok(!oldValues.has(value), 'A previous generation credential was reused');
}
export function assertStaleResponse(result, code = 'stale_generation') {
  assert.equal(result.status, 409); assert.equal(result.body.code, code);
}
export function assertSurfaceEvidence(lock, results) {
  const expected = [...new Set(lock.services.flatMap(service => service.name === 'emulate'
    ? Object.values(lock.capabilities).filter(cap => cap.service === 'emulate').map(cap => cap.port)
    : [service.name === 'http-targets' ? 'http' : service.name]))];
  for (const surface of expected) {
    assert.ok(results.responses.some(row => (row.provider === surface || (surface === 'mail' && ['imap', 'mail'].includes(row.provider)))
      && (row.status === 'OK' || (Number(row.status) >= 200 && Number(row.status) < 300))), `No positive measured API read for selected surface ${surface}`);
  }
  return expected;
}

export async function readSelectedProviders({ artifact, bindings, credentials, signal, temporal, readers } = {}) {
  const result = { checks: [], responses: [], coverage: [] };
  const fetchImpl = (url, options = {}) => fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]) : options.signal });
  const common = { artifact, bindings, credentials, elapsedMs: 0, fetchImpl };
  const merge = value => { for (const key of ['checks', 'responses', 'coverage']) result[key].push(...value[key] ?? []); };
  if (readers) { for (const reader of readers) merge(await reader(common)); return result; }
  const primary = await probeWorld({ ...common, supplementalGoogle: true, supplementalProviders: [...SUPPLEMENTAL_PROVIDERS, 'mail'] }); merge(primary);
  merge(await probeExtraWorld({ ...common, supplementalApple: true, supplementalNotion: true, supplementalTemporal: Boolean(temporal) }));
  if (bindings.GOOGLE_BASE_URL || artifact.projections.google) merge(await probeGoogleWorld(common));
  if (bindings.STRIPE_BASE_URL || artifact.projections.stripe) merge(await probeFinanceWorld({ ...common, domainCoverage: primary.coverage }));
  merge(await probeRelationshipsWorld(common));
  if (bindings.NOTION_BASE_URL || artifact.projections.notion) merge(await probeNotionWorld(common));
  if (bindings.IMAP_HOST_PORT || artifact.projections.mail) merge(await probeMailWorld(common));
  if (temporal) merge(await temporal);
  return result;
}

async function request(base, path, { body, generation, token, signal, responses, method = body === undefined ? 'GET' : 'POST', timeoutMs = 900000 } = {}) {
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { method, headers: { 'content-type': 'application/json',
    ...(generation ? { 'X-WorldFixture-Generation': generation } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; }
  const result = { status: response.status, generation: response.headers.get('x-worldfixture-generation'), body: value };
  responses?.push({ path, method, ...result }); return result;
}
const accepted = result => { assert.ok(result.status >= 200 && result.status < 300, `HTTP ${result.status}: ${JSON.stringify(result.body)}`); return result.body; };
async function activeFiles(name) {
  return JSON.parse((await docker(['exec', name, 'node', '-e', `const fs=require('node:fs');const read=p=>JSON.parse(fs.readFileSync(p));const active=read('/state/active-generation.json');process.stdout.write(JSON.stringify({active,lock:read(active.lockPath),credentials:read(active.credentialsPath),bindings:read(active.bindingsPath),world:read(active.artifactPath+'/world.json')}));`])).stdout);
}
async function slackRows(bindings, method, field, args, responses, signal) {
  return paginate(async cursor => {
    const body = accepted(await request(bindings.SLACK_BASE_URL, `/api/${method}`, { body: { limit: 200, ...args, ...(cursor ? { cursor } : {}) }, token: bindings.SLACK_TOKEN, responses, signal }));
    assert.equal(body.ok, true); return body;
  }, { items: body => body[field], next: body => { const cursor = body.response_metadata?.next_cursor; assert.ok(!body.has_more || cursor, 'Slack omitted its paging cursor'); return cursor; } });
}
async function observeCurrentFeeds({ artifact, base, launchAt, signal, onProgress }) {
  const checks = [], responses = [];
  try {
  const feeds = artifact.projections['http-targets']?.feeds ?? [];
  const limit = Date.now() + 900000; let readyAt;
  while (Date.now() < limit) {
    signal.throwIfAborted();
    try { const response = await fetch(`${base}${feeds[0].path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }); if (response.ok) { await response.text(); readyAt = Date.now(); break; } }
    catch (error) { if (signal.aborted) throw error; }
    await sleep(200, undefined, { signal });
  }
  assert.ok(readyAt, 'The new HTTP feed never became available');
  const result = await observeFeeds({ feeds, base, launchAt, readyAt, signal, onProgress, checks, responses });
  for (const row of result.coverage) row.detail = 'Complete source content and delayed transitions from the same managed session HTTP process, observed through the unchanged published port.';
  return result;
  } catch (error) {
    checks.push({ check: 'http.same-session-delayed-content', status: 'failed', detail: error.message });
    return { checks, responses, coverage: [{ collection: 'site.feed.items', provider: 'http', status: 'failed', detail: error.message }] };
  }
}

export async function runWorldSwitchTest({ image, reportPath, python, seed, prepareOnly = false, signal }) {
  const directory = resolve(reportPath); assert.ok(!existsSync(directory), 'Refusing to overwrite switch evidence');
  if (!prepareOnly) assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/, 'Use an immutable P6 image ID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const report = { api_version: 'worldfixture.switch-image-test/v1', image, started_at: new Date().toISOString(), cases: [], checks: [],
    scope: 'One full-provider CLI image session, A → B → alien → A, same published ports, exact current source contents through existing provider readers, generation gates, credentials, and real provider cache/mutation checks. Host import, browser races, interrupted transitions, and application databases require separate evidence.' };
  const secrets = [], owner = randomBytes(12).toString('hex'), name = `wf-switch-${owner}`;
  const save = () => saveJson(join(directory, 'report.json'), redact(report, secrets));
  let heartbeat, previous, base, ports;
  const controller = new AbortController(); signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  let temporal;
  try {
    const inputs = await prepareSwitchInputs({ outputPath: join(directory, 'inputs'), python, seed, signal });
    report.inputs = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value.evidence])); save();
    if (prepareOnly) { report.status = 'prepared'; report.scope = 'Frozen inputs only. No live API or switch proof.'; return report; }
    const [imageInfo] = JSON.parse((await docker(['image', 'inspect', image])).stdout); assert.equal(imageInfo.Id, image); report.image_id = imageInfo.Id;
    const args = containerArguments({ image, artifactPath: inputs.A.artifact.path, name, owner, exposedPorts: Object.keys(imageInfo.Config.ExposedPorts) });
    args.splice(args.indexOf(image), 0, '--mount', `type=bind,src=${join(directory, 'inputs')},dst=/switch-inputs,readonly`); args.push('--setup');
    heartbeat = setInterval(() => console.log(`${report.cases.at(-1)?.name ?? 'startup'}: switch image checks still running`), 30000); heartbeat.unref();
    await docker(args, { timeout: 60000, signal }); await waitForReady(name, { timeoutMs: 900000, signal });
    const [inspection] = JSON.parse((await docker(['inspect', name])).stdout); ports = inspection.NetworkSettings.Ports;
    assert.equal(inspection.Image, image); report.published_ports = ports;
    const initial = await activeFiles(name); base = mappedBindings(initial.bindings, ports).WORKBENCH_URL;
    // The normal import API adds the frozen paths to the same session catalogue.
    for (const item of Object.values(inputs)) await docker(['exec', name, 'node', '--input-type=module', '-e', `import {importSwitchArtifact} from './runtime/src/switch-world.mjs';const row=importSwitchArtifact(process.argv[1],{stateDir:'/state'});process.stdout.write(JSON.stringify(row));`, item.containerPath]);
    for (const [index, key] of SWITCH_SEQUENCE.entries()) {
      const artifact = inputs[key].artifact, item = { name: `${index}-${key}`, identity: artifact.identity, checks: [], responses: [], coverage: [] }; report.cases.push(item);
      const check = (label, task) => { try { task(); item.checks.push({ check: label, status: 'passed' }); } catch (error) { item.checks.push({ check: label, status: 'failed', detail: error.message }); } };
      console.log(`${item.name}: inspecting selected generation`);
      const api = (path, options = {}) => request(base, path, { responses: item.responses, signal, ...options });
      if (index) {
        const launchAt = Date.now();
        const changed = accepted(await api('/api/world/switch', { generation: previous.generation, body: { worldPath: `/state/catalogue/${artifact.identity.digest}`, noRebase: true } }));
        assert.equal(changed.reconnect_required, true); assert.notEqual(changed.generation, previous.generation);
        // Capture only the accepted process. Baseline capture can restart HTTP
        // after its first temporary readiness response during provider seeding.
        const feeds = artifact.projections['http-targets']?.feeds ?? [];
        if (feeds.length) {
          const httpPort = ports[`${SINGLE_CONTAINER_PORTS['http-targets/http']}/tcp`][0].HostPort;
          temporal = observeCurrentFeeds({ artifact, base: `http://127.0.0.1:${httpPort}`, launchAt, signal: controller.signal,
            onProgress: value => console.log(`${item.name}: HTTP delay observations ${value.elapsed_seconds}s; ${value.remaining_seconds}s remain`) });
          temporal.catch(() => {});
        }
      }
      const session = accepted(await api('/api/session')), current = await activeFiles(name), bindings = mappedBindings(current.bindings, ports);
      secrets.push(...credentialValues(current.bindings), ...Object.values(current.credentials.values));
      item.generation = session.generation; item.active = current.active; item.lock = current.lock;
      item.credential_fingerprints = Object.fromEntries(Object.entries(current.credentials.values).map(([ref, value]) => [ref, sha(value)]));
      const clock = accepted(await api('/api/clock', { generation: session.generation }));
      const timeline = await readTimelinePages(async path => accepted(await api(path, { generation: session.generation })));
      const overview = accepted(await api('/api/overview', { generation: session.generation }));
      item.timeline = timeline; item.clock = clock;
      check('generation.identity-bindings-timeline-primary', () => assertGeneration({ artifact, session, ...current, bindings, clock, timeline, overview }));
      const [liveContainer] = JSON.parse((await docker(['inspect', name])).stdout);
      check('generation.same-container-and-published-ports', () => { assert.equal(liveContainer.Id, inspection.Id); assert.deepEqual(liveContainer.NetworkSettings.Ports, ports); assert.equal(bindings.WORKBENCH_URL, base); });
      const catalogue = accepted(await api('/api/worlds'));
      check('catalogue.verified-selected-artifact', () => assert.ok(catalogue.data.some(row => row.id === artifact.identity.id && row.version === artifact.identity.version && row.digest === artifact.identity.digest && row.valid)));
      save();
      if (previous) {
        check('generation.credential-rotation', () => assertCredentialRotation(previous.credentials, current.credentials));
        for (const probe of [probeRetiredListeners, probeOldProviderCredentials]) {
          const evidence = await probe({ previous: previous.bindings, current: bindings, connectImpl: async row => {
            const hostPort = new URL(row.base).port;
            const port = Object.entries(ports).find(([, mappings]) => mappings?.some(mapping => mapping.HostPort === hostPort))?.[0].split('/')[0];
            assert.ok(port, `No container port maps to ${row.binding}`);
            return JSON.parse((await docker(['exec', name, 'node', '-e',
              "const s=require('node:net').connect({host:'127.0.0.1',port:Number(process.argv[1])});let done=false;const finish=r=>{if(done)return;done=true;process.stdout.write(JSON.stringify(r));s.destroy();};s.once('connect',()=>finish({connected:true}));s.once('error',e=>finish({connected:false,code:e.code}));s.setTimeout(3000,()=>finish({connected:false,code:'TIMEOUT'}));", port])).stdout);
          } });
          item.checks.push(...evidence.checks); item.responses.push(...evidence.responses);
        }
        for (const action of ['start', 'resume', 'advance']) {
          const denied = await api('/api/clock', { generation: session.generation, body: { action, duration: '0s' } });
          check(`generation.reconnect-gate.${action}`, () => assertStaleResponse(denied, 'application_reconnect_required'));
        }
        const stale = await api('/api/actions/slack', { generation: previous.generation, body: { person_id: current.lock.target.identity, channel: previous.channel, text: `rejected-${owner}-${index}` } });
        check('generation.stale-write-refused', () => assertStaleResponse(stale));
        const oldSlack = await request(bindings.SLACK_BASE_URL, '/api/auth.test', { body: {}, token: previous.bindings.SLACK_TOKEN, responses: item.responses, signal });
        check('generation.old-slack-credential-denied', () => assert.ok([401, 403].includes(oldSlack.status) || (oldSlack.status === 200 && oldSlack.body.ok === false && ['invalid_auth', 'not_authed', 'token_revoked'].includes(oldSlack.body.error))));
        const oldDomain = await request(bindings.DOMAIN_BASE_URL, '/v1/collections', { token: previous.bindings.DOMAIN_TOKEN, responses: item.responses, signal });
        check('generation.old-domain-credential-denied', () => assert.ok([401, 403].includes(oldDomain.status)));
        const confirmation = accepted(await api('/api/world/connection', { generation: session.generation, body: { withoutApplication: true } }));
        check('generation.explicit-reconnection', () => assert.equal(confirmation.reconnect_required, false));
      }
      const results = await readSelectedProviders({ artifact, bindings, credentials: current.credentials, signal, temporal }); temporal = null;
      item.checks.push(...results.checks); item.responses.push(...results.responses); item.coverage.push(...results.coverage);
      check('generation.all-selected-surfaces-read', () => { item.measured_surfaces = assertSurfaceEvidence(current.lock, results); });
      // Warm both channel-name and identity caches via the Workbench write path.
      const channels = await slackRows(bindings, 'conversations.list', 'channels', {}, item.responses, signal);
      const channel = channels.find(row => row.name === 'general'); assert.ok(channel);
      const users = await slackRows(bindings, 'users.list', 'members', {}, item.responses, signal);
      const primary = artifact.world.people.find(person => person.primary), user = users.find(row => (row.profile?.email ?? row.email) === primary.email); assert.ok(user);
      const beforeMessages = await slackRows(bindings, 'conversations.history', 'messages', { channel: channel.id }, item.responses, signal);
      check('generation.old-manual-writes-absent', () => assert.ok(beforeMessages.every(row => !String(row.text).includes(`wf-switch-${owner}`) && !String(row.text).includes(`rejected-${owner}`))));
      if (key === 'alien') check('generation.same-channel-name-new-native-id', () => assert.notEqual(channel.id, previous.channel));
      const marker = `wf-switch-${owner}-${index}`;
      const posted = accepted(await api('/api/actions/slack', { generation: session.generation, body: { person_id: primary.id, channel: channel.id, text: marker } }));
      const messages = await slackRows(bindings, 'conversations.history', 'messages', { channel: channel.id }, item.responses, signal);
      check('generation.cached-write-current-channel-and-actor', () => {
        assert.equal(posted.ok, true); assert.equal(posted.event.actor_id, primary.id); assert.equal(posted.event.provider_evidence.channel_id, channel.id);
        const found = messages.filter(row => row.text === marker); assert.equal(found.length, 1); assert.equal(found[0].user, user.id);
      });
      const cleared = accepted(await request(bindings.SLACK_BASE_URL, '/api/conversations.setTopic', {
        body: { channel: channel.id, topic: '' }, token: bindings.SLACK_TOKEN, responses: item.responses, signal,
      }));
      check('generation.current-channel-topic-cleared', () => assert.equal(cleared.ok, true));
      const afterClear = accepted(await api('/api/overview', { generation: session.generation }));
      check('generation.workbench-retains-cleared-live-topic', () => {
        assert.equal(afterClear.providers.slack.channels.find(row => row.id === channel.id)?.topic, '');
      });
      const project = structuredClone(artifact.world.work.projects[0]); project.id = `switch-project-${owner}-${index}`; project.name = marker;
      const created = await request(bindings.DOMAIN_BASE_URL, '/v1/collections/work.projects', { body: { actor_id: primary.id, record: project }, token: bindings.DOMAIN_TOKEN, responses: item.responses, signal });
      accepted(created);
      const readback = accepted(await request(bindings.DOMAIN_BASE_URL, `/v1/collections/work.projects/${project.id}`, { token: bindings.DOMAIN_TOKEN, responses: item.responses, signal }));
      check('generation.manual-domain-write-readback', () => assert.deepEqual(readback.record ?? readback.data, project));
      item.manual_mutations = { slack: marker, domain: project.id, native_channel: channel.id, native_actor: user.id };
      previous = { generation: session.generation, credentials: current.credentials, bindings, channel: channel.id };
      save();
    }
  } catch (error) { report.checks.push({ check: 'switch.image-case', status: 'failed', detail: error.message }); }
  finally {
    controller.abort(new Error('Switch harness cleanup')); await temporal?.catch(() => {}); clearInterval(heartbeat);
    if (!prepareOnly) {
      try { const latest = await activeFiles(name); secrets.push(...Object.values(latest.credentials.values)); } catch {}
      try { const logs = await docker(['logs', '--tail', '500', name]); writeFileSync(join(directory, 'container.log'), redact(logs.stdout + logs.stderr, secrets)); } catch {}
      try { await removeOwnedContainer(name, owner); } catch (error) { report.checks.push({ check: 'switch.cleanup', status: 'failed', detail: error.message }); }
    }
    report.finished_at = new Date().toISOString(); report.failed_checks = [...report.checks, ...report.cases.flatMap(item => item.checks)].filter(check => check.status === 'failed').length;
    report.status = report.failed_checks ? 'failed' : prepareOnly ? 'prepared' : 'passed'; save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { image: { type: 'string' }, report: { type: 'string' }, python: { type: 'string' }, seed: { type: 'string' }, 'prepare-only': { type: 'boolean', default: false } } });
  assert.ok(values.report, '--report is required'); const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(signal)));
  const report = await runWorldSwitchTest({ image: values.image, reportPath: values.report, python: values.python, seed: values.seed, prepareOnly: values['prepare-only'], signal: abort.signal });
  console.log(`World switch ${report.status}: ${report.failed_checks} failed checks`); process.exitCode = report.failed_checks ? 1 : 0;
}
