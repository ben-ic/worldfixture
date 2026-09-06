import assert from 'node:assert/strict';
import test from 'node:test';
import { probeRelationshipsWorld } from './coupling-relationships-probes.mjs';

const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const find = (result, name) => result.checks.find(check => check.check === name);
const people = [{ id: 'p.1', email: 'one@world.test', github_login: 'one' }, { id: 'p.2', email: 'two@world.test', github_login: 'two' }];
const slackArtifact = () => ({ world: { people, communication: { channels: [{ id: 'ch.source', name: 'stones', member_ids: ['p.1', 'p.2'] }], bots: [{ name: 'helper' }] } }, projections: { slack: { bots: [{ name: 'helper' }] } } });
function slackFetch(calls = [], override = () => null) {
  return async (url, options) => {
    const path = new URL(url).pathname, fields = new URLSearchParams(options.body);
    calls.push({ path, fields: Object.fromEntries(fields), auth: options.headers.authorization });
    const custom = override(path, fields, options); if (custom) return custom;
    if (options.headers.authorization !== 'Bearer current') return response({ ok: false, error: 'invalid_auth' });
    if (path === '/api/users.list') return response({ ok: true, members: fields.get('cursor') ? [{ id: 'U2', profile: { email: people[1].email } }, { id: 'UB', name: 'helper', is_bot: true, bot_profile: { id: 'B1' } }]
      : [{ id: 'U1', profile: { email: people[0].email } }], response_metadata: { next_cursor: fields.get('cursor') ? '' : 'user-next' } });
    if (path === '/api/conversations.list') return response({ ok: true, channels: [{ id: 'C1', name: 'stones' }], response_metadata: { next_cursor: '' } });
    if (path === '/api/conversations.members') return response({ ok: true, members: fields.get('cursor') ? ['U2'] : ['U1'], response_metadata: { next_cursor: fields.get('cursor') ? '' : 'member-next' } });
    if (path === '/api/conversations.history') return response({ ok: true, messages: [], response_metadata: { next_cursor: '' } });
    if (path === '/api/bots.info') { assert.equal(fields.get('bot'), 'B1'); return response({ ok: true, bot: { id: 'B1', name: 'helper' } }); }
    if (path === '/api/auth.test') return response({ ok: true, user_id: 'U1' });
    throw new Error(`Unexpected route ${path}`);
  };
}
const slackBindings = { SLACK_BASE_URL: 'http://slack.test', SLACK_TOKEN: 'current' };

test('Slack compares paginated channel memberships and resolves source bots through bots.info', async () => {
  const calls = [];
  const result = await probeRelationshipsWorld({ artifact: slackArtifact(), bindings: slackBindings, fetchImpl: slackFetch(calls) });
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
  assert.equal(calls.filter(call => call.path === '/api/conversations.members').length, 2);
  assert.ok(result.coverage.some(entry => entry.collection === 'communication.bots' && entry.status === 'passed'));
  assert.ok(result.coverage.some(entry => entry.collection === 'communication.channels[].member_ids' && entry.status === 'passed'));
});

test('Slack detects missing and foreign channel members', async () => {
  for (const members of [['U1'], ['U1', 'FOREIGN']]) {
    const result = await probeRelationshipsWorld({ artifact: slackArtifact(), bindings: slackBindings,
      fetchImpl: slackFetch([], (path, _fields, options) => path === '/api/conversations.members' && options.headers.authorization === 'Bearer current' ? response({ ok: true, members, response_metadata: { next_cursor: '' } }) : null) });
    assert.equal(find(result, 'slack.source-members.ch.source').status, 'failed');
    assert.equal(find(result, 'relationships.slack.read').status, 'failed');
  }
});

test('Slack bot content and unavailable bot identity mappings fail separately', async () => {
  const changed = await probeRelationshipsWorld({ artifact: slackArtifact(), bindings: slackBindings,
    fetchImpl: slackFetch([], path => path === '/api/bots.info' ? response({ ok: true, bot: { id: 'B1', name: 'foreign-bot' } }) : null) });
  assert.equal(find(changed, 'slack.source-bots').status, 'failed');
  const missing = await probeRelationshipsWorld({ artifact: slackArtifact(), bindings: slackBindings,
    fetchImpl: slackFetch([], (path, _fields, options) => path === '/api/users.list' && options.headers.authorization === 'Bearer current'
      ? response({ ok: true, members: [{ id: 'U1', profile: { email: people[0].email } }, { id: 'U2', profile: { email: people[1].email } }], response_metadata: { next_cursor: '' } }) : null) });
  assert.equal(find(missing, 'slack.bot-identity.helper').failure_kind, 'identity_mapping_missing');
  assert.ok(missing.coverage.some(entry => entry.collection === 'communication.bots' && entry.status === 'failed'));
});

test('Slack refuses an incomplete cursor sequence with API evidence', async () => {
  const result = await probeRelationshipsWorld({ artifact: slackArtifact(), bindings: slackBindings,
    fetchImpl: slackFetch([], (path, _fields, options) => path === '/api/conversations.members' && options.headers.authorization === 'Bearer current'
      ? response({ ok: true, members: ['U1'], has_more: true }) : null) });
  assert.ok(result.checks.some(check => check.status === 'failed' && check.detail?.includes('cursor is missing')));
  assert.ok(result.responses.some(entry => entry.path === '/api/conversations.members'));
});

const linearArtifact = () => ({ world: { profile: 'business.operations/v1', people: people.map((person, index) => ({...person, primary: index === 0})), organizations: [{id: 'test-org', primary: true}], communication: {channels: [], mail: []}, software: {}, support: {}, agentic: {}, stories: [], finance: {history_months: 0, currency: 'USD', customers: [], suppliers: [], anchor_invoices: [], billing_owner_id: 'p.1'}, work: { projects: [], tasks: [
  { id: 'task.1', title: 'Duplicate', description: 'First', assignee_id: 'p.1', labels: ['alpha', 'beta'], status: 'ready', priority: 'urgent' },
  { id: 'task.2', title: 'Duplicate', description: 'Second', assignee_id: 'p.2', labels: ['beta'], status: 'blocked', priority: 'normal' },
] } } });
const label = name => ({ id: `label-${name}`, name });
const connection = (nodes, next = null) => ({ nodes, pageInfo: { hasNextPage: Boolean(next), endCursor: next } });
function linearFetch(calls = [], override = () => null) {
  return async (url, options) => {
    assert.equal(new URL(url).pathname, '/graphql');
    const query = JSON.parse(options.body).query; calls.push({ query, auth: options.headers.authorization });
    const custom = override(query, options); if (custom) return custom;
    if (options.headers.authorization !== 'Bearer current') return response({ errors: [{ message: 'Authentication required', extensions: { code: 'UNAUTHENTICATED' } }] });
    if (query.includes('viewer')) return response({ data: { viewer: { id: 'U1', email: people[0].email } } });
    if (query.includes('issueLabels(')) return response({ data: { issueLabels: query.includes('after:') ? connection(['urgent', 'blocked'].map(label)) : connection(['alpha', 'beta'].map(label), 'labels-next') } });
    if (query.includes('issues(')) return response({ data: { issues: query.includes('after:') ? connection([{ id: 'I2', title: 'Duplicate', description: 'Second\nProject detail', assignee: { email: people[1].email } }])
      : connection([{ id: 'I1', title: 'Duplicate', description: 'First\nProject detail', assignee: { email: people[0].email } }], 'issues-next') } });
    if (query.includes('"I1"')) return response({ data: { issue: { labels: query.includes('after:') ? connection([label('urgent')]) : connection(['alpha', 'beta'].map(label), 'issue-labels-next') } } });
    if (query.includes('"I2"')) return response({ data: { issue: { labels: connection(['beta', 'blocked'].map(label)) } } });
    throw new Error(`Unexpected query ${query}`);
  };
}
const linearBindings = { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' };

test('Linear reads paginated label inventory and per-task labels without title deduplication', async () => {
  const calls = [];
  const result = await probeRelationshipsWorld({ artifact: linearArtifact(), bindings: linearBindings, fetchImpl: linearFetch(calls) });
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
  assert.equal(find(result, 'linear.source-task-labels.task.1').status, 'passed');
  assert.equal(find(result, 'linear.source-task-labels.task.2').status, 'passed');
  assert.ok(calls.some(call => call.query.includes('after: "issue-labels-next"')));
  assert.equal(find(result, 'credentials.sample-bearer.linear.lin_test_admin').status, 'passed');
});

test('Linear catches missing, foreign, and mismatched label relationships', async () => {
  for (const labels of [[label('beta')], [label('beta'), label('foreign')], [label('beta'), { id: 'wrong-reference', name: 'blocked' }]]) {
    const result = await probeRelationshipsWorld({ artifact: linearArtifact(), bindings: linearBindings,
      fetchImpl: linearFetch([], (query, options) => options.headers.authorization === 'Bearer current' && query.includes('issue(id: "I2")')
        ? response({ data: { issue: { labels: connection(labels) } } }) : null) });
    assert.equal(find(result, 'relationships.linear.task-labels.task.2.read').status, 'failed');
    assert.ok(result.coverage.some(entry => entry.collection === 'work.tasks[].labels' && entry.status === 'failed'));
  }
});

test('Linear does not use expected labels to choose between ambiguous task identities', async () => {
  const artifact = linearArtifact(); artifact.world.work.tasks[1] = { ...artifact.world.work.tasks[0], id: 'task.2' };
  const result = await probeRelationshipsWorld({ artifact, bindings: linearBindings,
    fetchImpl: linearFetch([], (query, options) => options.headers.authorization === 'Bearer current' && query.includes('issues(')
      ? response({ data: { issues: connection(['I1', 'I2'].map(id => ({ id, title: 'Duplicate', description: 'First', assignee: { email: people[0].email } }))) } }) : null) });
  assert.equal(find(result, 'linear.task-label-identity.task.1').failure_kind, 'identity_mapping_missing');
});

test('accepted lin_test_admin fails while a route error cannot count as token rejection', async () => {
  const accepted = await probeRelationshipsWorld({ artifact: linearArtifact(), bindings: linearBindings,
    fetchImpl: linearFetch([], (_query, options) => options.headers.authorization === 'Bearer lin_test_admin' ? response({ data: { viewer: { id: 'sample-admin' } } }) : null) });
  assert.equal(find(accepted, 'credentials.sample-bearer.linear.lin_test_admin').status, 'failed');
  const unavailable = await probeRelationshipsWorld({ artifact: { world: {} }, bindings: { RESEND_BASE_URL: 'http://resend.test', RESEND_TOKEN: 'current' }, fetchImpl: async () => response({}, 404) });
  assert.equal(find(unavailable, 'relationships.resend.sample-bearers.read').status, 'failed');
  assert.ok(!unavailable.checks.some(check => check.check.startsWith('credentials.sample-bearer.')));
});

test('GitHub collaborator pagination checks source logins and preserves missing-route evidence', async () => {
  const artifact = { world: { people, organizations: [{ id: 'org.1', slug: 'quarry' }], software: { repositories: [{ id: 'repo.1', owner_id: 'org.1', name: 'stones', member_ids: ['p.1', 'p.2'] }] } } };
  for (const missing of [false, true]) {
    const result = await probeRelationshipsWorld({ artifact, bindings: { GITHUB_BASE_URL: 'http://github.test', GITHUB_TOKEN: 'current' }, fetchImpl: async (url, options) => {
      if (options.headers.authorization !== 'Bearer current') return response({}, 401);
      const parsed = new URL(url);
      if (parsed.pathname === '/user') return response({ login: 'one' });
      assert.equal(parsed.pathname, '/repos/quarry/stones/collaborators');
      if (missing) return response({ message: 'Not Found' }, 404);
      return parsed.searchParams.get('page') === '2' ? response([{ login: 'two' }]) : response([{ login: 'one' }], 200, { link: '<http://github.test/repos/quarry/stones/collaborators?page=2>; rel="next"' });
    } });
    assert.ok(result.coverage.some(entry => entry.collection === 'software.repositories[].member_ids' && entry.status === (missing ? 'failed' : 'passed')));
    if (missing) assert.ok(result.responses.some(entry => entry.status === 404));
  }
});

test('Linear task labels use exact receipt IDs when source contents are identical', async () => {
  const artifact = linearArtifact();
  artifact.world.id = 'consumer.odd'; artifact.world.version = 'v1';
  artifact.identity = { id: artifact.world.id, version: artifact.world.version, digest: 'a'.repeat(64) };
  artifact.projections = { 'emulator-overlay': { linear: { worldfixture_seed_version: 1 } } };
  artifact.world.work.tasks[1] = { ...artifact.world.work.tasks[0], id: 'task.2', labels: ['beta'], status: 'blocked', priority: 'normal' };
  const receipt = { api_version: 'worldfixture.linear-seed-receipt/v1', world: artifact.identity, issues: [
    { source_task_id: 'task.1', provider_issue_id: 'I1' }, { source_task_id: 'task.2', provider_issue_id: 'I2' },
  ] };
  const base = linearFetch([], (query, options) => options.headers.authorization === 'Bearer current' && query.includes('issues(')
    ? response({ data: { issues: connection(['I1', 'I2'].map(id => ({ id, title: 'Duplicate', description: 'First', assignee: { email: people[0].email } }))) } }) : null);
  const fetchImpl = (url, options) => new URL(url).pathname === '/_worldfixture/seed-receipt' ? Promise.resolve(response(receipt)) : base(url, options);
  const result = await probeRelationshipsWorld({ artifact, bindings: linearBindings, fetchImpl });
  assert.equal(find(result, 'linear.source-task-labels.task.1').status, 'passed');
  assert.equal(find(result, 'linear.source-task-labels.task.2').status, 'passed');
  receipt.issues.reverse(); receipt.issues[0].provider_issue_id = 'I1'; receipt.issues[1].provider_issue_id = 'I2';
  const swapped = await probeRelationshipsWorld({ artifact, bindings: linearBindings, fetchImpl });
  assert.equal(find(swapped, 'linear.source-task-labels.task.1').status, 'failed');
  assert.equal(find(swapped, 'relationships.linear.read').status, 'failed');
});

test('Linear receipt HTTP failure produces failed relationship evidence', async () => {
  const artifact = linearArtifact();
  artifact.projections = { 'emulator-overlay': { linear: { worldfixture_seed_version: 1 } } };
  const base = linearFetch();
  const result = await probeRelationshipsWorld({ artifact, bindings: linearBindings, fetchImpl: (url, options) => new URL(url).pathname === '/_worldfixture/seed-receipt'
    ? Promise.resolve(new Response('down', { status: 503 })) : base(url, options) });
  assert.equal(find(result, 'relationships.linear.read').status, 'failed');
  assert(result.coverage.some(row => row.collection === 'work.tasks[].labels' && row.status === 'failed'));
  assert(result.responses.some(row => row.path === '/_worldfixture/seed-receipt' && row.status === 503));
});

test('profile-less Linear preserves authored labels without adding English status or priority labels', async () => {
  const artifact = linearArtifact(); delete artifact.world.profile;
  const base = linearFetch([], (query, options) => {
    if (options.headers.authorization !== 'Bearer current') return null;
    if (query.includes('issueLabels(')) return response({data: {issueLabels: connection(['alpha', 'beta'].map(label))}});
    if (query.includes('issue(id: "I1")')) return response({data: {issue: {labels: connection(['alpha', 'beta'].map(label))}}});
    if (query.includes('issue(id: "I2")')) return response({data: {issue: {labels: connection([label('beta')])}}});
    return null;
  });
  const result = await probeRelationshipsWorld({artifact, bindings: linearBindings, fetchImpl: base});
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  const extra = await probeRelationshipsWorld({artifact, bindings: linearBindings, fetchImpl: linearFetch()});
  assert.equal(find(extra, 'linear.source-label-inventory').status, 'failed');
});

test('GitHub member checks derive missing native logins from canonical source IDs', async () => {
  const {sourceGithubLogin} = await import('./coupling-source-contracts.mjs');
  const person = {id: 'person-47.uncommon', name: 'Tavi'};
  const artifact = {world: {people: [person], organizations: [{id: 'org-a'}], software: {repositories: [{id: 'repo-a', owner_id: 'org-a', member_ids: [person.id]}]}}};
  const result = await probeRelationshipsWorld({artifact, bindings: {GITHUB_BASE_URL: 'http://github.test', GITHUB_TOKEN: 'current'}, fetchImpl: async (url, options) => {
    if (options.headers.authorization !== 'Bearer current') return response({error: 'unauthorized'}, 401);
    return response(new URL(url).pathname === '/user' ? {login: sourceGithubLogin(person)} : [{login: sourceGithubLogin(person)}]);
  }});
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
});
