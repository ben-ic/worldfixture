/** Supplemental public API evidence. Projection checks never stand in for API reads. */
import {sourceGithubLogin, sourcePrimaryPerson, sourceProviderActor, sourceProviderPeople} from './coupling-source-contracts.mjs';
export const SUPPLEMENTAL_PROVIDERS = ['github', 'http', 'site', 'microsoft', 'okta', 'clerk', 'vercel', 'resend', 'twilio', 'mongoatlas', 'apple', 'notion', 'notion_admin'];
const rows = value => Array.isArray(value) ? value : [];
const sorted = values => [...values].sort();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const encode = encodeURIComponent;
const decodeXml = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');

function sourceMetricValue(source, world) {
  const statusMatches = value => source.status === undefined || value.status === source.status;
  const sum = (values, field) => values.reduce((total, value) => total + Number(value[field]), 0);
  switch (source.count) {
    case 'people': return rows(world.people).length;
    case 'open_support_cases': return rows(world.support?.cases).filter(value => value.state !== 'resolved').length;
    case 'open_issues_with_label': return rows(world.software?.repositories).flatMap(repo => rows(repo.issues))
      .filter(issue => issue.state === 'open' && rows(issue.labels).includes(source.label)).length;
    case 'open_invoice_cents': return sum(rows(world.finance?.resolved?.invoices ?? world.finance?.invoices ?? world.finance?.anchor_invoices).filter(invoice => invoice.status === 'open'), 'amount_cents');
    case 'overdue_invoice_cents': return sum(rows(world.finance?.resolved?.invoices ?? world.finance?.invoices ?? world.finance?.anchor_invoices).filter(invoice => invoice.status === 'overdue'), 'amount_cents');
    case 'orders': return rows(world.commerce?.orders).filter(statusMatches).length;
    case 'order_value_cents': return sum(rows(world.commerce?.orders).filter(statusMatches), 'total_cents');
    case 'products': return rows(world.commerce?.products).filter(statusMatches).length;
    case 'reviews': return rows(world.social?.reviews).filter(review => source.min_rating === undefined || Number(review.rating ?? 0) >= Number(source.min_rating)).length;
    case 'literal': return Number(source.value);
    default: throw new Error(`No source metric reader for ${JSON.stringify(source.count)}`);
  }
}

export async function probeExtraWorld({ artifact, bindings, fetchImpl = fetch, supplementalNotion = false, supplementalApple = false, supplementalTemporal = false }) {
  const world = artifact.world, projections = artifact.projections ?? {};
  const checks = [], responses = [], coverage = [];
  const failedProviders = new Set();
  const primary = sourcePrimaryPerson(world, {emailOnly: true});
  const orgs = rows(world.organizations), primaryOrg = orgs.find(org => org.primary);
  const staff = sourceProviderPeople(world, {emailOnly: true});
  const check = (name, passed, detail = {}) => checks.push({ check: name, status: passed ? 'passed' : 'failed', ...detail });
  const compare = (name, expected, actual) => check(name, same(expected, actual), { expected, actual });
  const covered = (collection, provider, path, detail) => coverage.push({ collection, provider, path, status: 'passed', detail });
  const gap = (provider, detail, collection = `provider:${provider}`, failure_kind = 'reader_gap') => {
    failedProviders.add(provider);
    check(`coverage.${collection}.${provider}`, false, { detail, failure_kind });
    coverage.push({ collection, provider, path: null, status: 'failed', detail, failure_kind });
  };
  const selected = provider => Boolean(bindings[`${provider.toUpperCase()}_BASE_URL`] || projections[provider === 'http' ? 'http-targets' : provider]
    || (provider === 'http' && bindings.SITE_BASE_URL) || (provider === 'notion' && bindings.NOTION_ADMIN_BASE_URL));
  async function request(provider, path, { raw = false, acceptStatuses, ...options } = {}) {
    const base = provider === 'http' ? bindings.SITE_BASE_URL ?? bindings.HTTP_BASE_URL : bindings[`${provider.toUpperCase()}_BASE_URL`];
    if (!base) throw new Error(`Missing ${provider.toUpperCase()}_BASE_URL`);
    const prefix = base.replace(/\/$/, '');
    const url = /^https?:/.test(path) ? new URL(path) : new URL(`${prefix}${path}`);
    const origin = new URL(base);
    if (url.origin !== origin.origin || !url.pathname.startsWith(`${origin.pathname.replace(/\/$/, '')}/`)) {
      throw new Error('Provider pagination URL is outside the bound API');
    }
    const token = bindings[`${provider.toUpperCase()}_TOKEN`];
    const response = await fetchImpl(url.href, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers } });
    const text = await response.text();
    let body;
    try { body = raw ? text : JSON.parse(text); } catch { body = text; }
    responses.push({ provider, path, status: response.status, body });
    if (!(acceptStatuses ? acceptStatuses.includes(response.status) : response.ok)) throw new Error(`${path} returned HTTP ${response.status}`);
    if (!raw && (!body || typeof body !== 'object')) throw new Error(`${path} returned invalid JSON`);
    if (!raw && (body.error || body.errors?.length || body.ok === false)) throw new Error(`${path} returned an API error`);
    return { body, headers: response.headers, status: response.status };
  }
  async function run(provider, operation) {
    const start = checks.length;
    try {
      await operation();
      const failures = checks.slice(start).filter(entry => entry.status === 'failed');
      check(`provider.${provider}.read`, failures.length === 0, failures.length ? { detail: `${failures.length} contained checks failed.` } : {});
    }
    catch (error) {
      const failure_kind = /^Missing /.test(error.message) ? 'binding_missing'
        : /returned HTTP|returned an API error/.test(error.message) ? 'service_error' : 'protocol_error';
      check(`provider.${provider}.read`, false, { detail: error.message, failure_kind });
    }
    if (checks.slice(start).some(entry => entry.status === 'failed')) failedProviders.add(provider);
  }
  for (const provider of ['github', 'microsoft', 'vercel']) if (selected(provider)) {
    const actor = sourceProviderActor(world, {emailOnly: provider !== 'github'});
    check(`${provider}.source-current-actor`, !!actor.person, {actual: {person_id: actor.person?.id ?? null, selection: actor.selection}, detail: 'Native provider token selection only; the canonical person primary field is unchanged.'});
  }
  // All pagination URLs stay inside the bound provider. Missing or repeated
  // cursors fail; list responses must contain the documented array shape.
  async function list(provider, firstPath, { key, mode = 'link', method = 'GET', body = {}, headers = {}, pageSize = 100, acceptDataEnvelope = false } = {}) {
    let path = firstPath, offset = 0;
    const output = [], seen = new Set(), pages = new Set();
    for (let page = 0; page < 10000; page++) {
      const answer = await request(provider, path, { method, headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
      let values = key ? answer.body[key] : answer.body;
      if (acceptDataEnvelope && !Array.isArray(values) && Array.isArray(answer.body.data)) {
        values = answer.body.data;
        check(`${provider}.response-shape.${firstPath}`, false, { detail: 'Local API returns {data,total_count}; the public users list contract returns an array. Content is still checked.' });
      }
      if (!Array.isArray(values)) throw new Error(`${path} returned no ${key ?? 'array'} list`);
      const signature = JSON.stringify(values);
      if (values.length && pages.has(signature)) throw new Error(`${path} repeated a result page`);
      pages.add(signature); output.push(...values);
      let next = answer.headers?.get('link')?.match(/<([^>]+)>;\s*rel="?next"?/)?.[1];
      const parsed = new URL(path, 'http://pagination.test');
      if (!next && mode === 'page' && values.length === pageSize) {
        parsed.searchParams.set('page', String(page + 2)); next = parsed.pathname + parsed.search;
      }
      if (!next && mode === 'offset' && (answer.body.total_count > output.length || values.length === pageSize)) {
        offset += values.length; parsed.searchParams.set('offset', String(offset)); next = parsed.pathname + parsed.search;
      }
      if (!next && mode === 'odata') next = answer.body['@odata.nextLink'];
      if (!next && mode === 'vercel' && answer.body.pagination?.next) {
        parsed.searchParams.set('until', String(answer.body.pagination.next)); next = parsed.pathname + parsed.search;
      }
      if (!next && mode === 'twilio') next = answer.body.next_page_uri ?? answer.body.meta?.next_page_url;
      if (!next && mode === 'atlas') next = rows(answer.body.links).find(link => link.rel === 'next')?.href;
      if (!next && ['notion', 'resend'].includes(mode) && answer.body.has_more) {
        const cursor = mode === 'notion' ? answer.body.next_cursor : values.at(-1)?.id;
        if (!cursor) throw new Error(`${path} has_more has no next cursor`);
        if (method === 'POST') { body = { ...body, start_cursor: cursor }; next = `${firstPath}#${encode(cursor)}`; }
        else { parsed.searchParams.set(mode === 'notion' ? 'start_cursor' : 'after', cursor); next = parsed.pathname + parsed.search; }
      }
      if (!next) {
        if (answer.body.has_more || answer.body.totalCount > output.length || answer.body.total_count > output.length) throw new Error(`${path} has unread rows but no next page`);
        return output;
      }
      if (seen.has(next)) throw new Error(`${path} repeated a pagination cursor`);
      seen.add(next); path = next;
    }
    throw new Error(`${firstPath} exceeded the pagination limit`);
  }

  if (selected('github')) await run('github', async () => {
    const identity = (await request('github', '/user')).body;
    compare('github.current-identity', sourceGithubLogin(sourcePrimaryPerson(world)), identity.login);
    const repositories = new Map();
    await run('github.user-repositories', async () => {
      for (const repo of await list('github', `/users/${encode(identity.login)}/repos?per_page=100&page=1`, { mode: 'page' })) repositories.set(repo.full_name, repo);
    });
    const expectedRepos = rows(world.software?.repositories);
    const owners = new Set(expectedRepos.map(repo => orgs.find(org => org.id === repo.owner_id)?.slug ?? repo.owner_id));
    for (const owner of new Set([...owners, ...orgs.map(org => org.slug ?? org.id)])) await run(`github.organization.${owner}`, async () => {
      const organization = (await request('github', `/orgs/${encode(owner)}`)).body;
      const expected = orgs.find(org => (org.slug ?? org.id) === owner);
      compare(`github.organization.${owner}`, { login: owner, name: expected?.name }, { login: organization.login, name: organization.name });
      if (owners.has(owner)) for (const repo of await list('github', `/orgs/${encode(owner)}/repos?per_page=100&page=1`, { mode: 'page' })) repositories.set(repo.full_name, repo);
    });
    const nameOf = repo => `${orgs.find(org => org.id === repo.owner_id)?.slug ?? repo.owner_id}/${repo.name ?? repo.id}`;
    compare('github.repositories', sorted(expectedRepos.map(nameOf)), sorted(repositories.keys()));
    // A missing collection route remains a failure. Direct source-addressed
    // reads collect useful record evidence without claiming complete discovery.
    for (const source of expectedRepos) if (!repositories.has(nameOf(source))) await run(`github.repository.${nameOf(source)}`, async () => {
      const name = nameOf(source);
      repositories.set(name, (await request('github', `/repos/${name.split('/').map(encode).join('/')}`)).body);
    });
    for (const [name, repo] of repositories) {
      const source = expectedRepos.find(value => nameOf(value) === name);
      compare(`github.repository-content.${name}`, { description: source?.description ?? '', topics: sorted(rows(source?.topics)) },
        { description: repo.description, topics: sorted(rows(repo.topics)) });
      const issues = (await list('github', `/repos/${name.split('/').map(encode).join('/')}/issues?state=all&per_page=100&page=1`, { mode: 'page' })).filter(issue => !issue.pull_request);
      const login = value => { const person = rows(world.people).find(person => person.id === value); return person ? sourceGithubLogin(person) : value; };
      const signature = issue => JSON.stringify([issue.number, issue.title, issue.body ?? '', issue.state,
        login(issue.author_id ?? issue.author ?? issue.user?.login), sorted(issue.assignee_id ? [login(issue.assignee_id)] : issue.assignees ? issue.assignees.map(person => login(typeof person === 'string' ? person : person.login)) : issue.assignee ? [login(typeof issue.assignee === 'string' ? issue.assignee : issue.assignee.login)] : []),
        sorted(rows(issue.labels).map(label => typeof label === 'string' ? label : label.name))]);
      compare(`github.issues.${name}`, sorted(rows(source?.issues).map(signature)), sorted(issues.map(signature)));
    }
    covered('software.repositories', 'github', '/orgs/{owner}/repos', 'All pages; source owner/name, descriptions and topics.');
    covered('software.repositories[].topics', 'github', '/orgs/{owner}/repos', 'Source topic names.');
    covered('software.repositories[].issues', 'github', '/repos/{owner}/{repo}/issues', 'All states and pages; number, title, body, author, assignees and labels.');
    covered('software.repositories[].issues[].labels', 'github', '/repos/{owner}/{repo}/issues', 'Each source issue label.');
    covered('organizations', 'github', '/orgs/{source-slug}', 'Every source organization login and name, including organizations with no repositories. An unsupported or missing organization remains an API failure.');
  });

  if (selected('http')) await run('http', async () => {
    const target = projections['http-targets'];
    if (!target) throw new Error('Selected HTTP service has no target projection');
    for (const [path, expected] of Object.entries(target.api?.responses ?? {})) {
      compare(`http.api.${path}`, expected, (await request('http', path)).body);
    }
    if (target.api?.openapi_path) {
      const actual = (await request('http', target.api.openapi_path)).body;
      const base = (bindings.SITE_BASE_URL ?? bindings.HTTP_BASE_URL).replace(/\/$/, '');
      compare('http.openapi', { ...target.api.document, servers: [{ url: base, description: 'This WorldFixture session' }] }, actual);
    }
    for (const page of rows(target.pages)) {
      const content = decodeXml((await request('http', page.path, { raw: true })).body);
      const expected = [page.title, page.heading, page.summary, page.body, ...rows(page.sections).flatMap(section => [section.heading, section.body])].filter(Boolean);
      compare(`http.page.${page.path}`, [], expected.filter(text => !content.includes(text)));
      if (rows(page.request_variants).length) {
        const observed = [], variants = page.request_variants;
        let current = content;
        // The matrix gives this reader a new isolated process. A prior reader
        // consuming the first counter value is an isolation error, not a reason
        // to omit earlier variants from the expectation.
        for (let index = 0; index <= variants.length; index++) {
          if (index > 0) current = decodeXml((await request('http', page.path, { raw: true })).body);
          observed.push(current.match(/<aside>\s*<strong>Live note<\/strong>\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? null);
        }
        compare(`http.page-variants.${page.path}`, [...variants, variants.at(-1)], observed);
        covered('site.pages[].request_variants', 'http', page.path, 'Every declared variant in order, followed by the stable final variant; real GETs from the initial isolated counter state.');
      }
    }
    if (world.site?.pages) {
      compare('http.page-projection-completeness', sorted(world.site.pages.map(page => page.path)), sorted(rows(target.pages).filter(page => world.site.pages.some(source => source.path === page.path)).map(page => page.path)));
      for (const page of world.site.pages) compare(`http.page-source.${page.path}`, page, rows(target.pages).find(value => value.path === page.path));
      covered('site.pages', 'http', '/{declared-page}', 'Source fields and projection content checked against actual HTML.');
      covered('site.pages[].sections', 'http', '/{declared-page}', 'Section headings and body text in actual HTML.');
    }
    for (const feed of rows(target.feeds)) {
      const content = (await request('http', feed.path, { raw: true })).body;
      const items = [...content.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)].map(match => Object.fromEntries(['guid', 'title', 'description', 'link', 'pubDate'].map(tag => [tag, decodeXml(match[1].match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? '')])));
      const declared = rows(feed.items), ids = items.map(item => item.guid);
      const origin = (bindings.SITE_BASE_URL ?? bindings.HTTP_BASE_URL).replace(/\/$/, '');
      compare(`http.feed-unknown.${feed.path}`, [], ids.filter(id => !declared.some(item => item.id === id)));
      compare(`http.feed-duplicate-ids.${feed.path}`, [], ids.filter((id, index) => ids.indexOf(id) !== index));
      compare(`http.feed-baseline.${feed.path}`, [], declared.filter(item => !item.available_after_seconds && !ids.includes(item.id)).map(item => item.id));
      compare(`http.feed-order.${feed.path}`, declared.filter(item => ids.includes(item.id)).map(item => item.id), ids);
      for (const item of items) {
        const expected = declared.find(value => value.id === item.guid);
        compare(`http.feed-content.${item.guid}`, { title: expected?.title, description: expected?.summary,
          link: expected?.path ? origin + expected.path : null,
          pubDate: expected?.published_at ? new Date(expected.published_at).toUTCString() : null },
        { title: item.title, description: item.description, link: item.link, pubDate: item.pubDate });
      }
      const delayed = declared.filter(item => item.available_after_seconds);
      if (delayed.length) {
        const pending = delayed.filter(item => !ids.includes(item.id)).map(item => ({ id: item.id, after_seconds: item.available_after_seconds }));
        check(`http.feed-temporal-scope.${feed.path}`, true, { scope: 'baseline and content observed at read time', pending,
          observed_delayed_ids: delayed.filter(item => ids.includes(item.id)).map(item => item.id),
          detail: 'Pending records are not expected before their declared delay. This read does not prove clock-controlled delivery.' });
        if (!supplementalTemporal) gap('http', `Baseline RSS content was checked at ${feed.path}; clock-controlled delayed delivery remains untested (${pending.length} records pending at read time).`, 'site.feed.items');
      }
    }
    if (world.site?.feed?.items) {
      const expected = world.site.feed.items.map(item => {
        const { arrival_id, ...record } = item;
        if (arrival_id === undefined) return record;
        const arrival = rows(world.timeline).find(event => event.id === arrival_id);
        check(`http.feed-source-arrival.${item.id}`, Boolean(arrival), { expected: arrival_id, actual: arrival?.id ?? null });
        return { ...record, available_after_seconds: arrival?.after_seconds ?? null };
      });
      const matchingFeeds = rows(target.feeds).filter(feed => !world.site.feed.path || feed.path === world.site.feed.path);
      compare('http.feed-projection-completeness', expected, matchingFeeds.flatMap(feed => rows(feed.items)));
      if (supplementalTemporal || !rows(target.feeds).some(feed => rows(feed.items).some(item => item.available_after_seconds))) covered('site.feed.items', 'http', '/{declared-feed}', 'Source IDs, multiplicity, order, titles, summaries, session links, and publication dates from baseline RSS and its source projection. Delayed delivery requires the separate temporal evidence.');
    }
    const metrics = (await request('http', '/metrics', { raw: true })).body;
    for (const metric of rows(target.metrics)) {
      const escaped = metric.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      compare(`http.metric.${metric.name}`, Number(metric.value), Number(metrics.match(new RegExp(`^${escaped}\\s+([^\\s]+)$`, 'm'))?.[1]));
    }
    if (world.site?.metrics) {
      const expected = [];
      for (const metric of world.site.metrics) {
        if (!metric.source) { expected.push(metric); continue; }
        try {
          expected.push({ name: metric.name, help: metric.help, type: metric.type ?? 'gauge', value: sourceMetricValue(metric.source, world) });
        } catch (error) { gap('http', error.message, 'site.metrics'); }
      }
      compare('http.metrics-source', expected, target.metrics);
      covered('site.metrics', 'http', '/metrics', 'Every source metric name and numeric value.');
    }
    for (const probe of rows(target.probes)) {
      if (!rows(probe.statuses).length) throw new Error(`Probe ${probe.path} has no declared statuses`);
      const actual = [], expected = [...probe.statuses, ...probe.statuses];
      for (let index = 0; index < expected.length; index++) {
        const answer = await request('http', probe.path, { raw: true, acceptStatuses: probe.statuses });
        actual.push(answer.status);
        const status = answer.status >= 200 && answer.status < 400 ? 'operational' : 'unavailable';
        check(`http.probe-content.${probe.path}${index ? `.${index}` : ''}`, typeof probe.name === 'string' && answer.body.includes(`${probe.name}\n`) && answer.body.includes(`Status: ${status}\n`),
          { expected: { name: probe.name, status }, actual: answer.body });
        if (!index && typeof probe.body === 'string' && !answer.body.includes(probe.body)) gap('http', `The provider does not consume the authored body for ${probe.path}.`, 'site.probes', 'content_mismatch');
      }
      compare(`http.probe-status-sequence.${probe.path}`, expected, actual);
      covered('site.probes[].statuses', 'http', probe.path, 'Two complete cycles of declared status values in order, from the initial isolated counter state.');
    }
    if (world.site?.probes) {
      compare('http.probes-source', world.site.probes, target.probes);
      covered('site.probes', 'http', '/{declared-probe}', 'Source name, matching status text, and two complete declared status cycles per endpoint.');
    }
  });

  if (selected('microsoft')) await run('microsoft', async () => {
    const me = (await request('microsoft', '/v1.0/me')).body;
    compare('microsoft.current-identity', primary?.email, me.mail ?? me.userPrincipalName);
    await run('microsoft.current-userinfo', async () => {
      const info = (await request('microsoft', '/oidc/userinfo')).body;
      compare('microsoft.userinfo-identity', { email: primary?.email, name: primary?.name }, { email: info.email, name: info.name });
    });
    if (me.id) await run('microsoft.current-user', async () => {
      const user = (await request('microsoft', `/v1.0/users/${encode(me.id)}`)).body;
      compare('microsoft.user-identity', { id: me.id, email: primary?.email, name: primary?.name }, { id: user.id, email: user.mail ?? user.userPrincipalName, name: user.displayName });
    });
    const users = await list('microsoft', '/v1.0/users?$top=100', { key: 'value', mode: 'odata' });
    compare('microsoft.people', sorted(staff.map(person => person.email)), sorted(users.map(user => user.mail ?? user.userPrincipalName)));
    covered('people', 'microsoft', '/v1.0/users', 'Complete source provider population email set.');
  });

  if (selected('okta')) await run('okta', async () => {
    const users = await list('okta', '/api/v1/users?limit=100');
    compare('okta.people', sorted(staff.map(person => person.email)), sorted(users.map(user => user.profile?.email)));
    covered('people', 'okta', '/api/v1/users', 'Complete source provider population email set; Link pagination.');
    const groups = await list('okta', '/api/v1/groups?limit=100');
    compare('okta.groups', sorted(rows(projections.okta?.groups).map(group => group.name)), sorted(groups.map(group => group.profile?.name ?? group.name)));
  });

  if (selected('clerk')) await run('clerk', async () => {
    const users = await list('clerk', '/v1/users?limit=100&offset=0', { mode: 'offset', acceptDataEnvelope: true });
    compare('clerk.people', sorted(staff.map(person => person.email)), sorted(users.flatMap(user => rows(user.email_addresses).map(email => email.email_address))));
    covered('people', 'clerk', '/v1/users', 'Complete source provider population email set; offset pagination.');
    const organizations = await list('clerk', '/v1/organizations?limit=100&offset=0', { key: 'data', mode: 'offset' });
    compare('clerk.organizations', sorted(rows(projections.clerk?.organizations).map(org => org.slug)), sorted(organizations.map(org => org.slug)));
  });

  if (selected('vercel')) await run('vercel', async () => {
    const identity = (await request('vercel', '/v2/user')).body;
    compare('vercel.current-identity', primary?.email, identity.user?.email ?? identity.email);
    const teams = await list('vercel', '/v2/teams?limit=100', { key: 'teams', mode: 'vercel' });
    compare('vercel.teams', sorted(rows(projections.vercel?.teams).map(team => team.slug)), sorted(teams.map(team => team.slug)));
    const projects = [];
    for (const team of teams.length ? teams : [{ id: null }]) projects.push(...await list('vercel', `/v10/projects?limit=100${team.id ? `&teamId=${encode(team.id)}` : ''}`, { key: 'projects', mode: 'vercel' }));
    compare('vercel.projects', sorted(rows(projections.vercel?.projects).map(project => project.name)), sorted(projects.map(project => project.name)));
  });

  if (selected('resend')) await run('resend', async () => {
    const domains = await list('resend', '/domains?limit=100', { key: 'data', mode: 'resend' });
    compare('resend.domains', sorted(rows(projections.resend?.domains).map(domain => domain.name)), sorted(domains.map(domain => domain.name)));
    const audiences = await list('resend', '/audiences?limit=100', { key: 'data', mode: 'resend' });
    const contacts = [];
    for (const audience of audiences) contacts.push(...await list('resend', `/audiences/${encode(audience.id)}/contacts?limit=100`, { key: 'data', mode: 'resend' }));
    compare('resend.contacts', sorted(rows(projections.resend?.contacts).map(contact => contact.email)), sorted(contacts.map(contact => contact.email)));
  });

  if (selected('twilio')) await run('twilio', async () => {
    const sid = bindings.TWILIO_ACCOUNT_SID, token = bindings.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Missing Twilio account credentials');
    const headers = { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` };
    const account = (await request('twilio', `/2010-04-01/Accounts/${encode(sid)}.json`, { headers })).body;
    compare('twilio.account', primaryOrg?.name, account.friendly_name);
    for (const [collection, path, key, field] of [
      ['phone_numbers', `/2010-04-01/Accounts/${encode(sid)}/IncomingPhoneNumbers.json?PageSize=100`, 'incoming_phone_numbers', 'phone_number'],
      ['messaging_services', '/messaging/v1/Services?PageSize=100', 'services', 'friendly_name'],
      ['verify_services', '/verify/v2/Services?PageSize=100', 'services', 'friendly_name'],
    ]) {
      const values = await list('twilio', path, { key, mode: 'twilio', headers });
      compare(`twilio.${collection}`, sorted(rows(projections.twilio?.[collection]).map(value => value[field])), sorted(values.map(value => value[field])));
    }
    await run('twilio.conversations', async () => {
      const services = await list('twilio', '/conversations/v1/Services?PageSize=100', { key: 'services', mode: 'twilio', headers });
      compare('twilio.conversation-services', sorted(rows(projections.twilio?.conversations?.services).map(service => service.friendly_name)), sorted(services.map(service => service.friendly_name)));
      for (const service of services) {
        const conversations = await list('twilio', `/conversations/v1/Services/${encode(service.sid)}/Conversations?PageSize=100`, { key: 'conversations', mode: 'twilio', headers });
        // The pinned seed contract declares services only, with no initial
        // conversations. Any served conversation is unexpected run state.
        compare(`twilio.initial-conversations.${service.sid}`, [], conversations);
      }
    });
    await run('twilio.api-keys', async () => {
      const keys = await list('twilio', `/2010-04-01/Accounts/${encode(sid)}/Keys.json?PageSize=100`, { key: 'keys', mode: 'twilio', headers });
      compare('twilio.api-key-identities', sorted(rows(projections.twilio?.api_keys).map(key => JSON.stringify([key.sid, key.friendly_name]))), sorted(keys.map(key => JSON.stringify([key.sid, key.friendly_name]))));
    });
  });

  if (selected('mongoatlas')) await run('mongoatlas', async () => {
    const projects = await list('mongoatlas', '/api/atlas/v2/groups?itemsPerPage=100', { key: 'results', mode: 'atlas' });
    compare('mongoatlas.projects', sorted(rows(projections.mongoatlas?.projects).map(project => project.name)), sorted(projects.map(project => project.name)));
    const clusters = [], users = [], databases = [];
    for (const project of projects) {
      const base = `/api/atlas/v2/groups/${encode(project.id ?? project.groupId)}`;
      const members = await list('mongoatlas', `${base}/clusters?itemsPerPage=100`, { key: 'results', mode: 'atlas' });
      clusters.push(...members);
      users.push(...await list('mongoatlas', `${base}/databaseUsers?itemsPerPage=100`, { key: 'results', mode: 'atlas' }));
      for (const cluster of members) {
        const path = `${base}/clusters/${encode(cluster.name)}/databases`;
        for (const database of await list('mongoatlas', path, { key: 'results', mode: 'atlas' })) {
          const name = database.databaseName ?? database.name;
          const collections = await list('mongoatlas', `${path}/${encode(name)}/collections`, { key: 'results', mode: 'atlas' });
          databases.push({ cluster: cluster.name, name, collections: sorted(collections.map(collection => collection.collectionName ?? collection.name)) });
        }
      }
    }
    compare('mongoatlas.clusters', sorted(rows(projections.mongoatlas?.clusters).map(cluster => cluster.name)), sorted(clusters.map(cluster => cluster.name)));
    compare('mongoatlas.database-users', sorted(rows(projections.mongoatlas?.database_users).map(user => user.username)), sorted(users.map(user => user.username)));
    compare('mongoatlas.databases', sorted(rows(projections.mongoatlas?.databases).map(database => JSON.stringify([database.cluster, database.name, sorted(database.collections)]))), sorted(databases.map(database => JSON.stringify([database.cluster, database.name, database.collections]))));
    for (const database of databases) for (const collection of database.collections) await run(`mongoatlas.documents.${database.cluster}.${database.name}.${collection}`, async () => {
      const documents = [], seen = new Set();
      let complete = false;
      for (let skip = 0; skip < 1000000; skip += 100) {
        const path = '/app/data-api/v1/action/find';
        const page = (await request('mongoatlas', path, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dataSource: database.cluster, database: database.name, collection, filter: {}, sort: { _id: 1 }, skip, limit: 100 }) })).body;
        if (!Array.isArray(page.documents)) throw new Error(`${path} returned no documents list`);
        const signature = JSON.stringify(page.documents);
        if (page.documents.length && seen.has(signature)) throw new Error(`${path} repeated a result page`);
        seen.add(signature); documents.push(...page.documents);
        if (page.documents.length < 100) { complete = true; break; }
      }
      if (!complete) throw new Error('MongoAtlas document pagination exceeded its page limit');
      // The pinned MongoAtlas seed contract accepts collection names but no
      // document records. Do not infer a copy of finance/tasks from a name.
      compare(`mongoatlas.initial-documents.${database.cluster}.${database.name}.${collection}`, [], documents);
      covered('software.database.collections', 'mongoatlas', '/app/data-api/v1/action/find',
        `Read every document in ${database.cluster}/${database.name}/${collection}; pinned seed declares an initially empty collection.`);
    });
  });

  if (!supplementalNotion && selected('notion')) await run('notion', async () => {
    const headers = { 'Notion-Version': '2026-03-11', 'content-type': 'application/json' };
    const users = await list('notion', '/v1/users?page_size=100', { key: 'results', mode: 'notion', headers });
    compare('notion.people', sorted(staff.map(person => person.email)), sorted(users.filter(user => user.type === 'person').map(user => user.person?.email)));
    const objects = await list('notion', '/v1/search', { key: 'results', mode: 'notion', method: 'POST', body: { page_size: 100 }, headers });
    const pages = objects.filter(object => object.object === 'page');
    const expectedPages = rows(projections.notion?.pages);
    const primaryNotionId = rows(projections.notion?.users).find(user => user.worldfixture_person_id === primary?.id)?.id;
    const visible = expectedPages.filter(page => !Array.isArray(page.accessible_by) || page.accessible_by.includes(primaryNotionId));
    compare('notion.page-identities', sorted(visible.map(page => page.id)), sorted(pages.map(page => page.id)));
    if (visible.length !== expectedPages.length) gap('notion', 'Pages restricted to other people need API reads with those people\'s bindings.');
    for (const document of rows(world.communication?.documents)) {
      const projected = expectedPages.find(page => page.worldfixture_document_id === document.id);
      check(`notion.document-projection.${document.id}`, Boolean(projected), { expected: document.id, actual: projected?.id ?? null });
      if (!projected) continue;
      if (!visible.includes(projected)) { gap('notion', `Document ${document.id} needs a permitted person's binding.`, 'communication.documents'); continue; }
      const blocks = await list('notion', `/v1/blocks/${encode(projected.id)}/children?page_size=100`, { key: 'results', mode: 'notion', headers });
      const text = blocks.flatMap(block => rows(block[block.type]?.rich_text).map(part => part.plain_text ?? part.text?.content ?? '')).join('');
      compare(`notion.document-content.${document.id}`, document.content, text);
    }
    covered('communication.documents', 'notion', '/v1/search + /v1/blocks/{page}/children', 'Source document mapping plus paginated page/block API content.');
    gap('notion', 'Database schemas, data sources, comments, files, agents, sessions, and admin objects need separate content readers.');
  });

  // The complete matrix supplies the Apple authorization reader separately.
  if (!supplementalApple && selected('apple')) gap('apple', 'Apple identity requires the separately supplied authorization/token reader.');
  for (const entry of coverage) if (failedProviders.has(entry.provider)) {
    entry.status = 'failed';
    if (entry.path) entry.detail += ' One or more checks for this provider failed.';
  }
  return { checks, responses, coverage };
}
