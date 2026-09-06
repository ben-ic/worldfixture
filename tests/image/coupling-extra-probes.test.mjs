import assert from 'node:assert/strict';
import test from 'node:test';
import { probeExtraWorld } from './coupling-extra-probes.mjs';

const response = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const world = () => ({ organizations: [{ id: 'org-z', slug: 'zeta', name: 'Zeta', primary: true }],
  people: [{ id: 'p.1', name: 'Zed', email: 'zed@zeta.test', github_login: 'zed', primary: true, organization_id: 'org-z' }],
  software: { repositories: [{ id: 'r.1', owner_id: 'org-z', name: 'stone', description: 'Stone record', topics: ['rock'],
    issues: [1, 2].map(number => ({ number, title: `Task ${number}`, body: `Body ${number}`, state: number === 1 ? 'open' : 'closed', author: 'zed', assignee: 'zed', labels: ['mineral'] })) }] } });
const repo = { full_name: 'zeta/stone', description: 'Stone record', topics: ['rock'] };
const issue = number => ({ number, title: `Task ${number}`, body: `Body ${number}`, state: number === 1 ? 'open' : 'closed', user: { login: 'zed' }, assignees: [{ login: 'zed' }], labels: [{ name: 'mineral' }] });
function githubFetch(calls, override = () => null) {
  return async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url), path = parsed.pathname;
    const custom = override(parsed, options);
    if (custom) return custom;
    if (path === '/user') return response({ login: 'zed' });
    if (path === '/users/zed/repos') return response([repo]);
    if (path === '/orgs/zeta') return response({ login: 'zeta', name: 'Zeta' });
    if (path === '/orgs/zeta/repos') return response([repo]);
    if (path === '/repos/zeta/stone/issues') return parsed.searchParams.get('page') === '2'
      ? response([issue(2)]) : response([issue(1)], 200, { link: '<http://github.test/repos/zeta/stone/issues?state=all&per_page=100&page=2>; rel="next"' });
    throw new Error(`Unexpected URL: ${url}`);
  };
}
const githubBindings = { GITHUB_BASE_URL: 'http://github.test', GITHUB_TOKEN: 'run-secret' };

test('GitHub reads all issue pages, closed issues, labels, and repository content', async () => {
  const calls = [];
  const result = await probeExtraWorld({ artifact: { world: world() }, bindings: githubBindings, fetchImpl: githubFetch(calls) });
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
  assert.equal(calls.filter(call => call.url.includes('/issues?')).length, 2);
  assert.ok(calls.every(call => call.options.headers.authorization === 'Bearer run-secret'));
  assert.ok(result.coverage.some(entry => entry.collection === 'software.repositories[].issues[].labels'));
});

test('organizations with no repositories still receive direct API checks', async () => {
  const source = world();
  source.organizations.push({ id: 'quiet-org', slug: 'quiet', name: 'Quiet' });
  const calls = [];
  const result = await probeExtraWorld({ artifact: { world: source }, bindings: githubBindings,
    fetchImpl: githubFetch(calls, url => url.pathname === '/orgs/quiet' ? response({ message: 'Not Found' }, 404) : null) });
  assert.ok(calls.some(call => call.url.endsWith('/orgs/quiet')));
  assert.equal(result.coverage.find(entry => entry.collection === 'organizations').status, 'failed');
  assert.ok(result.responses.some(entry => entry.path === '/orgs/quiet' && entry.status === 404));
});

test('a later GitHub page HTTP failure remains a failure and has API evidence', async () => {
  const result = await probeExtraWorld({ artifact: { world: world() }, bindings: githubBindings,
    fetchImpl: githubFetch([], url => url.pathname.endsWith('/issues') && url.searchParams.get('page') === '2' ? response({ message: 'refused' }, 503) : null) });
  assert.ok(result.checks.some(check => check.check === 'provider.github.read' && check.status === 'failed' && check.detail.includes('503')));
  assert.ok(result.responses.some(entry => entry.status === 503));
  assert.ok(!result.coverage.some(entry => entry.collection === 'software.repositories[].issues'));
});

test('GitHub rejects foreign records and changed issue fields', async () => {
  const result = await probeExtraWorld({ artifact: { world: world() }, bindings: githubBindings,
    fetchImpl: githubFetch([], url => url.pathname.endsWith('/issues') ? response([{ ...issue(1), title: 'Foreign title' }, issue(2), issue(3)]) : null) });
  assert.equal(result.checks.find(check => check.check === 'github.issues.zeta/stone').status, 'failed');
  assert.equal(result.checks.find(check => check.check === 'provider.github.read').status, 'failed');
  assert.ok(result.coverage.every(entry => entry.provider !== 'github' || entry.status === 'failed'));
});

test('pagination never sends a bound credential to another origin', async () => {
  const calls = [];
  const result = await probeExtraWorld({ artifact: { world: world() }, bindings: githubBindings,
    fetchImpl: githubFetch(calls, url => url.pathname.endsWith('/issues') ? response([issue(1)], 200, { link: '<https://outside.test/issues?page=2>; rel="next"' }) : null) });
  assert.ok(result.checks.some(check => check.status === 'failed' && check.detail?.includes('outside the bound API')));
  assert.ok(calls.every(call => new URL(call.url).origin === 'http://github.test'));
});

test('a repeated GitHub result page fails instead of ending pagination early', async () => {
  const result = await probeExtraWorld({ artifact: { world: world() }, bindings: githubBindings,
    fetchImpl: githubFetch([], url => url.pathname.endsWith('/issues') ? response([issue(1)], 200, { link: '<http://github.test/repos/zeta/stone/issues?page=2>; rel="next"' }) : null) });
  assert.ok(result.checks.some(check => check.status === 'failed' && /repeated/.test(check.detail ?? '')));
});

test('HTTP targets check real pages, APIs, RSS, metrics, and expected failing probes', async () => {
  const site = { pages: [{ path: '/stone', title: 'Stone & sand', heading: 'Stone', summary: 'Sand', sections: [{ heading: 'Sizes', body: 'Tiny stones' }] }],
    feed: { items: [{ id: 'news-1', title: 'Stone news', summary: 'Ready', path: '/stone', published_at: '2031-02-11T07:13:00Z' }] },
    metrics: [{ name: 'stone_total', value: 7 }], probes: [{ path: '/status', name: 'Stone supply', statuses: [503] }] };
  const target = { ...site, feeds: [{ path: '/news.xml', items: site.feed.items }], api: { responses: { '/api/stone': { quantity: 7 } } } };
  const payloads = { '/stone': '<title>Stone &amp; sand</title>Stone Sand Sizes Tiny stones', '/api/stone': { quantity: 7 },
    '/news.xml': '<rss><channel><item data-kind="news"><guid isPermaLink="false">news-1</guid><title>Stone news</title><description>Ready</description><link>http://http.test/stone</link><pubDate>Tue, 11 Feb 2031 07:13:00 GMT</pubDate></item></channel></rss>',
    '/metrics': 'stone_total 7\n', '/status': 'Stone supply\nStatus: unavailable\n' };
  const result = await probeExtraWorld({ artifact: { world: { site }, projections: { 'http-targets': target } }, bindings: { SITE_BASE_URL: 'http://http.test' },
    fetchImpl: async url => { const path = new URL(url).pathname; assert.ok(path in payloads); return response(payloads[path], path === '/status' ? 503 : 200); } });
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
  for (const collection of ['site.pages', 'site.pages[].sections', 'site.feed.items', 'site.metrics', 'site.probes']) assert.ok(result.coverage.some(entry => entry.collection === collection));
  assert.ok(result.responses.some(entry => entry.status === 503));
});

test('HTTP target readiness cannot hide incorrect page content or API errors', async () => {
  const artifact = { world: {}, projections: { 'http-targets': { pages: [{ path: '/stone', title: 'Owned stone', sections: [] }], metrics: [] } } };
  const wrong = await probeExtraWorld({ artifact, bindings: { HTTP_BASE_URL: 'http://http.test' }, fetchImpl: async () => response('Foreign page') });
  assert.equal(wrong.checks.find(check => check.check === 'http.page./stone').status, 'failed');
  const unavailable = await probeExtraWorld({ artifact, bindings: { HTTP_BASE_URL: 'http://http.test' }, fetchImpl: async () => response('error', 500) });
  assert.ok(unavailable.checks.some(check => check.check === 'provider.http.read' && check.status === 'failed'));
});

test('Notion traverses search and block cursors and compares source document content', async () => {
  const source = world(); source.communication = { documents: [{ id: 'doc.1', content: 'Stone sand' }] };
  const bodies = [];
  const result = await probeExtraWorld({ artifact: { world: source, projections: { notion: { pages: [{ id: 'page-1', worldfixture_document_id: 'doc.1' }, { id: 'page-2' }] } } },
    bindings: { NOTION_BASE_URL: 'http://notion.test', NOTION_TOKEN: 'run-secret' }, fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/users') return response({ results: [{ type: 'person', person: { email: 'zed@zeta.test' } }], has_more: false });
      if (parsed.pathname === '/v1/search') {
        const body = JSON.parse(options.body); bodies.push(body);
        return response(body.start_cursor ? { results: [{ object: 'page', id: 'page-2' }], has_more: false } : { results: [{ object: 'page', id: 'page-1' }], has_more: true, next_cursor: 'next-search' });
      }
      assert.equal(parsed.pathname, '/v1/blocks/page-1/children');
      const second = parsed.searchParams.has('start_cursor');
      return response({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: second ? 'sand' : 'Stone ' }] } }], has_more: !second, ...(second ? {} : { next_cursor: 'next-block' }) });
    } });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].start_cursor, 'next-search');
  assert.equal(result.checks.find(check => check.check === 'notion.document-content.doc.1').status, 'passed');
  assert.ok(result.checks.some(check => check.check === 'coverage.provider:notion.notion' && check.status === 'failed'));
});

test('Notion missing cursor fails and does not claim document coverage', async () => {
  const result = await probeExtraWorld({ artifact: { world: world(), projections: { notion: {} } }, bindings: { NOTION_BASE_URL: 'http://notion.test' },
    fetchImpl: async () => response({ results: [], has_more: true }) });
  assert.ok(result.checks.some(check => check.status === 'failed' && check.detail?.includes('no next cursor')));
  assert.equal(result.coverage.length, 0);
});

test('Microsoft follows every OData page and checks source email identities', async () => {
  const source = world(); source.people.push({ id: 'p.2', email: 'stone@zeta.test', organization_id: 'org-z' });
  const calls = [];
  const result = await probeExtraWorld({ artifact: { world: source }, bindings: { MICROSOFT_BASE_URL: 'http://microsoft.test' }, fetchImpl: async url => {
    calls.push(url); const path = new URL(url).pathname;
    if (path === '/v1.0/me') return response({ id: 'user-z', mail: 'zed@zeta.test' });
    if (path === '/oidc/userinfo') return response({ email: 'zed@zeta.test', name: 'Zed' });
    if (path === '/v1.0/users/user-z') return response({ id: 'user-z', mail: 'zed@zeta.test', displayName: 'Zed' });
    if (path === '/v1.0/next') return response({ value: [{ userPrincipalName: 'stone@zeta.test' }] });
    return response({ value: [{ mail: 'zed@zeta.test' }], '@odata.nextLink': 'http://microsoft.test/v1.0/next' });
  } });
  assert.equal(calls.length, 5);
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
});

test('Clerk offset pagination reads the next full page and checks organizations', async () => {
  const source = world(); source.people = Array.from({ length: 101 }, (_, index) => ({ id: `p.${index}`, email: `p${index}@zeta.test`, organization_id: 'org-z', primary: index === 0 }));
  const offsets = [];
  const result = await probeExtraWorld({ artifact: { world: source, projections: { clerk: { organizations: [{ slug: 'zeta' }] } } }, bindings: { CLERK_BASE_URL: 'http://clerk.test' },
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/organizations') return response({ data: [{ slug: 'zeta' }], total_count: 1 });
      const offset = Number(parsed.searchParams.get('offset')); offsets.push(offset);
      return response(source.people.slice(offset, offset + 100).map(person => ({ email_addresses: [{ email_address: person.email }] })));
    } });
  assert.deepEqual(offsets, [0, 100]);
  assert.deepEqual(result.checks.filter(check => check.status === 'failed'), []);
});

test('missing bindings and an unsupported Apple identity flow remain explicit failures', async () => {
  const result = await probeExtraWorld({ artifact: { world: world(), projections: { github: {}, apple: {} } }, bindings: {}, fetchImpl: async () => { throw new Error('No request expected'); } });
  assert.ok(result.checks.some(check => check.status === 'failed' && check.detail?.includes('Missing GITHUB_BASE_URL')));
  assert.ok(result.coverage.some(entry => entry.provider === 'apple' && entry.status === 'failed'));
});

test('GitHub reads known repository content after an unsupported organization list route', async () => {
  const calls = [];
  const result = await probeExtraWorld({ artifact: { world: world() }, bindings: githubBindings,
    fetchImpl: githubFetch(calls, url => {
      if (url.pathname === '/users/zed/repos') return response([]);
      if (url.pathname === '/orgs/zeta/repos') return response({ message: 'missing route' }, 404);
      if (url.pathname === '/repos/zeta/stone') return response(repo);
      return null;
    }) });
  assert.ok(result.checks.some(check => check.status === 'failed' && check.detail?.includes('404')));
  assert.equal(result.checks.find(check => check.check === 'github.issues.zeta/stone').status, 'passed');
  assert.ok(result.coverage.every(entry => entry.status === 'failed'));
  assert.ok(calls.some(call => new URL(call.url).pathname === '/repos/zeta/stone'));
});

test('HTTP OpenAPI allows only the verified session server addition', async () => {
  const document = { openapi: '3.0.3', info: { title: 'Stone', version: 'v1' }, paths: {} };
  const artifact = { world: {}, projections: { 'http-targets': { api: { openapi_path: '/openapi.json', document }, pages: [], metrics: [] } } };
  const run = async server => probeExtraWorld({ artifact, bindings: { SITE_BASE_URL: 'http://site.test' },
    fetchImpl: async url => response(new URL(url).pathname === '/metrics' ? '' : { ...document, servers: [{ url: server, description: 'This WorldFixture session' }] }) });
  assert.equal((await run('http://site.test')).checks.find(check => check.check === 'http.openapi').status, 'passed');
  assert.equal((await run('http://foreign.test')).checks.find(check => check.check === 'http.openapi').status, 'failed');
});

test('HTTP probe names and statuses are read while ignored authored body remains a gap', async () => {
  const result = await probeExtraWorld({ artifact: { world: {}, projections: { 'http-targets': { pages: [], metrics: [], probes: [{ name: 'Stone', path: '/status', statuses: [200], body: 'authored text' }] } } },
    bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => response(new URL(url).pathname === '/metrics' ? '' : 'Stone\nStatus: operational\n') });
  assert.equal(result.checks.find(check => check.check === 'http.probe-content./status').status, 'passed');
  assert.ok(result.coverage.some(entry => entry.status === 'failed' && entry.detail.includes('authored body')));
});

test('Clerk local data envelope is read and its API contract difference is explicit', async () => {
  const result = await probeExtraWorld({ artifact: { world: world(), projections: { clerk: { organizations: [] } } }, bindings: { CLERK_BASE_URL: 'http://clerk.test' },
    fetchImpl: async url => response(new URL(url).pathname === '/v1/users' ? { data: [{ email_addresses: [{ email_address: 'zed@zeta.test' }] }], total_count: 1 } : { data: [], total_count: 0 }) });
  assert.equal(result.checks.find(check => check.check === 'clerk.people').status, 'passed');
  assert.ok(result.checks.some(check => check.check.startsWith('clerk.response-shape.') && check.status === 'failed'));
  assert.ok(result.coverage.every(entry => entry.status === 'failed'));
});

test('Notion search honors source access declarations without hiding restricted-page gaps', async () => {
  const source = world();
  const pages = [{ id: 'page-visible', accessible_by: ['user-z'] }, { id: 'page-restricted', accessible_by: ['user-other'] }];
  const result = await probeExtraWorld({ artifact: { world: source, projections: { notion: { pages, users: [{ id: 'user-z', worldfixture_person_id: 'p.1' }] } } },
    bindings: { NOTION_BASE_URL: 'http://notion.test' }, fetchImpl: async url => response(new URL(url).pathname === '/v1/users'
      ? { results: [{ type: 'person', person: { email: 'zed@zeta.test' } }], has_more: false }
      : { results: [{ id: 'page-visible', object: 'page' }], has_more: false }) });
  assert.equal(result.checks.find(check => check.check === 'notion.page-identities').status, 'passed');
  assert.ok(result.checks.some(check => check.status === 'failed' && check.detail?.includes('restricted to other people')));
});

test('HTTP exercises every request variant in order and the stable final value', async () => {
  const variants = ['First & small', 'Second', 'Final'];
  const artifact = { world: {}, projections: { 'http-targets': { pages: [{ path: '/changing', request_variants: variants, sections: [] }], metrics: [] } } };
  const run = async initial => {
    let count = initial;
    return probeExtraWorld({ artifact, bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => {
      if (new URL(url).pathname === '/metrics') return response('');
      const variant = variants[Math.min(count++, variants.length - 1)].replace(/&/g, '&amp;');
      return response(`<aside><strong>Live note</strong><p>${variant}</p></aside>`);
    } });
  };
  const complete = await run(0);
  assert.equal(complete.responses.filter(entry => entry.path === '/changing').length, 4);
  assert.equal(complete.checks.find(check => check.check === 'http.page-variants./changing').status, 'passed');
  assert.ok(complete.coverage.some(entry => entry.collection === 'site.pages[].request_variants' && entry.status === 'passed'));
  const consumed = await run(2);
  assert.equal(consumed.checks.find(check => check.check === 'http.page-variants./changing').status, 'failed');
});

test('RSS pending delayed records have temporal scope and no false delivery claim', async () => {
  const items = [{ id: 'base', title: 'Base', summary: 'Ready', path: '/base', published_at: '2031-02-11T07:13:00Z' }, { id: 'later', title: 'Later', summary: 'Pending', available_after_seconds: 600 }];
  const result = await probeExtraWorld({ artifact: { world: {}, projections: { 'http-targets': { pages: [], metrics: [], feeds: [{ path: '/rss', items }] } } },
    bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => response(new URL(url).pathname === '/metrics' ? '' : '<rss><item><guid>base</guid><title>Base</title><description>Ready</description><link>http://site.test/base</link><pubDate>Tue, 11 Feb 2031 07:13:00 GMT</pubDate></item></rss>') });
  assert.equal(result.checks.find(check => check.check === 'http.feed-baseline./rss').status, 'passed');
  const scope = result.checks.find(check => check.check === 'http.feed-temporal-scope./rss');
  assert.deepEqual(scope.pending, [{ id: 'later', after_seconds: 600 }]);
  assert.ok(result.checks.some(check => check.failure_kind === 'reader_gap' && check.detail.includes('delayed delivery')));
  assert.ok(!result.coverage.some(entry => entry.collection === 'site.feed.items' && entry.status === 'passed'));
});

test('Twilio reads conversation contents and records a concrete unsupported key API response', async () => {
  const paths = [];
  const projection = { account: { friendly_name: 'Zeta' }, phone_numbers: [], messaging_services: [], verify_services: [],
    conversations: { services: [{ friendly_name: 'Stone support' }] }, api_keys: [{ sid: 'SK1', friendly_name: 'Stone app' }] };
  const result = await probeExtraWorld({ artifact: { world: world(), projections: { twilio: projection } },
    bindings: { TWILIO_BASE_URL: 'http://twilio.test', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'run-auth' }, fetchImpl: async (url, options) => {
      const path = new URL(url).pathname; paths.push(path);
      assert.equal(options.headers.authorization, `Basic ${Buffer.from('AC1:run-auth').toString('base64')}`);
      if (path.endsWith('/Keys.json')) return response({ message: 'Not Found' }, 404);
      if (path.endsWith('/AC1.json')) return response({ friendly_name: 'Zeta' });
      if (path.endsWith('/IncomingPhoneNumbers.json')) return response({ incoming_phone_numbers: [], next_page_uri: null });
      if (path === '/conversations/v1/Services') return response({ services: [{ sid: 'IS1', friendly_name: 'Stone support' }], next_page_uri: null });
      if (path.endsWith('/Conversations')) return response({ conversations: [], next_page_uri: null });
      return response({ services: [], next_page_uri: null });
    } });
  assert.ok(paths.includes('/conversations/v1/Services/IS1/Conversations'));
  assert.equal(result.checks.find(check => check.check === 'twilio.initial-conversations.IS1').status, 'passed');
  const keyFailure = result.checks.find(check => check.check === 'provider.twilio.api-keys.read');
  assert.equal(keyFailure.failure_kind, 'service_error');
  assert.ok(keyFailure.detail.includes('404'));
  assert.ok(result.responses.some(entry => entry.path.includes('/Keys.json') && entry.status === 404));
  assert.ok(!result.checks.some(check => check.failure_kind === 'reader_gap'));
});

test('MongoAtlas reads all document pages and detects unexpected initial rows', async () => {
  const skips = [];
  const projection = { projects: [{ name: 'Zeta' }], clusters: [{ name: 'stone' }], database_users: [], databases: [{ cluster: 'stone', name: 'quarry', collections: ['rocks'] }] };
  const result = await probeExtraWorld({ artifact: { world: world(), projections: { mongoatlas: projection } }, bindings: { MONGOATLAS_BASE_URL: 'http://atlas.test' },
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/api/atlas/v2/groups') return response({ results: [{ id: 'group1', name: 'Zeta' }] });
      if (path.endsWith('/clusters')) return response({ results: [{ name: 'stone' }] });
      if (path.endsWith('/databaseUsers')) return response({ results: [] });
      if (path.endsWith('/databases')) return response({ results: [{ databaseName: 'quarry' }] });
      if (path.endsWith('/collections')) return response({ results: [{ collectionName: 'rocks' }] });
      assert.equal(path, '/app/data-api/v1/action/find');
      const input = JSON.parse(options.body); skips.push(input.skip);
      assert.deepEqual({ cluster: input.dataSource, database: input.database, collection: input.collection }, { cluster: 'stone', database: 'quarry', collection: 'rocks' });
      return response({ documents: input.skip ? [{ _id: 'foreign-last' }] : Array.from({ length: 100 }, (_, index) => ({ _id: `foreign-${index}` })) });
    } });
  assert.deepEqual(skips, [0, 100]);
  const content = result.checks.find(check => check.check === 'mongoatlas.initial-documents.stone.quarry.rocks');
  assert.equal(content.status, 'failed');
  assert.equal(content.actual.length, 101);
  assert.ok(result.coverage.every(entry => entry.status === 'failed'));
  assert.ok(!result.checks.some(check => check.failure_kind === 'reader_gap'));
});

test('separately supplied Notion and Apple readers disable only duplicate readers', async () => {
  const result = await probeExtraWorld({ artifact: { world: world(), projections: { notion: {}, apple: {} } }, bindings: {}, supplementalNotion: true, supplementalApple: true,
    fetchImpl: async () => { throw new Error('No request expected'); } });
  assert.deepEqual(result, { checks: [], responses: [], coverage: [] });
});

test('RSS detects duplicate IDs and item order changes', async () => {
  const items = ['one', 'two'].map(id => ({ id, title: id, summary: id, path: `/${id}`, published_at: '2031-02-11T07:13:00Z' }));
  const render = id => `<item><guid>${id}</guid><title>${id}</title><description>${id}</description><link>http://site.test/${id}</link><pubDate>Tue, 11 Feb 2031 07:13:00 GMT</pubDate></item>`;
  for (const served of [['one', 'one', 'two'], ['two', 'one']]) {
    const result = await probeExtraWorld({ artifact: { world: {}, projections: { 'http-targets': { pages: [], metrics: [], feeds: [{ path: '/rss', items }] } } },
      bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => response(new URL(url).pathname === '/metrics' ? '' : `<rss>${served.map(render).join('')}</rss>`) });
    const check = served.length === 3 ? 'http.feed-duplicate-ids./rss' : 'http.feed-order./rss';
    assert.equal(result.checks.find(entry => entry.check === check).status, 'failed');
    assert.equal(result.checks.find(entry => entry.check === 'provider.http.read').status, 'failed');
  }
});

test('RSS rejects foreign links and changed publication dates', async () => {
  const item = { id: 'one', title: 'One', summary: 'One', path: '/one', published_at: '2031-02-11T07:13:00Z' };
  for (const [link, date] of [['http://foreign.test/one', 'Tue, 11 Feb 2031 07:13:00 GMT'], ['http://site.test/one', 'Tue, 11 Feb 2031 08:13:00 GMT']]) {
    const result = await probeExtraWorld({ artifact: { world: {}, projections: { 'http-targets': { pages: [], metrics: [], feeds: [{ path: '/rss', items: [item] }] } } },
      bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => response(new URL(url).pathname === '/metrics' ? '' : `<rss><item><guid>one</guid><title>One</title><description>One</description><link>${link}</link><pubDate>${date}</pubDate></item></rss>`) });
    assert.equal(result.checks.find(entry => entry.check === 'http.feed-content.one').status, 'failed');
  }
});

test('HTTP probe status checks cover two full cycles and reject wrong transitions', async () => {
  const statuses = [200, 200, 503, 200];
  for (const wrong of [false, true]) {
    let count = 0;
    const result = await probeExtraWorld({ artifact: { world: {}, projections: { 'http-targets': { pages: [], metrics: [], probes: [{ path: '/status', name: 'Stone', statuses }] } } },
      bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => {
        if (new URL(url).pathname === '/metrics') return response('');
        const index = count++, status = wrong && index === 2 ? 200 : statuses[index % statuses.length];
        return response(`Stone\nStatus: ${status === 200 ? 'operational' : 'unavailable'}\n`, status);
      } });
    assert.equal(count, 8);
    assert.equal(result.checks.find(entry => entry.check === 'http.probe-status-sequence./status').status, wrong ? 'failed' : 'passed');
    assert.equal(result.checks.find(entry => entry.check === 'provider.http.read').status, wrong ? 'failed' : 'passed');
  }
});

test('HTTP feed expectations resolve authored arrival IDs and reject wrong projected delays', async () => {
  const item = { id: 'later', arrival_id: 'arrival-1', title: 'Later', summary: 'Ready later', path: '/later', published_at: '2031-02-11T07:13:00Z' };
  const source = { timeline: [{ id: 'arrival-1', after_seconds: 20 }], site: { feed: { path: '/rss', items: [item] } } };
  for (const delay of [20, 99]) {
    const { arrival_id: _arrival, ...content } = item;
    const result = await probeExtraWorld({ artifact: { world: source, projections: { 'http-targets': { pages: [], metrics: [], feeds: [{ path: '/rss', items: [{ ...content, available_after_seconds: delay }] }] } } },
      bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async url => response(new URL(url).pathname === '/metrics' ? '' : '<rss></rss>') });
    assert.equal(result.checks.find(entry => entry.check === 'http.feed-projection-completeness').status, delay === 20 ? 'passed' : 'failed');
    assert.ok(result.checks.some(entry => entry.failure_kind === 'reader_gap' && entry.detail.includes('delayed delivery')));
  }
});

test('HTTP metric expectations use source records and reject a wrong projected amount', async () => {
  const definitions = [
    [{ count: 'people' }, 2], [{ count: 'open_support_cases' }, 1], [{ count: 'open_issues_with_label', label: 'release' }, 1],
    [{ count: 'open_invoice_cents' }, 2300], [{ count: 'overdue_invoice_cents' }, 600],
    [{ count: 'orders' }, 2], [{ count: 'orders', status: 'shipped' }, 1], [{ count: 'order_value_cents' }, 3500],
    [{ count: 'products', status: 'active' }, 1], [{ count: 'reviews', min_rating: 3 }, 1], [{ count: 'literal', value: 17 }, 17],
  ];
  const source = { people: [{ id: 'one' }, { id: 'two' }], support: { cases: [{ state: 'engineering' }, { state: 'resolved' }] },
    software: { repositories: [{ issues: [{ state: 'open', labels: ['release'] }, { state: 'closed', labels: ['release'] }] }] },
    finance: { resolved: { invoices: [{ status: 'open', amount_cents: 2300 }, { status: 'overdue', amount_cents: 600 }, { status: 'paid', amount_cents: 8000 }] } },
    commerce: { orders: [{ status: 'shipped', total_cents: 2500 }, { status: 'placed', total_cents: 1000 }], products: [{ status: 'active' }, { status: 'retired' }] },
    social: { reviews: [{ rating: 2 }, { rating: 5 }] },
    site: { metrics: definitions.map(([metricSource], index) => ({ name: `metric_${index}`, help: `Source metric ${index}`, source: metricSource })) } };
  for (const corrupt of [false, true]) {
    const metrics = definitions.map(([, value], index) => ({ name: `metric_${index}`, help: `Source metric ${index}`, type: 'gauge', value: value + (corrupt && index === 3 ? 1 : 0) }));
    const result = await probeExtraWorld({ artifact: { world: source, projections: { 'http-targets': { pages: [], feeds: [], probes: [], metrics } } },
      bindings: { SITE_BASE_URL: 'http://site.test' }, fetchImpl: async () => response(metrics.map(metric => `${metric.name} ${metric.value}`).join('\n')) });
    assert.equal(result.checks.find(entry => entry.check === 'http.metrics-source').status, corrupt ? 'failed' : 'passed');
    assert.equal(result.checks.find(entry => entry.check === 'http.metric.metric_3').status, 'passed');
  }
});

test('profile-less GitHub reads use derived source logins and an authored primary token identity', async () => {
  const {sourceGithubLogin} = await import('./coupling-source-contracts.mjs');
  const source = {people: [{id: 'person-47.uncommon', name: 'Tavi', primary: true}], organizations: [{id: 'org-a', name: 'One'}], software: {repositories: [{id: 'repo-a', owner_id: 'org-a', issues: [{id: 'issue-a', number: 1, title: 'Exact title', state: 'open', author_id: 'person-47.uncommon', assignee_id: 'person-47.uncommon'}]}]}};
  const login = sourceGithubLogin(source.people[0]);
  const result = await probeExtraWorld({artifact: {world: source}, bindings: githubBindings, fetchImpl: async url => {
    const path = new URL(url).pathname;
    if (path === '/user') return response({login});
    if (path === `/users/${login}/repos`) return response([]);
    if (path === '/orgs/org-a') return response({login: 'org-a', name: 'One'});
    if (path === '/orgs/org-a/repos') return response([{full_name: 'org-a/repo-a', description: '', topics: []}]);
    if (path === '/repos/org-a/repo-a/issues') return response([{number: 1, title: 'Exact title', state: 'open', body: '', user: {login}, assignees: [{login}], labels: []}]);
    throw new Error(`Unexpected ${path}`);
  }});
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(result.checks.find(row => row.check === 'github.source-current-actor').actual.selection, 'authored-primary');
  assert.equal(source.people[0].github_login, undefined); assert.equal(source.people[0].primary, true);
});

test('body-only HTTP pages check their escaped body and reject a missing body', async () => {
  for (const correct of [true, false]) {
    const page = {path: '/non-root', title: 'Page', body: '<record & evidence>'};
    const result = await probeExtraWorld({artifact: {world: {site: {pages: [page]}}, projections: {'http-targets': {pages: [page]}}}, bindings: {SITE_BASE_URL: 'http://site.test'},
      fetchImpl: async () => response(`<h1>Page</h1>${correct ? '<p>&lt;record &amp; evidence&gt;</p>' : ''}`)});
    assert.equal(result.checks.find(row => row.check === 'http.page./non-root').status, correct ? 'passed' : 'failed');
  }
});

test('an absent optional provider makes no requests, while a declared provider without binding fails', async () => {
  const request = async () => {throw new Error('Unexpected provider request');};
  const absent = await probeExtraWorld({artifact: {world: {commerce: {orders: []}}, projections: {}}, bindings: {}, fetchImpl: request});
  assert.deepEqual(absent.checks, []);
  const declared = await probeExtraWorld({artifact: {world: {}, projections: {github: {repos: []}}}, bindings: {}, fetchImpl: request});
  assert.ok(declared.checks.some(row => row.status === 'failed' && row.failure_kind === 'binding_missing'));
});
