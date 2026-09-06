/** Source-backed relationship reads and rejection of checked-in sample tokens. */
import { paginate, seedReceiptMappings } from './coupling-probes.mjs';
import {legacyBusinessContract, sourceGithubLogin, sourceReadCredential} from './coupling-source-contracts.mjs';

const rows = value => Array.isArray(value) ? value : [];
const sorted = values => [...values].sort();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Sources: emulators/emulate/seed.yaml and the pinned emulate 0.10.0
// initConfig/default token map. These are sample strings, never run secrets.
const sampleRoutes = {
  slack: { path: '/api/auth.test', method: 'POST', tokens: ['slack_token'] },
  linear: { path: '/graphql', method: 'POST', body: { query: 'query { viewer { id email } }' }, tokens: ['linear_token', 'lin_test_admin'] },
  google: { path: '/oauth2/v2/userinfo', tokens: ['demo_token'] },
  github: { path: '/user', tokens: ['github_token'] },
  microsoft: { path: '/v1.0/me', tokens: ['microsoft_token'] },
  okta: { path: '/api/v1/users?limit=1', tokens: ['okta_token'] },
  clerk: { path: '/v1/users?limit=1', tokens: ['clerk_token'] },
  vercel: { path: '/v2/user', tokens: ['vercel_token'] },
  resend: { path: '/domains', tokens: ['resend_token'] },
  stripe: { path: '/v1/customers?limit=1', tokens: ['stripe_token'] },
  mongoatlas: { path: '/api/atlas/v2/groups', tokens: ['mongoatlas_token'] },
  notion: { path: '/v1/users/me', tokens: ['notion_token'], headers: { 'Notion-Version': '2026-03-11' } },
  twilio: { path: '/2010-04-01/Accounts/{account}.json', tokens: ['twilio_token'] },
};

export async function probeRelationshipsWorld({ artifact, bindings, credentials, fetchImpl = fetch }) {
  const world = artifact.world, projections = artifact.projections ?? {};
  const checks = [], responses = [], coverage = [];
  const people = new Map(rows(world.people).map(person => [person.id, person]));
  const selected = provider => Boolean(bindings[`${provider.toUpperCase()}_BASE_URL`] || projections[provider]);
  const check = (name, passed, detail = {}) => checks.push({ check: name, status: passed ? 'passed' : 'failed', ...detail });
  const compare = (name, expected, actual) => check(name, equal(expected, actual), { expected, actual, ...(!equal(expected, actual) ? { failure_kind: 'content_mismatch' } : {}) });
  const gap = (name, detail, failure_kind = 'reader_gap') => check(name, false, { detail, failure_kind });
  async function request(provider, path, { allowFailure = false, token, ...options } = {}) {
    const base = bindings[`${provider.toUpperCase()}_BASE_URL`];
    if (!base) throw new Error(`Missing ${provider.toUpperCase()}_BASE_URL`);
    const bearer = token ?? sourceReadCredential({artifact, bindings, credentials, provider}).token;
    const response = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...options.headers } });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    responses.push({ provider, path, status: response.status, body });
    if (!allowFailure) {
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      if (!body || typeof body !== 'object') throw new Error(`${path} returned invalid JSON`);
      if (body.ok === false || body.errors?.length || body.error) throw new Error(`${path} returned an API error`);
    }
    return { body, status: response.status, ok: response.ok, headers: response.headers };
  }
  async function run(name, operation, collections = [], provider = name.split('.')[0], path = null) {
    const start = checks.length;
    try { await operation(); }
    catch (error) { gap(`relationships.${name}.request`, error.message, /^Missing /.test(error.message) ? 'binding_missing' : /returned HTTP|returned an API error/.test(error.message) ? 'service_error' : 'protocol_error'); }
    const failures = checks.slice(start).filter(entry => entry.status === 'failed');
    check(`relationships.${name}.read`, failures.length === 0, failures.length ? { detail: `${failures.length} contained checks failed.` } : {});
    for (const collection of collections) coverage.push({ collection, provider, path, status: failures.length ? 'failed' : 'passed', detail: 'Source relationships compared with complete public API reads; all contained checks must pass.' });
  }
  const slack = async (method, fields = {}) => (await request('slack', `/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })).body;
  const slackList = (method, key, fields = {}) => paginate(cursor => slack(method, { ...fields, limit: '200', ...(cursor ? { cursor } : {}) }), {
    items: body => body[key], next: body => { const next = body.response_metadata?.next_cursor; if (body.has_more && !next) throw new Error('Slack next cursor is missing'); return next; },
  });
  const graphql = async query => (await request('linear', '/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).body.data;
  const linearList = read => paginate(read, { items: body => body?.nodes, next: body => {
    if (!body.pageInfo) throw new Error('Linear pageInfo is missing');
    if (body.pageInfo.hasNextPage && !body.pageInfo.endCursor) throw new Error('Linear next cursor is missing');
    return body.pageInfo.hasNextPage ? body.pageInfo.endCursor : '';
  } });
  const pageArgs = cursor => `first: 100${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}`;

  if (selected('github')) for (const repository of rows(world.software?.repositories)) await run(`github.members.${repository.id}`, async () => {
    const owner = rows(world.organizations).find(org => org.id === repository.owner_id);
    if (!owner) throw new Error(`Source repository ${repository.id} has no owner organization`);
    const path = `/repos/${encodeURIComponent(owner.slug ?? owner.id)}/${encodeURIComponent(repository.name ?? repository.id)}/collaborators`;
    const seenPages = new Set();
    const members = await paginate(async cursor => {
      const page = cursor || '1';
      const answer = await request('github', `${path}?affiliation=all&per_page=100&page=${encodeURIComponent(page)}`);
      if (!Array.isArray(answer.body)) throw new Error('GitHub collaborators returned no list');
      const signature = JSON.stringify(answer.body);
      if (answer.body.length && seenPages.has(signature)) throw new Error('GitHub repeated a collaborators result page');
      seenPages.add(signature);
      const next = answer.headers?.get('link')?.match(/<([^>]+)>;\s*rel="?next"?/)?.[1];
      let nextCursor;
      if (next) {
        const url = new URL(next, bindings.GITHUB_BASE_URL);
        if (url.origin !== new URL(bindings.GITHUB_BASE_URL).origin || !url.pathname.endsWith(path)) throw new Error('GitHub pagination left the bound collaborators endpoint');
        nextCursor = url.searchParams.get('page');
        if (!nextCursor) throw new Error('GitHub next page number is missing');
      } else if (answer.body.length === 100) nextCursor = String(Number(page) + 1);
      return { items: answer.body, nextCursor };
    }, { items: page => page.items, next: page => page.nextCursor });
    compare(`github.source-repository-members.${repository.id}`, sorted(rows(repository.member_ids).map(id => people.has(id) ? sourceGithubLogin(people.get(id)) : `missing-source-person:${id}`)), sorted(members.map(member => member.login)));
  }, ['software.repositories[].member_ids'], 'github', '/repos/{owner}/{repo}/collaborators');

  if (selected('slack')) await run('slack', async () => {
    const users = await slackList('users.list', 'members');
    const readActor = sourceReadCredential({artifact, bindings, credentials, provider: 'slack'});
    if (readActor.selection === 'per-person-read') {
      const auth = await slack('auth.test'), served = users.find(user => user.id === auth.user_id);
      compare('slack.relationship-read-actor', readActor.person.email ?? sourceGithubLogin(readActor.person), served?.profile?.email ?? served?.email ?? served?.name);
      check('slack.relationship-read-selection', true, {actual: {person_id: readActor.person.id, selection: readActor.selection}});
    }
    const livePeople = new Map(users.map(user => [user.id, user]));
    const channels = await slackList('conversations.list', 'channels', { types: 'public_channel,private_channel' });
    const sourceChannels = rows(world.communication?.channels);
    compare('slack.relationship-channel-inventory', sorted(sourceChannels.map(channel => channel.name ?? channel.id)), sorted(channels.map(channel => channel.name)));
    const botIds = new Set(), botNames = new Map();
    for (const user of users) {
      const id = user.bot_id ?? user.bot_profile?.id ?? user.profile?.bot_id;
      if (id) { botIds.add(id); botNames.set(user.name ?? user.real_name, id); }
    }
    for (const source of sourceChannels) {
      const channel = channels.find(value => value.name === (source.name ?? source.id));
      if (!channel) continue; // The inventory comparison already fails this absence.
      await run(`slack.members.${source.id}`, async () => {
        const members = await slackList('conversations.members', 'members', { channel: channel.id });
        compare(`slack.source-members.${source.id}`, sorted(rows(source.member_ids).map(id => { const person = people.get(id); return person ? person.email ?? sourceGithubLogin(person) : `missing-source:${id}`; })),
          sorted(members.map(id => livePeople.get(id)?.profile?.email ?? livePeople.get(id)?.email ?? livePeople.get(id)?.name ?? `unknown-live:${id}`)));
      }, ['communication.channels[].member_ids'], 'slack', '/api/conversations.members');
      await run(`slack.bot-history.${source.id}`, async () => {
        for (const message of await slackList('conversations.history', 'messages', { channel: channel.id })) {
          const id = message.bot_id ?? message.bot_profile?.id;
          if (id) { botIds.add(id); if (message.bot_profile?.name ?? message.username) botNames.set(message.bot_profile?.name ?? message.username, id); }
        }
      });
    }
    await run('slack.bots', async () => {
      const sourceBots = rows(world.communication?.bots);
      compare('slack.bot-projection-completeness', sorted(sourceBots.map(bot => bot.name)), sorted(rows(projections.slack?.bots).map(bot => bot.name)));
      for (const bot of sourceBots) if (bot.bot_id ?? bot.id) { botIds.add(bot.bot_id ?? bot.id); botNames.set(bot.name, bot.bot_id ?? bot.id); }
      const auth = await slack('auth.test');
      if (auth.bot_id) botIds.add(auth.bot_id);
      const liveBots = [];
      for (const id of botIds) await run(`slack.bot.${id}`, async () => {
        const bot = (await slack('bots.info', { bot: id })).bot;
        if (!bot || typeof bot.name !== 'string') throw new Error('Slack bots.info returned no named bot');
        liveBots.push(bot); botNames.set(bot.name, bot.id);
      });
      for (const bot of sourceBots) if (!botNames.has(bot.name)) gap(`slack.bot-identity.${bot.name}`,
        'Source bot has no ID in the exercised users, messages, or auth responses. A source bot ID or bot-scoped run binding is required.', 'identity_mapping_missing');
      compare('slack.source-bots', sorted(sourceBots.map(bot => bot.name)), sorted(liveBots.map(bot => bot.name)));
    }, ['communication.bots'], 'slack', '/api/users.list + /api/conversations.history + /api/auth.test + /api/bots.info');
  });

  if (selected('linear')) await run('linear', async () => {
    const tasks = rows(world.work?.tasks);
    const readActor = sourceReadCredential({artifact, bindings, credentials, provider: 'linear'});
    if (readActor.selection === 'per-person-read') {
      const viewer = (await graphql('query { viewer { id email } }')).viewer;
      compare('linear.relationship-read-actor', readActor.person.email, viewer?.email);
      check('linear.relationship-read-selection', true, {actual: {person_id: readActor.person.id, selection: readActor.selection}});
    }
    const versioned = projections['emulator-overlay']?.linear?.worldfixture_seed_version === 1;
    let mapping;
    if (versioned) {
      const receipt = (await request('linear', '/_worldfixture/seed-receipt')).body;
      mapping = seedReceiptMappings(receipt, artifact, 'linear', { collection: 'issues', sourceFields: ['source_task_id'], providerField: 'provider_issue_id', expectedKeys: tasks.map(task => [task.id]) });
    } else check('linear.relationship-seed-contract.legacy', true, { detail: 'Legacy artifact: labels require an unambiguous content match because no saved source identity receipt exists.' });
    const legacy = legacyBusinessContract(world);
    const expectedLabels = task => sorted([...new Set([...rows(task.labels), ...(legacy && task.status === 'blocked' ? ['blocked'] : []), ...(legacy && task.priority === 'urgent' ? ['urgent'] : [])])]);
    const labels = await linearList(async cursor => (await graphql(`query { issueLabels(${pageArgs(cursor)}) { nodes { id name } pageInfo { hasNextPage endCursor } } }`)).issueLabels);
    const expectedInventory = sorted([...new Set([...tasks.flatMap(expectedLabels), ...(legacy ? ['blocked', 'urgent'] : [])])]);
    compare('linear.source-label-inventory', expectedInventory, sorted(labels.map(label => label.name)));
    const issues = await linearList(async cursor => (await graphql(`query { issues(${pageArgs(cursor)}) { nodes { id title description assignee { email } } pageInfo { hasNextPage endCursor } } }`)).issues);
    compare('linear.relationship-task-count', tasks.length, issues.length);
    const byId = new Map(labels.map(label => [label.id, label.name]));
    const claimed = new Set();
    for (const task of tasks) await run(`linear.task-labels.${task.id}`, async () => {
      const matches = issues.filter(issue => !claimed.has(issue.id) && (versioned ? issue.id === mapping.get(JSON.stringify([task.id]))
        : issue.title === task.title && (issue.description ?? '').startsWith(task.description ?? '') && issue.assignee?.email === people.get(task.assignee_id)?.email));
      if (matches.length !== 1) {
        gap(`linear.task-label-identity.${task.id}`, `Expected one issue by ${versioned ? 'saved source identity receipt' : 'source title, description, and assignee'}; found ${matches.length}. Labels cannot select the identity being tested.`, 'identity_mapping_missing');
        return;
      }
      const issue = matches[0]; claimed.add(issue.id);
      const actual = await linearList(async cursor => (await graphql(`query { issue(id: ${JSON.stringify(issue.id)}) { labels(${pageArgs(cursor)}) { nodes { id name } pageInfo { hasNextPage endCursor } } } }`)).issue?.labels);
      compare(`linear.source-task-labels.${task.id}`, expectedLabels(task), sorted(actual.map(label => label.name)));
      compare(`linear.task-label-references.${task.id}`, [], actual.filter(label => byId.get(label.id) !== label.name).map(label => ({ id: label.id, name: label.name })));
    }, ['work.tasks[].labels'], 'linear', '/graphql issue.labels');
    compare('linear.unmatched-task-identities', [], issues.filter(issue => !claimed.has(issue.id)).map(issue => issue.id));
  }, ['work.tasks[].labels'], 'linear', '/_worldfixture/seed-receipt + /graphql');

  for (const [provider, route] of Object.entries(sampleRoutes)) {
    if (!selected(provider)) continue;
    await run(`${provider}.sample-bearers`, async () => {
      let path = route.path;
      const headers = { 'content-type': 'application/json', ...route.headers };
      const options = { method: route.method ?? 'GET', headers, ...(route.body ? { body: JSON.stringify(route.body) } : {}) };
      let controlOptions = options;
      if (provider === 'twilio') {
        if (!bindings.TWILIO_ACCOUNT_SID || !bindings.TWILIO_AUTH_TOKEN) throw new Error('Missing Twilio current account credentials');
        path = path.replace('{account}', encodeURIComponent(bindings.TWILIO_ACCOUNT_SID));
        controlOptions = { ...options, headers: { ...headers, authorization: `Basic ${Buffer.from(`${bindings.TWILIO_ACCOUNT_SID}:${bindings.TWILIO_AUTH_TOKEN}`).toString('base64')}` } };
      }
      // First prove the endpoint works with this run's credential. An absent
      // route or an always-refusing endpoint cannot prove sample rejection.
      await request(provider, path, controlOptions);
      for (const token of [...route.tokens, 'test_token_admin', 'test_token_user1']) {
        const answer = await request(provider, path, { ...options, token, allowFailure: true });
        const errors = rows(answer.body?.errors);
        const code = answer.body?.error;
        const rejected = answer.status === 401 || answer.status === 403
          || (provider === 'slack' && answer.status === 200 && answer.body?.ok === false && ['not_authed', 'invalid_auth', 'token_revoked', 'account_inactive'].includes(code))
          || (provider === 'linear' && answer.status === 200 && !answer.body?.data?.viewer && errors.length > 0 && errors.every(error => ['UNAUTHENTICATED', 'AUTHENTICATION_ERROR'].includes(error.extensions?.code)));
        check(`credentials.sample-bearer.${provider}.${token}`, rejected, { finding: 11, actual: { status: answer.status, error: code ?? errors.map(error => error.extensions?.code) },
          detail: 'Known local sample token must fail authentication on an endpoint verified with the current run credential.', ...(!rejected ? { failure_kind: 'credential_rejection_failed' } : {}) });
      }
    });
  }
  return { checks, responses, coverage };
}
