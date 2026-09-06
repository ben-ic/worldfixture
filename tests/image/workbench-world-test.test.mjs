import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { assertHttpPreview, assertSlackCount, linearStateOverlay, prepareWorkbenchCase, readCompletePages, readWorkbenchSession, resetWorkbench, selectedWorkbenchCases, sparseEntryScript, TRANSLATED_STATE, VARIANT_PERSON_ID, VARIANT_SITE } from './workbench-world-test.mjs';

test('independent public pagination rejects lost, duplicate, and failed pages', async () => {
  const paths = [];
  const rows = await readCompletePages(async path => {
    paths.push(path); return paths.length === 1 ? { data: [{ id: 'one' }], has_more: true } : { data: [{ id: 'two' }], has_more: false };
  }, { kind: 'stripe', path: '/v1/subscriptions' });
  assert.deepEqual(rows.map(row => row.id), ['one', 'two']);
  assert.match(paths[1], /starting_after=one/); assert.ok(paths.every(path => path.includes('status=all')));
  await assert.rejects(readCompletePages(async () => ({ data: [{ id: 'one' }], has_more: true }), { kind: 'stripe', path: '/v1/customers' }), /duplicate/);
  await assert.rejects(readCompletePages(async () => ({ data: [] }), { kind: 'stripe', path: '/v1/customers' }), /metadata/);
  let count = 0;
  await assert.rejects(readCompletePages(async () => { if (count++) throw new Error('HTTP 503'); return { data: [{ id: 'one' }], has_more: true }; }, { kind: 'stripe', path: '/v1/customers' }), /HTTP 503/);
});

test('Linear and Notion use their actual cursors and reject repeated cursors', async () => {
  const queries = [];
  const linear = await readCompletePages(async (_path, body) => {
    queries.push(body.query); return { data: { workflowStates: { nodes: [{ id: String(queries.length) }], pageInfo: { hasNextPage: queries.length === 1, endCursor: 'opaque:47' } } } };
  }, { kind: 'linear', field: 'workflowStates', query: 'id name' });
  assert.equal(linear.length, 2); assert.match(queries[1], /after:"opaque:47"/);
  const bodies = [];
  await readCompletePages(async (_path, body) => { bodies.push(body); return { results: [{ id: String(bodies.length) }], has_more: bodies.length === 1, next_cursor: 'notion-next' }; }, { kind: 'notion', path: '/v1/search' });
  assert.equal(bodies[1].start_cursor, 'notion-next');
  let count = 0;
  await assert.rejects(readCompletePages(async () => ({ data: { issues: { nodes: [{ id: String(count++) }], pageInfo: { hasNextPage: true, endCursor: 'same' } } } }), { kind: 'linear', field: 'issues', query: 'id' }), /cursor/);
});

test('native translated state fixture retains original teams and states without changing the artifact', () => {
  const artifact = { projections: { 'emulator-overlay': { linear: { teams: [{ key: 'P3', states: [{ name: 'Todo', type: 'unstarted' }] }, { key: 'OTHER', states: [] }] } } } };
  const before = structuredClone(artifact), overlay = linearStateOverlay(artifact);
  assert.deepEqual(artifact, before); assert.deepEqual(overlay.linear.teams[0].states, [...before.projections['emulator-overlay'].linear.teams[0].states, TRANSLATED_STATE]);
  assert.deepEqual(overlay.linear.teams[1], before.projections['emulator-overlay'].linear.teams[1]);
  assert.match(sparseEntryScript(), /stopChildren\(\{services:\['emulate'\]\}\)/);
  assert.doesNotMatch(sparseEntryScript(), /notion.file-uploads|http.public-site/);
});

test('HTTP preview uses the authored path and retains an authored root target', () => {
  const website = { status: 'ready', available: true, previewPath: '/p3/kind', previewUrl: 'http://local/p3/kind', targets: ['/p3/kind', '/', '/feed', '/health', '/schema', '/api/data', '/metrics'].map(path => ({ path })) };
  const configured = { pages: [{ path: '/p3/kind' }, { path: '/' }], feeds: [{ path: '/feed' }], probes: [{ path: '/health' }], api: { openapi_path: '/schema', responses: { '/api/data': {} } } };
  assertHttpPreview(website, configured, 'http://local');
  assert.throws(() => assertHttpPreview({ ...website, previewPath: '/' }, configured, 'http://local'));
  assert.throws(() => assertHttpPreview({ ...website, targets: [{ path: '/p3/kind' }] }, configured, 'http://local'), /Missing declared page/);
  assert.throws(() => assertHttpPreview({ ...website, available: false }, configured, 'http://local'), /available/);
  assert.throws(() => assertHttpPreview({ ...website, targets: website.targets.filter(target => target.path !== '/feed') }, configured, 'http://local'), /All declared HTTP/);
});

test('focused retries retain named case scope and reject unknown or repeated names', () => {
  assert.equal(selectedWorkbenchCases().length, 6);
  assert.deepEqual(selectedWorkbenchCases(['sparse']).map(item => [item.name, item.sparse]), [['sparse', true]]);
  assert.deepEqual(selectedWorkbenchCases(['variant']).map(item => item.name), ['variant']);
  assert.deepEqual(selectedWorkbenchCases(['slack-failure']).map(item => [item.sparse, item.slackFailure]), [[true, true]]);
  assert.throws(() => selectedWorkbenchCases(['unknown']), /Unknown/);
  assert.throws(() => selectedWorkbenchCases(['sparse', 'sparse']), /unique/);
  assert.throws(() => selectedWorkbenchCases([]), /nonempty/);
});

test('Slack failure proof rejects a fabricated zero or a falsely available provider', () => {
  const overview = { surfaces: [{ id: 'slack' }], providers: { slack: { status: 'ready', available: true, messageCount: 3,
    channels: [{ messageCount: 1 }, { messageCount: 2 }], collectionStatus: { messageCount: { status: 'complete' } } }, errors: [] } };
  assertSlackCount(overview);
  const stopped = structuredClone(overview);
  Object.assign(stopped.providers.slack, { status: 'error', available: false, messageCount: null, channels: [], error: 'Connection refused',
    collectionStatus: { channels: { status: 'failed' }, messageCount: { status: 'failed' } } });
  stopped.providers.errors.push({ provider: 'slack', message: 'Connection refused' });
  assertSlackCount(stopped, { stopped: true });
  for (const change of [{ messageCount: 0 }, { status: 'ready' }, { available: true }, { error: null }]) {
    const invalid = structuredClone(stopped); Object.assign(invalid.providers.slack, change);
    assert.throws(() => assertSlackCount(invalid, { stopped: true }));
  }
  assert.throws(() => assertSlackCount(stopped));
  const script = sparseEntryScript({ slackOnly: true });
  assert.match(script, /slack\.messaging\.v1/);
  assert.match(script, /stopChildren\(\{services:\['emulate'\]\}\)/);
  assert.doesNotMatch(script, /stripe\.customers|linear\.issues|notion\.pages/);
});

test('frozen source identity/HTTP variant is deterministic and cannot change shipped source bytes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-variant-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = resolve('worlds/business.saas-company.v2/world.json'), before = readFileSync(sourcePath);
  const one = await prepareWorkbenchCase({ sourcePath, outputPath: join(directory, 'one'), variant: true });
  const two = await prepareWorkbenchCase({ sourcePath, outputPath: join(directory, 'two'), variant: true });
  assert.equal(one.artifact.identity.digest, two.artifact.identity.digest);
  assert.equal(one.artifact.world.people.find(person => person.primary).id, VARIANT_PERSON_ID);
  assert.equal(one.artifact.world.people.find(person => person.primary).name, 'Tavi');
  assert.deepEqual(one.artifact.world.site, VARIANT_SITE);
  assert.equal(one.artifact.projections['http-targets'].pages[0].kind, VARIANT_SITE.pages[0].kind);
  assert.deepEqual(readFileSync(sourcePath), before);
  await assert.rejects(prepareWorkbenchCase({ sourcePath, outputPath: join(directory, 'one') }), /already exists/);
});


test('Workbench reset uses the pinned managed generation and never retries a stale refusal', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/session')) return Response.json({ managed: true, phase: 'ready', generation: 'pinned' });
    return Response.json({ ok: true }, { headers: { 'X-WorldFixture-Generation': 'pinned' } });
  };
  const session = await readWorkbenchSession('http://workbench.test', { fetchImpl });
  const result = await resetWorkbench('http://workbench.test', session.generation, { fetchImpl });
  assert.equal(result.status, 200); assert.equal(calls[1].options.headers['X-WorldFixture-Generation'], 'pinned');
  let refused = 0;
  await assert.rejects(resetWorkbench('http://workbench.test', session.generation, { fetchImpl: async (_url, options) => {
    refused++; assert.equal(options.headers['X-WorldFixture-Generation'], 'pinned');
    return Response.json({ error: 'Old generation', code: 'stale_generation' }, { status: 409 });
  } }), /stale_generation/);
  assert.equal(refused, 1);
  await assert.rejects(resetWorkbench('http://workbench.test', undefined, { fetchImpl }), /Pin the managed generation/);
  assert.equal(calls.length, 2, 'No write occurs without the expected generation');
});
test('Workbench session contract distinguishes explicit sparse runtime from normal CLI mode', async () => {
  const fetchImpl = async () => Response.json({ managed: false, generation: null, phase: 'ready' });
  assert.equal((await readWorkbenchSession('http://workbench.test', { sparse: true, fetchImpl })).managed, false);
  await assert.rejects(readWorkbenchSession('http://workbench.test', { fetchImpl }), /managed session/);
  await assert.rejects(readWorkbenchSession('http://workbench.test', { fetchImpl: async () => Response.json({ managed: true, phase: 'ready' }) }), /generation is required/);
});
