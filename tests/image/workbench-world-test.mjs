// P3 evidence uses frozen sources and normal seed/start/reset APIs. Browser
// layout and guide interactions are a separate check; this is API evidence.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { loadArtifact } from './coupling-artifacts.mjs';
import { containerArguments, credentialValues, docker, mappedBindings, pauseRunClock, readRunBindings, readRunCredentialSet, redact, removeOwnedContainer, waitForReady } from './coupling-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const ids = rows => rows.map(row => row.id).sort();
export const VARIANT_PERSON_ID = 'person-47.uncommon';
export const VARIANT_SITE = { feed: { path: '/p3/feed.xml', title: 'P3 source feed', description: 'Explicit test source.', items: [] },
  pages: [{ path: '/p3/kind', kind: 'Bulletin expérimental', title: 'P3 selected target', heading: 'P3 selected target', body: 'This content belongs to the P3 source variant.' }],
  probes: [], metrics: [], status: { status: 'operational', summary: 'P3 source status' } };
export const TRANSLATED_STATE = { id: 'eabf89c2-2c47-4f1c-9b2a-014dcdf347d3', name: 'En attente de contrôle', type: 'started', position: 47 };

export function linearStateOverlay(artifact) {
  const teams = structuredClone(artifact.projections['emulator-overlay'].linear.teams);
  assert.ok(teams.length && Array.isArray(teams[0].states));
  assert.ok(!teams.some(team => team.states?.some(state => state.id === TRANSLATED_STATE.id || state.name === TRANSLATED_STATE.name)));
  teams[0].states.push(TRANSLATED_STATE);
  return { linear: { teams } };
}

function replacePerson(value, oldId) {
  if (Array.isArray(value)) return value.map(row => replacePerson(row, oldId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key === 'name' && value.id === oldId ? 'Tavi' : replacePerson(item, oldId)]));
  return value === oldId ? VARIANT_PERSON_ID : value;
}

export async function prepareWorkbenchCase({ sourcePath, outputPath, variant = false, python = process.env.PYTHON ?? 'python3', signal }) {
  const output = resolve(outputPath), source = resolve(sourcePath);
  if (existsSync(output)) throw new Error(`Test output already exists: ${output}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const copied = join(output, 'source'); cpSync(dirname(source), copied, { recursive: true });
  const entryPath = join(copied, basename(source));
  const compile = async path => {
    await execute(python, ['-m', 'worldfixture_compiler', 'build', entryPath, '--output', path], {
      cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'compiler') }, maxBuffer: 4 * 1024 * 1024, signal });
    const artifact = loadArtifact(path);
    assert.ok(artifact.checks.every(check => check.status === 'passed'), 'Compiled artifact integrity');
    return artifact;
  };
  const baseline = await compile(join(output, 'baseline-artifact'));
  const changes = [];
  let artifact = baseline;
  if (variant) {
    assert.equal(baseline.world.site, undefined, 'Identity/HTTP test expects the v2 source without site');
    const primary = baseline.world.people.find(person => person.primary); assert.ok(primary);
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          const before = readFileSync(path), value = JSON.parse(before), changed = replacePerson(value, primary.id);
          if (!equal(value, changed)) { json(path, changed); changes.push({ path: path.slice(copied.length + 1), before_sha256: sha(before), after_sha256: sha(readFileSync(path)) }); }
        }
      }
    };
    visit(copied);
    const entry = JSON.parse(readFileSync(entryPath)), fragment = 'packs/p3-http-kind.json';
    assert.ok(!existsSync(join(copied, fragment)));
    json(join(copied, fragment), { api_version: 'worldfixture.world-fragment/v1', id: 'pack.p3-http-kind', contributes: { site: VARIANT_SITE } });
    entry.fragments.push(fragment); json(entryPath, entry);
    artifact = await compile(join(output, 'artifact'));
    const expected = replacePerson(baseline.world, primary.id); expected.site = VARIANT_SITE;
    assert.ok(equal(artifact.world, expected), 'Only the declared person/reference and HTTP source changes are allowed');
    assert.notEqual(artifact.identity.digest, baseline.identity.digest);
    changes.push({ field: 'site', fragment, sha256: sha(readFileSync(join(copied, fragment))), value: VARIANT_SITE });
  }
  const evidence = { source_path: source, captured_source_path: entryPath, baseline_identity: baseline.identity,
    variant_identity: artifact.identity, baseline_manifest: baseline.manifest, variant_manifest: artifact.manifest, changes,
    scope: variant ? 'Person ID, mononym, and explicit HTTP kind in a frozen source copy only.' : 'Unchanged frozen shipped source.' };
  json(join(output, 'source-evidence.json'), evidence);
  return { artifact, evidence };
}

export function sparseEntryScript({ slackOnly = false } = {}) {
  const requires = slackOnly ? ['slack.messaging.v1'] : ['stripe.customers.v1', 'stripe.catalog.v1', 'linear.issues.v1', 'linear.teams.v1', 'notion.pages-read.v1', 'notion.users.v1'];
  const bindings = slackOnly ? { SLACK_BASE_URL: 'slack.messaging.v1/base_url', SLACK_TOKEN: 'slack.messaging.v1/token' }
    : { STRIPE_BASE_URL: 'stripe.customers.v1/base_url', STRIPE_TOKEN: 'stripe.customers.v1/token', LINEAR_BASE_URL: 'linear.issues.v1/base_url', LINEAR_TOKEN: 'linear.issues.v1/token', NOTION_BASE_URL: 'notion.pages-read.v1/base_url', NOTION_TOKEN: 'notion.pages-read.v1/token' };
  return `import {mkdirSync,writeFileSync} from 'node:fs';
import {resolveEnvironment,serializeLock} from '/opt/worldfixture/runtime/src/resolve.mjs';
import {loadManifests} from '/opt/worldfixture/runtime/src/manifests.mjs';
import {start} from '/opt/worldfixture/runtime/src/supervisor.mjs';
import {startWorkbench} from '/opt/worldfixture/runtime/src/workbench.mjs';
import {SINGLE_CONTAINER_PORTS} from '/opt/worldfixture/runtime/src/ports.mjs';
import {readWorld} from '/opt/worldfixture/runtime/src/world.mjs';
const artifactPath='/world', stateDir='/state', serviceRoot='/opt/worldfixture/emulators';
mkdirSync(stateDir,{recursive:true});
const world=readWorld(artifactPath), spec={api_version:'worldfixture.environment/v1',world:{use:world.id+':'+world.version},
requires:${JSON.stringify(requires)},
bindings:${JSON.stringify(bindings)},rules:[],execution:{mode:'selected-capabilities'},target:{kind:'none',identity:world.people.find(p=>p.primary)?.id}};
const lock=resolveEnvironment(spec,{manifests:loadManifests(serviceRoot),artifactPath});
writeFileSync(stateDir+'/environment.lock.json',serializeLock(lock));writeFileSync(stateDir+'/environment.json',JSON.stringify(spec));
const instance=await start(lock,{artifactPath,stateDir,serviceRoot,runner:'process',inContainer:true,fixedPorts:SINGLE_CONTAINER_PORTS});
instance.applicationBindings=instance.bindings();
const workbench=await startWorkbench(instance,{artifactPath,stateDir,port:4715,host:'0.0.0.0'});
instance.applicationBindings.WORKBENCH_URL=workbench.url;
writeFileSync(stateDir+'/bindings.json',JSON.stringify(instance.applicationBindings));
writeFileSync(stateDir+'/p3-runner.pid',String(process.pid));
// Test-owned failure injection uses the normal supervisor stop API, no DB edits.
process.on('SIGUSR2',async()=>{await instance.stopChildren({services:['emulate']});writeFileSync(stateDir+'/p3-stopped','yes');});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await workbench.close();await instance.stop();process.exit();});
console.log('Stop with Ctrl-C');
`;
}

export async function readCompletePages(read, { kind, path, query, field }) {
  const rows = [], seen = new Set(); let cursor;
  for (let page = 0; page < 1000; page++) {
    let body, values, more, next;
    if (kind === 'stripe') {
      body = await read(`${path}?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}${path.endsWith('/subscriptions') ? '&status=all' : ''}`);
      values = body.data; more = body.has_more; next = values?.at(-1)?.id;
    } else if (kind === 'linear') {
      body = await read('/graphql', { query: `query { ${field}(first:100${cursor ? `,after:${JSON.stringify(cursor)}` : ''}) { nodes { ${query} } pageInfo {hasNextPage endCursor} } }` });
      if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
      values = body.data?.[field]?.nodes; more = body.data?.[field]?.pageInfo?.hasNextPage; next = body.data?.[field]?.pageInfo?.endCursor;
    } else {
      body = await read(path, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      values = body.results; more = body.has_more; next = body.next_cursor;
    }
    assert.ok(Array.isArray(values) && typeof more === 'boolean', `${kind} pagination metadata`);
    for (const row of values) { assert.ok(row.id && !seen.has(row.id), `${kind} duplicate/missing identity`); seen.add(row.id); rows.push(row); }
    if (!more) return rows;
    assert.ok(values.length && next && next !== cursor, `${kind} invalid next cursor`); cursor = next;
  }
  throw new Error(`${kind} exceeded pagination limit`);
}

export function assertHttpPreview(website, configured, baseUrl) {
  assert.equal(website.available, true, 'Declared HTTP content must be available');
  assert.equal(website.status, 'ready');
  const expectedPath = configured.pages?.[0]?.path ?? website.targets?.[0]?.path;
  assert.ok(expectedPath, 'A declared HTTP preview target exists');
  assert.equal(website.previewPath, expectedPath);
  assert.equal(website.previewUrl, `${baseUrl.replace(/\/$/, '')}${expectedPath}`);
  for (const page of configured.pages ?? []) assert.ok(website.targets.some(target => target.path === page.path), `Missing declared page ${page.path}`);
  const paths = [...(configured.pages ?? []), ...(configured.feeds ?? []), ...(configured.probes ?? [])].map(target => target.path);
  if (configured.api?.openapi_path) paths.push(configured.api.openapi_path);
  paths.push(...Object.keys(configured.api?.responses ?? {}), '/metrics');
  assert.deepEqual(website.targets.map(target => target.path).sort(), paths.sort(), 'All declared HTTP target paths are preserved');
}

export function assertSlackCount(overview, { stopped = false } = {}) {
  assert.deepEqual(overview.surfaces.map(surface => surface.id), ['slack'], 'The failure fixture selects Slack only');
  const slack = overview.providers.slack;
  if (stopped) {
    assert.equal(slack.messageCount, null, 'A failed Slack read has an unknown count, not zero');
    assert.equal(slack.status, 'error'); assert.equal(slack.available, false);
    assert.ok(typeof slack.error === 'string' && slack.error.length, 'The provider failure is explained');
    assert.equal(slack.collectionStatus.channels.status, 'failed');
    assert.equal(slack.collectionStatus.messageCount.status, 'failed');
    assert.ok(overview.providers.errors.some(error => error.provider === 'slack'), 'The overview retains the Slack failure');
  } else {
    assert.equal(slack.status, 'ready'); assert.equal(slack.available, true);
    assert.equal(slack.collectionStatus.messageCount.status, 'complete');
    assert.ok(Number.isInteger(slack.messageCount) && slack.messageCount > 0, 'The initial Slack read has measured messages');
    assert.equal(slack.messageCount, slack.channels.reduce((sum, channel) => sum + channel.messageCount, 0));
  }
}

export async function readWorkbenchSession(base, { sparse = false, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/api/session`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
  const session = await response.json(); assert.ok(response.ok, `Session read failed: HTTP ${response.status}`);
  if (sparse) assert.equal(session.managed, false, 'The direct runtime sparse fixture is intentionally unmanaged');
  else {
    assert.equal(session.managed, true, 'Normal CLI launch must expose a managed session');
    assert.equal(session.phase, 'ready'); assert.ok(typeof session.generation === 'string' && session.generation.length, 'The session generation is required');
  }
  return session;
}
export async function resetWorkbench(base, generation, { fetchImpl = fetch, signal } = {}) {
  assert.ok(typeof generation === 'string' && generation.length, 'Pin the managed generation before reset');
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorldFixture-Generation': generation }, body: '{}', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000) });
  const body = await response.json(); assert.ok(response.ok && body.ok === true, `Reset refused: HTTP ${response.status}: ${body.code ?? body.error ?? ''}`);
  assert.equal(response.headers.get('X-WorldFixture-Generation'), generation, 'Reset must retain the session generation');
  return { status: response.status, body };
}

export async function probeWorkbench({ artifact, bindings, lock, generation, sparse = false, fetchImpl = fetch, signal }) {
  const checks = [], responses = [];
  const check = async (name, task) => { try { await task(); checks.push({ check: name, status: 'passed' }); } catch (error) { checks.push({ check: name, status: 'failed', detail: error.message }); } };
  const request = async (base, path, token, payload) => {
    const response = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, { method: payload ? 'POST' : 'GET',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'Notion-Version': '2026-03-11', ...(base === bindings.WORKBENCH_URL && generation ? { 'X-WorldFixture-Generation': generation } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
    const raw = await response.text(); responses.push({ path, status: response.status, sha256: sha(raw) });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`); return JSON.parse(raw);
  };
  const overview = await request(bindings.WORKBENCH_URL, '/api/overview');
  await check('workbench.world-and-people', () => {
    assert.equal(overview.world.id, artifact.identity.id); assert.equal(overview.world.version, artifact.identity.version);
    assert.equal(overview.world.artifact_sha256, artifact.identity.digest);
    assert.deepEqual(ids(overview.people), ids(artifact.world.people));
    for (const person of artifact.world.people) assert.equal(overview.people.find(row => row.id === person.id).name, person.name);
    assert.equal(overview.world.worldPeople, artifact.world.people.length);
    assert.equal(overview.world.organizationPeople, artifact.world.people.filter(person => person.organization_id === overview.world.organizationId).length);
  });
  await check('workbench.selected-surfaces-and-bindings', () => {
    const expected = lock.services.flatMap(service => service.name === 'emulate'
      ? [...new Set(Object.values(lock.capabilities).filter(value => value.service === service.name).map(value => value.port))]
      : [service.name === 'http-targets' ? 'http' : service.name]).sort();
    assert.deepEqual(overview.surfaces.map(row => row.id).sort(), expected);
    for (const name of Object.keys(lock.bindings)) assert.ok(Object.hasOwn(overview.bindings, name), `Missing binding ${name}`);
    for (const surface of overview.surfaces) {
      const capabilityIds = Object.entries(lock.capabilities).filter(([, value]) => value.service === surface.service && (surface.service !== 'emulate' || value.port === surface.id)).map(([id]) => id).sort();
      assert.deepEqual([...surface.capabilities].sort(), capabilityIds);
      const bindingIds = Object.entries(lock.bindings).filter(([, value]) => value.service === surface.service && (surface.service !== 'emulate' || value.port === surface.id)).map(([id]) => id).sort();
      assert.deepEqual([...surface.bindingNames].sort(), bindingIds);
    }
    if (sparse) { assert.deepEqual(expected, ['linear', 'notion', 'stripe']); assert.equal(overview.providers.website.status, 'not-selected'); assert.ok(!overview.bindings.SITE_BASE_URL); }
  });
  const stripe = (path, payload) => request(bindings.STRIPE_BASE_URL, path, bindings.STRIPE_TOKEN, payload);
  for (const [field, path] of Object.entries({ customers: 'customers', products: 'products', prices: 'prices', paymentIntents: 'payment_intents', charges: 'charges', subscriptions: 'subscriptions', invoices: 'invoices' })) {
    await check(`workbench.stripe.${field}`, async () => {
      const rows = await readCompletePages(stripe, { kind: 'stripe', path: `/v1/${path}` });
      assert.equal(overview.providers.stripe.collectionStatus[field].status, 'complete');
      assert.deepEqual(ids(overview.providers.stripe[field]), ids(rows));
      for (const row of rows) {
        const actual = overview.providers.stripe[field].find(value => value.id === row.id);
        for (const key of ['name', 'email', 'currency', 'amount', 'amount_due', 'unit_amount', 'status', 'recurring']) if (Object.hasOwn(row, key)) assert.deepEqual(actual[key], row[key]);
      }
    });
  }
  const linear = (path, payload) => request(bindings.LINEAR_BASE_URL, path, bindings.LINEAR_TOKEN, payload);
  for (const [field, query] of Object.entries({ teams: 'id name key', workflowStates: 'id name type', issues: 'id title state { id name type }' })) {
    await check(`workbench.linear.${field}`, async () => {
      const rows = await readCompletePages(linear, { kind: 'linear', field, query }), key = field === 'workflowStates' ? 'states' : field;
      assert.equal(overview.providers.linear.collectionStatus[key].status, 'complete');
      assert.deepEqual(ids(overview.providers.linear[key]), ids(rows));
      for (const row of rows) for (const [field, value] of Object.entries(row)) assert.deepEqual(overview.providers.linear[key].find(value => value.id === row.id)[field], value);
    });
  }
  await check('workbench.notion.pages', async () => {
    const rows = await readCompletePages((path, payload) => request(bindings.NOTION_BASE_URL, path, bindings.NOTION_TOKEN, payload), { kind: 'notion', path: '/v1/search' });
    assert.equal(overview.providers.notion.collectionStatus.pages.status, 'complete');
    assert.deepEqual(ids(overview.providers.notion.pages), ids(rows.filter(row => row.object === 'page')));
    for (const page of rows.filter(row => row.object === 'page')) assert.deepEqual(overview.providers.notion.pages.find(row => row.id === page.id).properties, page.properties);
  });
  await check('workbench.notion.browser-mcp-url', () => {
    assert.equal(overview.bindings.NOTION_BASE_URL, bindings.NOTION_BASE_URL);
    assert.equal(overview.providers.notion.mcpUrl, `${bindings.NOTION_BASE_URL.replace(/\/$/, '')}/mcp`);
  });
  if (bindings.SITE_BASE_URL) await check('workbench.http.target-kinds', () => {
    const configured = artifact.projections['http-targets'];
    assertHttpPreview(overview.providers.website, configured, overview.bindings.SITE_BASE_URL);
    for (const target of [...configured.pages, ...configured.probes].filter(row => row.kind)) {
      assert.equal(overview.providers.website.targets.find(row => row.path === target.path)?.kind, target.kind);
    }
  });
  return { checks, responses, overview };
}

export const WORKBENCH_CASES = [
  ...['business.saas-company.v2', 'business.saas-company.v3', 'consumer.retail-brand.v1'].map(source => ({ name: source, source })),
  { name: 'sparse', source: 'business.saas-company.v2', sparse: true },
  { name: 'variant', source: 'business.saas-company.v2', variant: true },
  { name: 'slack-failure', source: 'business.saas-company.v2', sparse: true, slackFailure: true },
];

export function selectedWorkbenchCases(names) {
  if (names === undefined) return WORKBENCH_CASES;
  assert.ok(names.length > 0 && new Set(names).size === names.length, 'Case names must be nonempty and unique');
  for (const name of names) assert.ok(WORKBENCH_CASES.some(item => item.name === name), `Unknown Workbench case: ${name}`);
  return WORKBENCH_CASES.filter(item => names.includes(item.name));
}

export async function runWorkbenchMatrix({ image, reportPath, python, prepareOnly = false, caseNames, signal }) {
  const cases = selectedWorkbenchCases(caseNames);
  const directory = resolve(reportPath);
  if (existsSync(directory)) throw new Error('Refusing to overwrite existing Workbench evidence');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = randomBytes(12).toString('hex'), report = { api_version: 'worldfixture.workbench-matrix/v1', image, started_at: new Date().toISOString(), cases: [], checks: [], scope: 'Workbench API and metadata. Browser actions/layout require separate evidence.' };
  const save = () => json(join(directory, 'report.json'), report);
  try {
    let imageId, exposedPorts;
    if (!prepareOnly) { const [found] = JSON.parse((await docker(['image', 'inspect', image])).stdout); imageId = found.Id; exposedPorts = Object.keys(found.Config.ExposedPorts); report.image_id = imageId; }
    for (const [index, definition] of cases.entries()) {
      signal?.throwIfAborted();
      const item = { ...definition, checks: [], responses: [], launch: definition.sparse ? 'runtime resolve/start/startWorkbench API' : 'product CLI up --no-rebase' }; report.cases.push(item);
      const name = `wf-workbench-${owner}-${index}`; let secrets = [];
      try {
        const { artifact, evidence } = await prepareWorkbenchCase({ sourcePath: join(ROOT, 'worlds', definition.source, 'world.json'), outputPath: join(directory, `case-${index}`), variant: definition.variant, python, signal });
        item.source_evidence = evidence; item.identity = artifact.identity;
        if (prepareOnly) { item.scope = 'Prepared only; no live proof'; continue; }
        console.log(`${definition.source}${definition.sparse ? ' sparse' : definition.variant ? ' variant' : ''}: starting`);
        let args = containerArguments({ image: imageId, artifactPath: artifact.path, name, owner, exposedPorts });
        if (definition.variant) {
          const overlay = linearStateOverlay(artifact), overlayPath = join(directory, `case-${index}`, 'linear-native-seed-overlay.json');
          json(overlayPath, overlay);
          item.native_seed_fixture = { path: overlayPath, sha256: sha(readFileSync(overlayPath)), state: TRANSLATED_STATE,
            scope: 'Normal WORLDFIXTURE_SEED_OVERLAY adds one test state and retains all source teams/states. This is native seed API evidence, not compiler support for authored custom states.' };
          args.splice(args.indexOf('--entrypoint'), 0, '--env', `WORLDFIXTURE_SEED_OVERLAY=${JSON.stringify(overlay)}`);
        }
        if (definition.sparse) {
          const script = join(directory, `case-${index}`, 'sparse-entry.mjs'); writeFileSync(script, sparseEntryScript({ slackOnly: definition.slackFailure }));
          const entry = args.indexOf('--entrypoint'); args.splice(entry, 0, '--mount', `type=bind,src=${script},dst=/p3-entry.mjs,readonly`);
          args = [...args.slice(0, args.indexOf(imageId) + 1), '--', 'node', '/p3-entry.mjs'];
        }
        await docker(args, { timeout: 60000, signal }); await waitForReady(name, { timeoutMs: 360000, signal });
        if (!definition.sparse) await pauseRunClock(name);
        const [inspection] = JSON.parse((await docker(['inspect', name])).stdout), bindings = mappedBindings(await readRunBindings(name), inspection.NetworkSettings.Ports);
        secrets = credentialValues(bindings);
        // Mirror the host launcher's normal browser binding file. Keep current
        // credentials out of command arguments and persistent report files.
        const temporary = mkdtempSync(join(tmpdir(), 'workbench-browser-bindings-'));
        try {
          const path = join(temporary, 'host-bindings.json'); json(path, bindings);
          await docker(['cp', path, `${name}:/state/host-bindings.json`]);
        } finally { rmSync(temporary, { recursive: true, force: true }); }
        item.browser_bindings = { mode: 'host-bindings.json from published loopback ports', names: Object.keys(bindings).sort() };
        const lock = JSON.parse((await docker(['exec', name, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/state/environment.lock.json','utf8'))"])).stdout);
        if (definition.variant) {
          const gql = async query => {
            const response = await fetch(`${bindings.LINEAR_BASE_URL}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${bindings.LINEAR_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
            const value = await response.json(); item.responses.push({ path: '/graphql', phase: 'translated native seed state', status: response.status, sha256: sha(JSON.stringify(value)) });
            assert.ok(response.ok && !value.errors?.length, JSON.stringify(value.errors)); return value.data;
          };
          const before = await gql('query { issues(first:1) {nodes {id title state {id}}} }');
          const issue = before.issues.nodes[0]; assert.ok(issue);
          const changed = await gql(`mutation { issueUpdate(id:${JSON.stringify(issue.id)},input:{stateId:${JSON.stringify(TRANSLATED_STATE.id)}}) {success issue {id state {id name type}}} }`);
          assert.equal(changed.issueUpdate.success, true); assert.equal(changed.issueUpdate.issue.state.name, TRANSLATED_STATE.name);
          item.native_seed_fixture.issue = { id: issue.id, original_state_id: issue.state.id, state: changed.issueUpdate.issue.state };
          item.checks.push({ check: 'workbench.linear.native-state-public-issue-update', status: 'passed' });
        }
        const session = await readWorkbenchSession(bindings.WORKBENCH_URL, { sparse: definition.sparse, signal });
        const generation = session.generation; item.session = session;
        item.checks.push({ check: 'workbench.session-contract', status: 'passed' });
        let result;
        if (definition.slackFailure) {
          const response = await fetch(`${bindings.WORKBENCH_URL}/api/overview`, { signal: AbortSignal.timeout(60000) });
          assert.ok(response.ok); const overview = await response.json();
          assert.equal(overview.world.artifact_sha256, artifact.identity.digest);
          assertSlackCount(overview);
          result = { overview, checks: [{ check: 'workbench.slack.initial-count-measured', status: 'passed' }],
            responses: [{ path: '/api/overview', phase: 'before normal supervisor stopChildren(emulate)', status: response.status, sha256: sha(JSON.stringify(overview)), slack: overview.providers.slack }] };
        } else result = await probeWorkbench({ artifact, bindings, lock, generation, sparse: definition.sparse, signal });
        item.checks.push(...result.checks); item.responses.push(...result.responses);
        json(join(directory, `case-${index}`, 'overview.json'), redact(result.overview, secrets));
        if (definition.variant) {
          const target = await fetch(`${bindings.SITE_BASE_URL}${VARIANT_SITE.pages[0].path}`, { signal: AbortSignal.timeout(30000) }), body = await target.text();
          assert.ok(target.ok && body.includes(VARIANT_SITE.pages[0].heading), 'Custom-kind target returns its authored heading');
          assert.ok(body.includes(VARIANT_SITE.pages[0].body), 'Custom-kind target returns its authored body');
          item.responses.push({ path: VARIANT_SITE.pages[0].path, status: target.status, sha256: sha(body) });
          item.checks.push({ check: 'workbench.http.custom-kind-public-content', status: 'passed' });
          const response = await resetWorkbench(bindings.WORKBENCH_URL, generation, { signal });
          await pauseRunClock(name);
          const freshResponse = await fetch(`${bindings.WORKBENCH_URL}/api/overview`, { headers: generation ? { 'X-WorldFixture-Generation': generation } : {}, signal: AbortSignal.timeout(60000) });
          assert.ok(freshResponse.ok); const fresh = await freshResponse.json();
          assert.equal(fresh.world.artifact_sha256, artifact.identity.digest);
          assert.ok(fresh.surfaces.every(surface => surface.state === 'ready'));
          assert.equal(fresh.providers.linear.issues.find(row => row.id === item.native_seed_fixture.issue.id)?.state.id, item.native_seed_fixture.issue.original_state_id);
          assert.equal(fresh.providers.linear.states.find(row => row.id === TRANSLATED_STATE.id)?.name, TRANSLATED_STATE.name);
          item.responses.push({ path: '/api/reset', status: response.status, ok: true }, { path: '/api/overview', phase: 'after reset', status: freshResponse.status, sha256: sha(JSON.stringify(fresh)) });
          item.checks.push({ check: 'workbench.native-state-reset', status: 'passed' });
        }
        if (definition.sparse) {
          await docker(['exec', name, 'node', '-e', "process.kill(Number(require('fs').readFileSync('/state/p3-runner.pid','utf8')),'SIGUSR2')"]);
          let stopped = false;
          for (let attempt = 0; attempt < 60; attempt++) { signal?.throwIfAborted(); try { await docker(['exec', name, 'test', '-f', '/state/p3-stopped']); stopped = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } }
          assert.ok(stopped, 'Normal supervisor stop finished');
          const response = await fetch(`${bindings.WORKBENCH_URL}/api/overview`, { headers: generation ? { 'X-WorldFixture-Generation': generation } : {}, signal: AbortSignal.timeout(60000) }); const failed = await response.json();
          assert.ok(response.ok);
          if (definition.slackFailure) {
            assertSlackCount(failed, { stopped: true });
            item.checks.push({ check: 'workbench.slack.stopped-count-unknown', status: 'passed' });
            item.responses.push({ path: '/api/overview', phase: 'after normal supervisor stopChildren(emulate)', status: response.status, sha256: sha(JSON.stringify(failed)), slack: failed.providers.slack, errors: failed.providers.errors });
          } else {
            for (const provider of ['stripe', 'linear', 'notion']) assert.ok(failed.providers[provider].status === 'error' && failed.providers[provider].available === false, `${provider} failed read must be unavailable`);
            item.checks.push({ check: 'workbench.stopped-providers-unavailable', status: 'passed' });
            item.responses.push({ path: '/api/overview', phase: 'after normal supervisor stopChildren(emulate)', status: response.status, unavailable: ['stripe', 'linear', 'notion'] });
          }
        }
      } catch (error) {
        item.checks.push({ check: 'workbench.case', status: 'failed', detail: error.message });
        if (!prepareOnly) try {
          const progress = await docker(['exec', name, 'node', '-e', "process.stdout.write(require('fs').readFileSync('/state/progress.json','utf8'))"]);
          item.startup_progress = JSON.parse(progress.stdout);
        } catch { /* A preflight failure may occur before progress is written. */ }
      }
      finally {
        if (!prepareOnly) {
          try { const values = await readRunCredentialSet(name); secrets.push(...Object.values(values.values ?? {})); } catch { /* A preflight failure may occur before credentials exist. */ }
          try { const logs = await docker(['logs', '--tail', '250', name]); writeFileSync(join(directory, `case-${index}.log`), redact(logs.stdout + logs.stderr, secrets)); } catch { /* Startup may not have created a container. */ }
          try { await removeOwnedContainer(name, owner); } catch (error) { item.checks.push({ check: 'workbench.cleanup', status: 'failed', detail: error.message }); }
        }
        Object.assign(item, redact(item, secrets)); save();
      }
    }
  } catch (error) { report.checks.push({ check: 'workbench.matrix', status: 'failed', detail: error.message }); }
  report.finished_at = new Date().toISOString();
  report.failed_checks = [...report.checks, ...report.cases.flatMap(item => item.checks)].filter(item => item.status === 'failed').length;
  report.status = report.failed_checks ? 'failed' : prepareOnly ? 'prepared' : 'passed'; save(); return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { image: { type: 'string' }, report: { type: 'string' }, python: { type: 'string' }, case: { type: 'string', multiple: true }, 'prepare-only': { type: 'boolean', default: false } } });
  if (!values.report || (!values.image && !values['prepare-only'])) throw new Error('--report and --image are required (--prepare-only omits image)');
  const abort = new AbortController(); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(signal)));
  const report = await runWorkbenchMatrix({ image: values.image, reportPath: values.report, python: values.python, prepareOnly: values['prepare-only'], caseNames: values.case, signal: abort.signal });
  console.log(`Workbench matrix ${report.status}: ${report.failed_checks} failures`); process.exitCode = report.failed_checks ? 1 : 0;
}
