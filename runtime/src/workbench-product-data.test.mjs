import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readProductCollection, readClerkOverview, readVercelOverview, readResendOverview, readMongoAtlasOverview, readTwilioOverview } from './workbench-product-data.mjs';
const rows = (count, prefix = 'row') => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));
const url = path => new URL(path, 'http://provider.invalid');

test('Okta reads every numeric page and retains observed users if a later page fails', async () => {
  const source = rows(235), calls = [];
  const read = async path => { const page = Number(url(path).searchParams.get('page')); calls.push(page); return source.slice((page - 1) * 100, page * 100); };
  assert.deepEqual(await readProductCollection(read, '/api/v1/users', { mode: 'okta' }), { rows: source, status: 'complete' });
  assert.deepEqual(calls, [1, 2, 3]);
  const failure = await readProductCollection(async path => { if (url(path).searchParams.get('page') === '2') throw new Error('offline'); return source.slice(0, 100); }, '/api/v1/users', { mode: 'okta' });
  assert.equal(failure.status, 'failed'); assert.equal(failure.rows.length, 100); assert.match(failure.error, /offline/);
});

test('Okta repeating a full page fails rather than claiming a complete directory', async () => {
  const result = await readProductCollection(async () => rows(100), '/users', { mode: 'okta' });
  assert.equal(result.status, 'failed'); assert.equal(result.rows.length, 100);
});

test('Clerk follows offsets and checks the reported total independently for every collection', async () => {
  const source = rows(215);
  const result = await readClerkOverview(async path => { const offset = Number(url(path).searchParams.get('offset')); return { data: source.slice(offset, offset + 100), total_count: 215, has_more: offset + 100 < 215 }; });
  assert.equal(result.users.length, 215); assert.equal(result.collectionStatus.sessions.status, 'complete');
  const failure = await readProductCollection(async () => ({ data: [], total_count: 20, has_more: false }), '/users', { mode: 'clerk' });
  assert.equal(failure.status, 'failed'); assert.match(failure.error, /total/);
});

test('Vercel inclusive cursors retain each boundary record once and read all team scopes', async () => {
  const source = rows(205).map((row, i) => ({ ...row, created: 1000 - i }));
  const result = await readVercelOverview(async path => {
    const parsed = url(path);
    if (parsed.pathname === '/v2/teams') return { teams: [{ id: 'team-1' }], pagination: { count: 1, next: null } };
    if (!parsed.searchParams.has('teamId')) {
      const key = parsed.pathname.includes('projects') ? 'projects' : 'deployments';
      return { [key]: [], pagination: { count: 0, next: null } };
    }
    assert.equal(parsed.searchParams.get('teamId'), 'team-1');
    const until = parsed.searchParams.has('until') ? Number(parsed.searchParams.get('until')) : Infinity;
    const remaining = source.filter(row => row.created <= until), batch = remaining.slice(0, 100);
    const key = parsed.pathname.includes('projects') ? 'projects' : 'deployments';
    return { [key]: key === 'deployments' ? batch.map(({ id, ...row }) => ({ ...row, uid: id })) : batch, pagination: { count: batch.length, next: remaining.length > 100 ? batch.at(-1).created : null } };
  });
  assert.deepEqual(result.projects, source); assert.equal(result.deployments.length, 205); assert.equal(result.deployments[0].uid, source[0].id); assert.equal(result.collectionStatus.deployments.status, 'complete');
});

test('Vercel timestamp ties that cannot advance produce an unknown total', async () => {
  const result = await readProductCollection(async () => ({ projects: rows(100), pagination: { count: 100, next: 42 } }), '/v10/projects', { mode: 'vercel', key: 'projects' });
  assert.equal(result.status, 'failed'); assert.equal(result.rows.length, 100); assert.match(result.error, /cannot advance/);
});

test('Resend complete list contract keeps all emails; a failed audience read makes contacts unknown', async () => {
  const result = await readResendOverview(async path => {
    if (path.includes('/contacts')) throw new Error('contacts unavailable');
    return { object: 'list', data: path === '/emails' ? rows(212) : path === '/audiences' ? [{ id: 'audience' }] : [] };
  });
  assert.equal(result.emails.length, 212); assert.equal(result.collectionStatus.emails.status, 'complete');
  assert.equal(result.collectionStatus.contactGroups.status, 'failed');
  assert.equal(result.contactGroups[0].collectionStatus.contacts.status, 'failed');
});

test('Atlas failed collection read cannot appear as an empty database; parent and sibling totals stay separate', async () => {
  const values = {
    '/api/atlas/v2/groups': [{ id: 'group' }],
    '/api/atlas/v2/groups/group/clusters': [{ id: 'cluster', name: 'Cluster' }],
    '/api/atlas/v2/groups/group/databaseUsers': [{ username: 'operator' }],
    '/api/atlas/v2/groups/group/clusters/Cluster/databases': [{ databaseName: 'business' }],
  };
  const result = await readMongoAtlasOverview(async path => {
    if (path.endsWith('/collections')) throw new Error('collection read failed');
    assert.ok(values[path], path); return { results: values[path], totalCount: values[path].length };
  });
  assert.equal(result.collectionStatus.databases.status, 'complete');
  assert.equal(result.collectionStatus.collections.status, 'failed');
  assert.equal(result.databases[0].collectionStatus.collections.status, 'failed');
  assert.equal(result.collectionStatus.databaseUsers.status, 'complete');
  const truncated = await readProductCollection(async () => ({ results: rows(100), totalCount: 101 }), '/groups', { mode: 'atlas', key: 'results' });
  assert.equal(truncated.status, 'failed');
});

test('Twilio advances numeric pages without losing the selected service prefix', async () => {
  const source = rows(221).map(row => ({ sid: row.id })), paths = [];
  const result = await readTwilioOverview(async path => {
    if (path === '/2010-04-01/Accounts/AC1.json') return { sid: 'AC1' };
    paths.push(path); const parsed = url(path), page = Number(parsed.searchParams.get('Page'));
    const batch = source.slice(page * 100, (page + 1) * 100);
    assert.ok(parsed.pathname.startsWith('/2010-04-01/') || parsed.pathname.startsWith('/messaging/') || parsed.pathname.startsWith('/verify/'));
    const key = parsed.pathname.includes('IncomingPhoneNumbers') ? 'incoming_phone_numbers' : 'services';
    return { [key]: batch, page, next_page_uri: page < 2 ? `/v1/Services?PageSize=100&Page=${page + 1}` : null };
  }, { accountSid: 'AC1' });
  assert.equal(result.phone_numbers.length, 221); assert.equal(result.messaging_services.length, 221);
  assert.equal(result.collectionStatus.verify_services.status, 'complete'); assert.equal(paths.length, 9);
});

test('Missing metadata and a foreign Twilio next URL fail instead of inventing complete counts', async () => {
  for (const mode of ['clerk', 'vercel', 'twilio', 'resend', 'atlas']) {
    const result = await readProductCollection(async () => ({ data: [] }), '/records', { mode });
    assert.equal(result.status, 'failed', mode);
  }
  const result = await readProductCollection(async () => ({ data: [{ sid: 'one' }], page: 0, next_page_uri: 'https://foreign.invalid/?Page=1' }), '/services', { mode: 'twilio', identity: row => row.sid });
  assert.equal(result.status, 'failed'); assert.equal(result.rows.length, 1);
});


test('Vercel includes personal records even when the user belongs to a team', async () => {
  const result = await readVercelOverview(async path => {
    const parsed = url(path), team = parsed.searchParams.get('teamId');
    const key = parsed.pathname === '/v2/teams' ? 'teams' : parsed.pathname.includes('projects') ? 'projects' : 'deployments';
    const value = key === 'teams' ? [{ id: 'team' }] : key === 'projects' ? [{ id: team ? 'team-project' : 'personal-project' }] : [{ uid: team ? 'team-deployment' : 'personal-deployment' }];
    return { [key]: value, pagination: { count: 1, next: null } };
  });
  assert.deepEqual(result.projects.map(row => row.id), ['personal-project', 'team-project']);
  assert.deepEqual(result.deployments.map(row => row.uid), ['personal-deployment', 'team-deployment']);
  assert.equal(result.collectionStatus.projects.status, 'complete');
});
