import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { paginate, probeLinearWorld, probeWorld, verifyAppleIdentity } from './coupling-probes.mjs';

const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const artifact = () => ({ world: {
  people: [{ id: 'mono', name: 'Mono', email: 'mono@alien.test', primary: true, organization_id: 'alien' }],
  organizations: [{ id: 'alien', primary: true }],
  communication: { channels: [{ id: 'channel-orbit', name: 'orbit', messages: [{ id: 'm1', author_id: 'mono', text: 'Baseline' }] }] },
  timeline: [{ kind: 'chat-message', after_seconds: 0, payload: { channel_id: 'channel-orbit', author_id: 'mono', text: 'Arrival' } }],
}, projections: {} });
const slack = (messages, { extraUser = false, secondPageError = false } = {}) => async (url, options) => {
  const cursor = options.body.get('cursor');
  if (url.includes('users.list')) {
    if (!cursor) return response({ ok: true, members: [{ id: 'U1', profile: { email: 'mono@alien.test' } }], response_metadata: { next_cursor: 'second' } });
    if (secondPageError) return response({ ok: false, error: 'invalid_cursor' });
    return response({ ok: true, members: extraUser ? [{ id: 'FOREIGN', profile: { email: 'foreign@other.test' } }] : [], response_metadata: { next_cursor: '' } });
  }
  if (url.includes('conversations.list')) return response({ ok: true, channels: [{ id: 'C1', name: 'orbit' }] });
  if (url.includes('conversations.history')) return response({ ok: true, messages: messages.map(text => ({ user: 'U1', text })) });
  throw new Error(`Unexpected URL ${url}`);
};
const slackProbe = (messages, options) => probeWorld({ artifact: artifact(), bindings: { SLACK_BASE_URL: 'http://slack.test' }, fetchImpl: slack(messages, options) });
const find = (result, name) => result.checks.find(check => check.check === name);

test('pagination reads all pages and rejects repeated cursors', async () => {
  const calls = [];
  const values = await paginate(async cursor => { calls.push(cursor); return cursor ? { data: [2] } : { data: [1], next: 'a' }; }, { items: page => page.data, next: page => page.next });
  assert.deepEqual(values, [1, 2]);
  assert.deepEqual(calls, ['', 'a']);
  await assert.rejects(paginate(async () => ({ data: [], next: 'same' }), { items: page => page.data, next: page => page.next }), /repeated/);
});

test('pagination rejects missing lists and later-page failure', async () => {
  await assert.rejects(paginate(async () => ({}), { items: page => page.data, next: () => '' }), /required list/);
  const result = await slackProbe(['Baseline'], { secondPageError: true });
  assert.equal(find(result, 'provider.slack.read').status, 'failed');
  assert.match(find(result, 'provider.slack.read').detail, /invalid_cursor/);
  assert.equal(result.coverage.some(entry => entry.collection === 'people'), false);
});

test('missing baseline record fails even when a valid arrival is present', async () => {
  const result = await slackProbe(['Arrival']);
  assert.equal(find(result, 'slack.history.orbit').status, 'failed');
  assert.equal(find(result, 'slack.history.orbit').missing.length, 1);
});

test('source arrival can be extra, but foreign records and duplicate arrivals fail', async () => {
  assert.equal(find(await slackProbe(['Baseline', 'Arrival']), 'slack.history.orbit').status, 'passed');
  assert.equal(find(await slackProbe(['Baseline', 'Foreign']), 'slack.history.orbit').status, 'failed');
  assert.equal(find(await slackProbe(['Baseline', 'Arrival', 'Arrival']), 'slack.history.orbit').status, 'failed');
  assert.equal(find(await slackProbe(['Baseline'], { extraUser: true }), 'slack.people').status, 'failed');
});

test('a future Slack arrival cannot appear in the paused baseline', async () => {
  const input = artifact();
  input.world.timeline[0].after_seconds = 60;
  const result = await probeWorld({ artifact: input, bindings: { SLACK_BASE_URL: 'http://slack.test' }, elapsedMs: 1000,
    fetchImpl: slack(['Baseline', 'Arrival']) });
  assert.equal(find(result, 'slack.history.orbit').status, 'failed');
});

test('an unimplemented selected provider is an explicit coverage failure', async () => {
  const result = await probeWorld({ artifact: artifact(), bindings: { NOTION_BASE_URL: 'http://notion.test' }, fetchImpl: async () => { throw new Error('Unexpected request'); } });
  assert.equal(find(result, 'coverage.provider.notion').status, 'failed');
  assert.equal(result.coverage[0].status, 'failed');
});

test('duplicate Linear titles require two source records through all API pages', async () => {
  const input = artifact();
  input.world.work = { tasks: [
    { id: 'one', title: 'Same', description: 'First', assignee_id: 'mono' },
    { id: 'two', title: 'Same', description: 'Second', assignee_id: 'mono' },
  ] };
  input.projections.linear = { issues: [{ worldfixture_task_id: 'one' }] };
  const result = await probeWorld({ artifact: input, bindings: { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' }, fetchImpl: async () => response({ data: { issues: { nodes: [{ id: 'L1', title: 'Same', description: 'First', assignee: { email: 'mono@alien.test' } }], pageInfo: { hasNextPage: false, endCursor: null } } } }) });
  assert.equal(find(result, 'linear.task-count').status, 'failed');
  assert.equal(find(result, 'linear.task.two').status, 'failed');
  assert.equal(find(result, 'linear.projection-completeness').status, 'failed');
});

test('Gmail reads each source recipient and detects mail absent from a second mailbox', async () => {
  const input = artifact();
  input.world.people.push({ id: 'other', email: 'other@alien.test', organization_id: 'alien' });
  input.world.communication.mail = [{ id: 'mail', from_id: 'mono', to_ids: ['other'], subject: 'Unique', labels: ['INBOX'] }];
  const urls = [];
  const result = await probeWorld({ artifact: input, bindings: { GOOGLE_BASE_URL: 'http://google.test', GOOGLE_TOKEN: 'run-token' }, fetchImpl: async (url, options) => {
    urls.push(url);
    if (options.headers.authorization === 'Bearer demo_token') return new Response('{}', { status: 401 });
    if (url.includes('userinfo')) return response({ email: 'mono@alien.test' });
    if (url.includes('/labels')) return response({ labels: [{ id: 'INBOX', name: 'INBOX' }] });
    return response({ messages: [], resultSizeEstimate: 0 });
  } });
  assert(urls.some(url => url.includes('other%40alien.test/messages')));
  assert.equal(find(result, 'google.mail.other').status, 'failed');
  assert.equal(find(result, 'google.sample-credential-rejected').status, 'passed');
});

test('supplemental readers suppress only their own missing-reader check', async () => {
  const result = await probeWorld({ artifact: artifact(), bindings: { NOTION_BASE_URL: 'http://notion.test', VERCEL_BASE_URL: 'http://vercel.test' }, supplementalProviders: new Set(['notion']), fetchImpl: async () => { throw new Error('Unexpected request'); } });
  assert.equal(find(result, 'coverage.provider.notion'), undefined);
  assert.equal(find(result, 'coverage.provider.vercel').status, 'failed');
});

test('content failure also fails its collection coverage', async () => {
  const result = await slackProbe([]);
  assert.equal(result.coverage.find(entry => entry.collection === 'communication.channels[].messages').status, 'failed');
  assert.equal(find(result, 'provider.slack.read').status, 'failed');
});

test('S3 HTML response cannot be mistaken for an empty bucket inventory', async () => {
  const input = artifact();
  input.projections.aws = { s3: { buckets: [], objects: [] } };
  const result = await probeWorld({ artifact: input, bindings: { S3_BASE_URL: 'http://s3.test', S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret', S3_REGION: 'us-east-1' }, fetchImpl: async () => new Response('<html>Not S3</html>', { status: 200 }) });
  assert.equal(find(result, 'provider.s3.read').status, 'failed');
  assert.match(find(result, 'provider.s3.read').detail, /XML is invalid/);
});

test('Linear source identity maps to unique public identifiers without provider metadata', async () => {
  const input = artifact();
  input.world.work = { tasks: [
    { id: 'one', title: 'Same', description: 'First', assignee_id: 'mono' },
    { id: 'two', title: 'Same', description: 'Second', assignee_id: 'mono' },
  ] };
  input.projections.linear = { issues: [{ worldfixture_task_id: 'one' }, { worldfixture_task_id: 'two' }] };
  const result = await probeWorld({ artifact: input, bindings: { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' }, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth/token')) return response({ error: 'invalid_client' });
    const query = JSON.parse(options.body).query;
    const second = query.includes('after:');
    return response({ data: { issues: { nodes: [{ id: second ? 'L2' : 'L1', identifier: second ? 'ORBIT-2' : 'ORBIT-1', title: 'Same', description: second ? 'Second' : 'First', assignee: { email: 'mono@alien.test' } }], pageInfo: { hasNextPage: !second, endCursor: second ? null : 'page2' } } } });
  } });
  assert.equal(find(result, 'linear.source-identity-mapping').status, 'passed');
  assert.deepEqual(find(result, 'linear.source-identity-mapping').actual.map(row => [row.source, row.identifier]), [['one', 'ORBIT-1'], ['two', 'ORBIT-2']]);
  assert.equal(result.coverage.find(entry => entry.collection === 'work.tasks').status, 'passed');
});

test('S3 empty ListBuckets limitation does not prevent declared object reads', async () => {
  const input = artifact();
  input.world.communication.documents = [{ id: 'doc-orbit', content: 'Source content' }];
  input.projections.aws = { s3: { buckets: [{ name: 'orbit-docs' }], objects: [{ bucket: 'orbit-docs', key: 'documents/doc-orbit.md', content: 'Source content', worldfixture_document_id: 'doc-orbit' }] } };
  const urls = [];
  const result = await probeWorld({ artifact: input, bindings: { S3_BASE_URL: 'http://s3.test', S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret', S3_REGION: 'us-east-1' }, fetchImpl: async url => {
    urls.push(url);
    if (url === 'http://s3.test/') return new Response('<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
    if (url.includes('list-type=2')) return new Response('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>documents/doc-orbit.md</Key></Contents></ListBucketResult>');
    return new Response('Source content');
  } });
  assert.equal(find(result, 's3.buckets').status, 'failed');
  assert.equal(find(result, 's3.content.orbit-docs.documents/doc-orbit.md').status, 'passed');
  assert(urls.some(url => url.endsWith('/documents/doc-orbit.md')));
});

test('OAuth sample client authentication is checked and issued tokens are never stored', async () => {
  const token = 'synthetic-issued-token-must-not-enter-report';
  const result = await probeWorld({ artifact: artifact(), bindings: { OKTA_BASE_URL: 'http://okta.test' }, fetchImpl: async (url, options) => {
    if (url.endsWith('/token')) {
      assert.equal(options.body.get('client_id'), 'okta-test-client');
      assert.equal(options.body.get('client_secret'), 'okta-test-secret');
      return response({ access_token: token, token_type: 'Bearer' });
    }
    return new Response('{}', { status: 401 });
  } });
  assert.equal(find(result, 'okta.sample-oauth-client-rejected').status, 'failed');
  assert.equal(find(result, 'okta.sample-oauth-client-rejected').actual.grant_issued, true);
  assert.equal(JSON.stringify(result).includes(token), false);
});

for (const provider of ['apple', 'clerk']) test(`${provider} sample client receives a real code exchange with no code or token in evidence`, async () => {
  const code = 'synthetic-authorization-code';
  const grant = 'synthetic-issued-grant';
  const result = await probeWorld({ artifact: artifact(), bindings: { [`${provider.toUpperCase()}_BASE_URL`]: `http://${provider}.test` }, fetchImpl: async (url, options) => {
    if (url.endsWith('/userinfo')) return response({ sub: 'user-current', email: 'mono@alien.test' });
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('/callback')) {
      assert.equal(options.body.get(provider === 'clerk' ? 'user_ref' : 'email'), provider === 'clerk' ? 'user-current' : 'mono@alien.test');
      return new Response('', { status: 302, headers: { location: `http://localhost:3000/api/auth/callback/${provider}?code=${code}` } });
    }
    assert.equal(options.body.get('code'), code);
    assert.equal(options.body.get('client_id'), provider === 'clerk' ? 'clerk_emulate_client' : 'com.example.app');
    if (provider === 'clerk') assert.equal(options.body.get('client_secret'), 'clerk_emulate_secret');
    return response({ access_token: grant, refresh_token: 'synthetic-refresh', id_token: 'synthetic-id-token' });
  } });
  assert.equal(find(result, `${provider}.sample-oauth-client-rejected`).status, 'failed');
  assert.equal(find(result, `${provider}.sample-oauth-client-rejected`).actual.grant_issued, true);
  assert.equal(JSON.stringify(result).includes(code), false);
  assert.equal(JSON.stringify(result).includes(grant), false);
});

test('declared AWS IAM and SQS data fail coverage when the listener has no binding', async () => {
  const input = artifact();
  input.projections.aws = { iam: { users: [{ user_name: 'mono' }] }, sqs: { queues: [{ name: 'orbital-queue' }] } };
  const result = await probeWorld({ artifact: input, bindings: {}, fetchImpl: async () => { throw new Error('No API should be called without a binding'); } });
  assert.equal(find(result, 'coverage.provider.aws.iam').status, 'failed');
  assert.equal(find(result, 'coverage.provider.aws.sqs').status, 'failed');
  assert.equal(result.coverage.filter(entry => entry.provider === 'aws' && entry.status === 'failed').length, 2);
});


test('AWS readers use pagination and source operator/queue declarations when a binding exists', async () => {
  const input = artifact();
  input.world.people[0].github_login = 'mono';
  input.world.people.push({ id: 'two', github_login: 'second', email: 'second@alien.test', organization_id: 'alien', team: 'orbit' });
  input.world.software = { operator_teams: ['orbit'], operator_ids: ['mono'], operator_limit: null, service_roles: [], queues: [{ name: 'orbit-jobs', visibility_timeout: 71 }] };
  input.projections.aws = { iam: { users: [{ user_name: 'mono', path: '/people/' }, { user_name: 'second', path: '/people/' }], roles: [] }, sqs: { queues: input.world.software.queues } };
  const calls = [];
  const result = await probeWorld({ artifact: input, bindings: { AWS_BASE_URL: 'http://aws.test', AWS_TOKEN: 'run-aws' }, fetchImpl: async (_url, options) => {
    const action = options.body.get('Action');
    calls.push([action, options.body.get('Marker')]);
    assert.equal(options.headers.authorization, 'Bearer run-aws');
    if (action === 'ListUsers') {
      const second = options.body.get('Marker') === 'page-two';
      return new Response(`<ListUsersResponse><ListUsersResult><IsTruncated>${!second}</IsTruncated>${second ? '' : '<Marker>page-two</Marker>'}<Users><member><UserName>${second ? 'second' : 'mono'}</UserName><Path>/people/</Path></member></Users></ListUsersResult></ListUsersResponse>`);
    }
    if (action === 'ListRoles') return new Response('<ListRolesResponse><ListRolesResult><IsTruncated>false</IsTruncated><Roles></Roles></ListRolesResult></ListRolesResponse>');
    if (action === 'ListQueues') return new Response('<ListQueuesResponse><ListQueuesResult><QueueUrl>http://aws.test/sqs/000/orbit-jobs</QueueUrl></ListQueuesResult></ListQueuesResponse>');
    assert.equal(action, 'GetQueueAttributes');
    assert.equal(options.body.get('QueueUrl'), 'http://aws.test/sqs/000/orbit-jobs');
    return new Response('<GetQueueAttributesResponse><GetQueueAttributesResult><Attribute><Name>VisibilityTimeout</Name><Value>71</Value></Attribute></GetQueueAttributesResult></GetQueueAttributesResponse>');
  } });
  assert(calls.some(([action, cursor]) => action === 'ListUsers' && cursor === 'page-two'));
  assert.equal(find(result, 'aws.iam.source-operators').status, 'passed');
  assert.equal(find(result, 'aws.sqs.visibility.orbit-jobs').status, 'passed');
  assert.equal(result.checks.some(entry => entry.status === 'failed'), false);
});

async function awsOperatorProbe(policy, liveIds, { team = 'orbit', readFailure = false, binding = true } = {}) {
  const input = artifact();
  input.world.people[0].github_login = 'mono';
  input.world.people[0].team = 'leadership';
  input.world.people.push(...['zeta', 'alpha', 'beta', 'gamma', 'delta'].map(id => ({ id, github_login: id, organization_id: 'alien', team })));
  input.world.people.push({ id: 'foreign', github_login: 'foreign', organization_id: 'other', team });
  input.world.software = { ...policy, service_roles: [] };
  // Deliberately let projection and live output agree: only source checks can
  // detect an omitted or injected operator shared by both layers.
  input.projections.aws = { iam: { users: liveIds.map(user_name => ({ user_name, path: '/people/' })), roles: [] } };
  return probeWorld({ artifact: input, bindings: binding ? { AWS_BASE_URL: 'http://aws.test' } : {}, fetchImpl: async (_url, options) => {
    if (readFailure) throw new Error('IAM ListUsers failed');
    const action = options.body.get('Action');
    assert(['ListUsers', 'ListRoles'].includes(action));
    const content = action === 'ListUsers' ? liveIds.map(id => `<member><UserName>${id}</UserName><Path>/people/</Path></member>`).join('') : '';
    return new Response(`<${action}Response><${action}Result><IsTruncated>false</IsTruncated>${content}</${action}Result></${action}Response>`);
  } });
}

test('IAM expectation uses the source union and detects matching lossy projection/API data', async () => {
  const policy = { operator_teams: ['orbit'], operator_ids: ['mono'], operator_limit: null };
  const ids = ['alpha', 'beta', 'delta', 'gamma', 'mono', 'zeta'];
  const full = await awsOperatorProbe(policy, ids);
  assert.equal(find(full, 'aws.iam.source-operators').status, 'passed');
  for (const actual of [ids.slice(0, 4), [...ids, 'foreign'], [...ids, 'alpha']]) {
    const result = await awsOperatorProbe(policy, actual);
    assert.equal(find(result, 'aws.iam.users').status, 'passed', 'projection agrees with intentionally wrong live output');
    assert.equal(find(result, 'aws.iam.source-operators').status, 'failed');
    assert.equal(result.coverage.find(row => row.collection === 'software.operator_ids').status, 'failed');
  }
});

test('IAM explicit empty selectors and zero limit never add primary or legacy operators', async () => {
  for (const policy of [
    { operator_teams: [], operator_limit: null },
    { operator_ids: [], operator_limit: null },
    { operator_teams: ['orbit'], operator_ids: ['mono'], operator_limit: 0 },
  ]) {
    assert.equal(find(await awsOperatorProbe(policy, []), 'aws.iam.source-operators').status, 'passed');
    assert.equal(find(await awsOperatorProbe(policy, ['mono']), 'aws.iam.source-operators').status, 'failed');
  }
  assert.equal(find(await awsOperatorProbe({ operator_ids: ['beta'], operator_limit: null }, ['beta']), 'aws.iam.source-operators').status, 'passed');
  assert.equal(find(await awsOperatorProbe({ operator_teams: ['orbit'], operator_limit: null }, ['alpha', 'beta', 'delta', 'gamma', 'zeta']), 'aws.iam.source-operators').status, 'passed');
});

test('IAM finite explicit cap uses stable IDs while absent policy keeps legacy order and limit', async () => {
  const policy = { operator_teams: ['orbit'], operator_ids: ['mono'], operator_limit: 2 };
  assert.equal(find(await awsOperatorProbe(policy, ['alpha', 'beta']), 'aws.iam.source-operators').status, 'passed');
  assert.equal(find(await awsOperatorProbe(policy, ['mono', 'zeta']), 'aws.iam.source-operators').status, 'failed');
  const noLimit = { operator_teams: ['orbit'], operator_ids: ['mono'] };
  assert.equal(find(await awsOperatorProbe(noLimit, ['alpha', 'beta', 'delta', 'gamma']), 'aws.iam.source-operators').status, 'passed');
  const legacy = await awsOperatorProbe({}, ['mono', 'zeta', 'alpha', 'beta'], { team: 'engineering' });
  assert.equal(find(legacy, 'aws.iam.source-operators').status, 'passed');
  assert.equal(find(legacy, 'aws.iam.operator-declaration').status, 'failed', 'legacy matches are not an authored policy');
});

test('IAM invalid source references fail even if projection and live users match', async () => {
  for (const policy of [
    { operator_ids: ['foreign'], operator_limit: null },
    { operator_ids: ['unknown'], operator_limit: null },
    { operator_teams: ['unknown'], operator_limit: null },
    { operator_ids: ['mono'], operator_limit: false },
    { operator_ids: ['mono', 'mono'], operator_limit: null },
  ]) {
    const result = await awsOperatorProbe(policy, []);
    assert.equal(find(result, 'aws.iam.source-operator-policy-valid').status, 'failed');
    assert.equal(result.coverage.filter(row => row.collection.startsWith('software.operator_')).every(row => row.status === 'failed'), true);
  }
});

test('IAM source selection collections retain failed evidence when binding or read is unavailable', async () => {
  const policy = { operator_teams: [], operator_ids: [], operator_limit: null };
  for (const options of [{ binding: false }, { readFailure: true }]) {
    const result = await awsOperatorProbe(policy, [], options);
    for (const collection of ['software.operator_teams', 'software.operator_ids', 'software.operator_limit']) {
      assert.equal(result.coverage.find(row => row.collection === collection).status, 'failed');
    }
  }
});

test('Vercel sample client uses the source identity and a real code exchange', async () => {
  let exchanged = false;
  const result = await probeWorld({ artifact: artifact(), bindings: { VERCEL_BASE_URL: 'http://vercel.test', VERCEL_TOKEN: 'run-vercel' }, supplementalProviders: ['vercel'], fetchImpl: async (url, options) => {
    if (url.endsWith('/v2/user')) return response({ user: { username: 'world-mono', email: 'mono@alien.test' } });
    if (url.endsWith('/callback')) {
      assert.equal(options.body.get('username'), 'world-mono');
      assert.equal(options.redirect, 'manual');
      return new Response('', { status: 302, headers: { location: 'http://localhost:3000/api/auth/callback/vercel?code=synthetic-code' } });
    }
    assert(url.endsWith('/login/oauth/token'));
    assert.equal(options.body.get('client_id'), 'oac_example_client_id');
    assert.equal(options.body.get('client_secret'), 'example_client_secret');
    assert.equal(options.body.get('code'), 'synthetic-code');
    exchanged = true;
    return response({ error: 'invalid_client' });
  } });
  assert(exchanged);
  assert.equal(find(result, 'vercel.sample-oauth-client-rejected').status, 'passed');
  assert.equal(find(result, 'coverage.oauth-client.vercel'), undefined);
});

test('Apple world identity verifies signed claims independently of sample client rejection', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signed = claims => { const data = `${encode({ alg: 'RS256', kid: 'fixture-key' })}.${encode(claims)}`; return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`; };
  let nonce;
  const input = artifact();
  input.projections.apple = { oauth_clients: [{ client_id: 'world-client', redirect_uris: ['http://callback.test/apple'] }] };
  const result = await probeWorld({ artifact: input, bindings: { APPLE_BASE_URL: 'http://apple.test', APPLE_TOKEN: 'world-apple-token' }, fetchImpl: async (url, options) => {
    if (url.endsWith('openid-configuration')) return response({ issuer: 'http://apple.test' });
    if (url.endsWith('/auth/keys')) return response({ keys: [jwk] });
    if (url.endsWith('/callback')) {
      nonce = options.body.get('nonce');
      const redirect = options.body.get('redirect_uri');
      if (options.body.get('client_id') === 'com.example.app') return new Response('<h1>Application not found</h1>', { status: 400 });
      assert.equal(options.headers.authorization, 'Bearer world-apple-token');
      return new Response('', { status: 302, headers: { location: `${redirect}?code=synthetic-code` } });
    }
    return response({ access_token: 'do-not-save-grant', id_token: signed({ iss: 'http://apple.test', aud: 'world-client', sub: 'provider-subject', email: 'mono@alien.test', nonce, exp: Date.now() / 1000 + 60 }) });
  } });
  assert.equal(find(result, 'apple.source-identity.mono').status, 'passed');
  assert.equal(find(result, 'apple.sample-oauth-client-rejected').status, 'passed');
  assert.equal(result.coverage.find(entry => entry.provider === 'apple').status, 'passed');
  assert.equal(JSON.stringify(result).includes('do-not-save-grant'), false);
  const args = { issuer: 'http://apple.test', audience: 'world-client', nonce: 'nonce', email: 'mono@alien.test' };
  assert.throws(() => verifyAppleIdentity(signed({ iss: args.issuer, aud: 'wrong-client', sub: 'subject', email: args.email, nonce: args.nonce, exp: Date.now() / 1000 + 60 }), [jwk], args), /claims do not match/);
});

function receiptLinearFixture() {
  const input = artifact();
  input.world.id = 'consumer.odd'; input.world.version = 'v1';
  input.world.communication = {}; input.world.timeline = [];
  input.world.work = { team: { key: 'ODD' }, projects: [{ id: 'project', name: 'Source project' }], tasks: ['one', 'two'].map(id => ({
    id, title: 'Identical', description: 'Identical body', assignee_id: 'mono', project_id: 'project', due_on: '2031-03-04', status: 'ready',
  })) };
  input.identity = { id: input.world.id, version: input.world.version, digest: 'a'.repeat(64) };
  input.projections = { linear: { issues: input.world.work.tasks.map(task => ({ worldfixture_task_id: task.id })) }, 'emulator-overlay': { linear: { worldfixture_seed_version: 1 } } };
  const receipt = { api_version: 'worldfixture.linear-seed-receipt/v1', world: { ...input.identity }, issues: [
    { source_task_id: 'one', provider_issue_id: 'LIVE-B' }, { source_task_id: 'two', provider_issue_id: 'LIVE-A' },
  ] };
  const issues = ['LIVE-A', 'LIVE-B'].map((id, index) => ({ id, identifier: `ODD-${index + 1}`, title: 'Identical', description: 'Identical body', assignee: { email: 'mono@alien.test' }, team: { key: 'ODD' }, state: { name: 'ready' } }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname === '/_worldfixture/seed-receipt') return response(receipt);
    if (new URL(url).pathname === '/oauth/token') return Response.json({ error: 'invalid_client' }, { status: 400 });
    const query = JSON.parse(options.body).query; calls.push(query);
    return response({ data: { issues: { nodes: [issues[query.includes('after:') ? 1 : 0]], pageInfo: query.includes('after:') ? { hasNextPage: false, endCursor: null } : { hasNextPage: true, endCursor: 'second' } } } });
  };
  return { input, receipt, issues, calls, fetchImpl };
}

test('versioned Linear follows receipts instead of ordering identical task contents', async () => {
  const env = receiptLinearFixture();
  const result = await probeWorld({ artifact: env.input, bindings: { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' }, fetchImpl: env.fetchImpl });
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.deepEqual(find(result, 'linear.source-identity-mapping').actual.map(row => [row.source, row.id]), [['one', 'LIVE-B'], ['two', 'LIVE-A']]);
  assert(env.calls.some(query => query.includes('after:')));
});

for (const damage of ['digest', 'missing', 'foreign', 'duplicate-source', 'duplicate-provider', 'content', 'state']) test(`Linear receipt/content ${damage} fails measured checks`, async () => {
  const env = receiptLinearFixture();
  if (damage === 'digest') env.receipt.world.digest = 'b'.repeat(64);
  if (damage === 'missing') env.receipt.issues.pop();
  if (damage === 'foreign') env.receipt.issues[0].source_task_id = 'foreign';
  if (damage === 'duplicate-source') env.receipt.issues[1].source_task_id = 'one';
  if (damage === 'duplicate-provider') env.receipt.issues[1].provider_issue_id = 'LIVE-B';
  if (damage === 'content') env.issues[0].description = 'Changed';
  if (damage === 'state') env.issues[0].state.name = 'Done';
  const result = await probeWorld({ artifact: env.input, bindings: { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' }, fetchImpl: env.fetchImpl });
  assert.equal(find(result, 'provider.linear.read').status, 'failed');
  if (damage === 'content' || damage === 'state') assert.equal(find(result, 'linear.task-content.two').status, 'failed');
});


test('S3 bucket inventory follows continuation tokens with signed requests', async () => {
  const calls = [];
  const input = { world: { people: [], organizations: [], communication: { documents: [] } },
    projections: { aws: { s3: { buckets: [{ name: 'first' }, { name: 'second' }], objects: [] } } } };
  const result = await probeWorld({ artifact: input,
    bindings: { S3_BASE_URL: 'http://s3.test', S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret', S3_REGION: 'us-east-1' },
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access\//);
      if (url === 'http://s3.test/') return new Response('<ListAllMyBucketsResult><Buckets><Bucket><Name>first</Name></Bucket></Buckets><ContinuationToken>next page</ContinuationToken></ListAllMyBucketsResult>');
      if (url.includes('continuation-token=')) return new Response('<ListAllMyBucketsResult><Buckets><Bucket><Name>second</Name></Bucket></Buckets></ListAllMyBucketsResult>');
      return new Response('<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>');
    } });
  assert.ok(calls.includes('http://s3.test/?continuation-token=next%20page'));
  assert.equal(result.checks.find(row => row.check === 's3.buckets').status, 'passed');
  assert.equal(result.checks.some(row => row.status === 'failed'), false);
});

for (const provider of ['slack', 'github', 'apple', 'clerk', 'vercel']) test(`${provider} sample OAuth check accepts the declared-client guard's measured invalid_client response`, async () => {
  const result = await probeWorld({ artifact: artifact(), bindings: { [`${provider.toUpperCase()}_BASE_URL`]: `http://${provider}.test` }, supplementalProviders: [provider], fetchImpl: async (url) => {
    if (url.endsWith('/userinfo')) return response({ sub: 'user-current', email: 'mono@alien.test' });
    if (url.endsWith('/v2/user')) return response({ user: { username: 'world-mono', email: 'mono@alien.test' } });
    return Response.json({ error: 'invalid_client' }, { status: 401 });
  } });
  assert.equal(find(result, `${provider}.sample-oauth-client-rejected`).status, 'passed');
});

test('Apple source people remain unproved when no application is declared', async () => {
  const result = await probeWorld({ artifact: artifact(), bindings: { APPLE_BASE_URL: 'http://apple.test' }, fetchImpl: async () => Response.json({ error: 'invalid_client' }, { status: 401 }) });
  assert.equal(find(result, 'apple.source-identity-client').status, 'failed');
  assert.equal(find(result, 'apple.source-identity-client').failure_kind, 'capability_gap');
  assert.equal(result.coverage.find(row => row.provider === 'apple' && row.collection === 'people').status, 'failed');
});


test('focused Linear reader retains source checks without reading other declared providers', async () => {
  const env = receiptLinearFixture();
  env.input.projections.google = { messages: [] };
  env.input.projections.aws = { iam: { users: [] }, s3: { buckets: [] } };
  const result = await probeLinearWorld({ artifact: env.input, bindings: { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' }, fetchImpl: env.fetchImpl });
  assert.ok(result.checks.every(check => check.status === 'passed'), JSON.stringify(result.checks));
  assert.ok(result.responses.every(response => response.provider === 'linear'));
  assert.equal(find(result, 'linear.task-count').actual, 2);
  assert.equal(find(result, 'linear.source-identity-mapping').actual.length, 2);
  const missing = await probeLinearWorld({ artifact: env.input, bindings: {}, fetchImpl: env.fetchImpl });
  assert.equal(find(missing, 'provider.linear.read').status, 'failed');
  assert.equal(missing.coverage[0].status, 'failed');
  const full = await probeWorld({ artifact: env.input, bindings: { LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current' }, fetchImpl: env.fetchImpl });
  assert.ok(full.checks.some(check => check.status === 'failed' && check.check.includes('google')));
});

test('section Linear checks preserve an unfamiliar source state without a legacy description suffix', async () => {
  const env = receiptLinearFixture();
  env.input.world.work.tasks.forEach(task => { task.status = 'custom-awaiting-review'; });
  env.issues.forEach(issue => { issue.state.name = 'custom-awaiting-review'; });
  const result = await probeLinearWorld({artifact: env.input, bindings: {LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current'}, fetchImpl: env.fetchImpl});
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
  env.issues[0].description += '\n\nProject: Invented';
  assert.ok((await probeLinearWorld({artifact: env.input, bindings: {LINEAR_BASE_URL: 'http://linear.test', LINEAR_TOKEN: 'current'}, fetchImpl: env.fetchImpl})).checks.some(check => check.status === 'failed'));
});

test('section Slack checks include external people without a primary organization', async () => {
  const input = artifact();
  input.world.organizations = [];
  input.world.people[0].organization_id = null;
  const result = await probeWorld({artifact: input, bindings: {SLACK_BASE_URL: 'http://slack.test'}, fetchImpl: slack(['Baseline'])});
  assert.equal(find(result, 'slack.people').status, 'passed');
  input.world.people.push({id: 'outside', name: 'Outside', email: 'outside@alien.test', organization_id: null});
  const missing = await probeWorld({artifact: input, bindings: {SLACK_BASE_URL: 'http://slack.test'}, fetchImpl: slack(['Baseline'])});
  assert.equal(find(missing, 'slack.people').status, 'failed');
});

test('Linear reads use a verified per-person credential when no primary/default exists', async () => {
  const env = receiptLinearFixture(); delete env.input.world.people[0].primary;
  env.input.projections['emulator-overlay'].tokens = {linear_token_mono: {login: 'mono@alien.test'}};
  const credentials = {world: {id: env.input.world.id, version: env.input.world.version}, values: {'token:linear_token_mono': 'personal-linear'}};
  const bindings = {LINEAR_BASE_URL: 'http://linear.test'};
  const fetchImpl = (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer personal-linear');
    if (JSON.parse(options.body ?? '{}').query?.includes('viewer')) return Promise.resolve(response({data: {viewer: {id: 'viewer-mono', email: 'mono@alien.test'}}}));
    return env.fetchImpl(url, options);
  };
  const result = await probeLinearWorld({artifact: env.input, bindings, credentials, fetchImpl});
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(find(result, 'linear.read-actor-selection').actual.selection, 'per-person-read');
  assert.equal(bindings.LINEAR_TOKEN, undefined); assert.equal(env.input.world.people[0].primary, undefined);
  const missing = await probeLinearWorld({artifact: env.input, bindings, credentials: {...credentials, values: {}}, fetchImpl});
  assert.equal(find(missing, 'provider.linear.read').status, 'failed');
});

test('Slack reads verify a chosen personal credential without inventing a primary', async () => {
  const input = artifact(); input.world.id = 'read-only-world'; input.world.version = 'v1'; delete input.world.people[0].primary;
  input.projections['emulator-overlay'] = {tokens: {slack_token_mono: {login: 'mono-d7de5f2b31'}}};
  const {sourceGithubLogin} = await import('./coupling-source-contracts.mjs');
  input.projections['emulator-overlay'].tokens.slack_token_mono.login = sourceGithubLogin(input.world.people[0]);
  const credentials = {world: {id: input.world.id, version: input.world.version}, values: {'token:slack_token_mono': 'personal-slack'}};
  const base = slack(['Baseline']);
  const result = await probeWorld({artifact: input, bindings: {SLACK_BASE_URL: 'http://slack.test'}, credentials, fetchImpl: (url, options) => {
    if (url.includes('/oauth.v2.access')) return Promise.resolve(response({ok: false, error: 'invalid_client'}));
    assert.equal(options.headers.authorization, 'Bearer personal-slack');
    return url.includes('/auth.test') ? Promise.resolve(response({ok: true, user_id: 'U1'})) : base(url, options);
  }});
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(find(result, 'slack.read-actor').status, 'passed');
  assert.equal(find(result, 'slack.read-actor-selection').actual.selection, 'per-person-read');
  assert.equal(input.world.people[0].primary, undefined);
});
