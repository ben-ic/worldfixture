import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { s3Fetch } from "../../runtime/src/s3-signing.mjs";
import { probeDomainWorld } from './coupling-domain-probes.mjs';
import { probeDeclaredOAuthWorld } from './coupling-oauth-probes.mjs';
import { legacyBusinessContract, sourceGithubLogin, sourceProviderActor, sourceProviderPeople, sourceReadCredential } from './coupling-source-contracts.mjs';
/** Public API checks; synthetic OAuth grants are the only writes. Failures are evidence, never implicit skips. */
export async function paginate(read, { items, next, limit = 10000 }) {
  const result = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < limit; page++) {
    const value = await read(cursor);
    const rows = items(value);
    if (!Array.isArray(rows)) throw new Error('Provider did not return the required list');
    result.push(...rows);
    const token = next(value, rows);
    if (!token) return result;
    if (seen.has(token)) throw new Error('Provider repeated a pagination cursor');
    seen.add(token);
    cursor = token;
  }
  throw new Error('Provider pagination exceeded the page limit');
}

const array = value => Array.isArray(value) ? value : [];
const sorted = values => [...values].sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const address = value => String(value ?? '').match(/<([^>]+)>/)?.[1] ?? String(value ?? '');
const fragment = value => String(value).replace(/[^a-zA-Z0-9_]/g, '_');

// Receipts select live IDs only. Each reader still derives content from source.
export function seedReceiptMappings(receipt, artifact, provider, { collection, sourceFields, providerField, expectedKeys, providerScopeFields = [] }) {
  const identity = artifact.identity ?? { id: artifact.world.id, version: artifact.world.version, digest: artifact.manifest?.artifact_sha256 };
  if (receipt?.api_version !== `worldfixture.${provider}-seed-receipt/v1`
    || !/^[a-f0-9]{64}$/.test(identity.digest ?? '')
    || receipt.world?.id !== identity.id || receipt.world?.version !== identity.version || receipt.world?.digest !== identity.digest) {
    throw new Error(`${provider} seed receipt does not identify this exact artifact digest`);
  }
  if (!Array.isArray(receipt[collection])) throw new Error(`${provider} seed receipt has no ${collection} array`);
  const mappings = new Map(), providerIds = new Set();
  for (const row of receipt[collection]) {
    if ([...sourceFields, providerField, ...providerScopeFields].some(field => typeof row?.[field] !== 'string' || !row[field])) throw new Error(`${provider} seed receipt has an invalid ${collection} identity`);
    const source = JSON.stringify(sourceFields.map(field => row[field]));
    const live = JSON.stringify([...providerScopeFields.map(field => row[field]), row[providerField]]);
    if (mappings.has(source) || providerIds.has(live)) throw new Error(`${provider} seed receipt has duplicate ${collection} identities`);
    mappings.set(source, row[providerField]); providerIds.add(live);
  }
  if (!same(sorted(mappings.keys()), sorted(expectedKeys.map(key => JSON.stringify(key))))) throw new Error(`${provider} seed receipt ${collection} source IDs differ from the source world`);
  return mappings;
}

export function verifyAppleIdentity(encoded, keys, { issuer, audience, nonce, email, now = Date.now() }) {
  const pieces = String(encoded).split('.');
  if (pieces.length !== 3) throw new Error('Apple did not return a JWT ID token.');
  const header = JSON.parse(Buffer.from(pieces[0], 'base64url'));
  const claims = JSON.parse(Buffer.from(pieces[1], 'base64url'));
  const jwk = array(keys).find(key => key.kid === header.kid && key.kty === 'RSA');
  if (header.alg !== 'RS256' || !jwk || !verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2], 'base64url'))) throw new Error('Apple ID token signature is invalid.');
  if (claims.iss !== issuer || ![claims.aud].flat().includes(audience) || claims.nonce !== nonce || claims.email !== email || !claims.sub || !(claims.exp > now / 1000)) throw new Error('Apple ID token claims do not match the source person and current authorization request.');
  return { email: claims.email, subject: claims.sub, issuer: claims.iss, audience: claims.aud };
}

export async function probeLinearWorld({ artifact, bindings, credentials, fetchImpl = fetch }) {
  const { world, projections = {} } = artifact;
  const readCredential = sourceReadCredential({artifact, bindings, credentials, provider: 'linear'});
  const people = new Map(array(world.people).map(person => [person.id, person]));
  const checks = [], responses = [], coverage = [];
  const check = (name, passed, detail = {}) => checks.push({ check: name, status: passed ? 'passed' : 'failed', ...detail });
  const compare = (name, expected, actual, finding) => check(name, same(expected, actual), { expected, actual, finding });
  const request = async (provider, path, options = {}) => {
    if (!bindings.LINEAR_BASE_URL) throw new Error('Missing LINEAR_BASE_URL');
    const response = await fetchImpl(`${bindings.LINEAR_BASE_URL.replace(/\/$/, '')}${path}`, {
      ...options, signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${readCredential.token}`, ...options.headers },
    });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    responses.push({ provider, path, status: response.status, body });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    if (!body || typeof body !== 'object') throw new Error(`${path} returned invalid JSON`);
    if (body.ok === false || body.errors?.length) throw new Error(`${path} rejected the request: ${JSON.stringify(body.error ?? body.errors)}`);
    return body;
  };
  try {
    if (!readCredential.token) throw new Error('Missing LINEAR_TOKEN or a current per-person Linear credential');
    if (readCredential.selection === 'per-person-read') {
      const viewer = (await request('linear', '/graphql', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({query: 'query { viewer { id email } }'})})).data?.viewer;
      compare('linear.read-actor', readCredential.person.email, viewer?.email);
      check('linear.read-actor-selection', true, {actual: {source_person_id: readCredential.person.id, selection: readCredential.selection}});
    }
    const versioned = projections['emulator-overlay']?.linear?.worldfixture_seed_version === 1;
    const tasks = array(world.work?.tasks);
    let mapping;
    if (versioned) {
      const receipt = await request('linear', '/_worldfixture/seed-receipt');
      mapping = seedReceiptMappings(receipt, artifact, 'linear', { collection: 'issues', sourceFields: ['source_task_id'], providerField: 'provider_issue_id', expectedKeys: tasks.map(task => [task.id]) });
    } else check('linear.seed-contract.legacy', true, { detail: 'Legacy artifact: content matching is used only as a diagnostic; no saved source-to-provider receipt is available.' });
    const issues = await paginate(async cursor => {
      const query = `query { issues(first: 100${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { nodes { id identifier title description assignee { email } ${versioned ? 'team { key } state { name }' : ''} } pageInfo { hasNextPage endCursor } } }`;
      return (await request('linear', '/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).data?.issues;
    }, { items: page => page?.nodes, next: page => {
      if (!page.pageInfo) throw new Error('Linear pagination metadata is absent');
      if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) throw new Error('Linear next page has no cursor');
      return page.pageInfo.hasNextPage ? page.pageInfo.endCursor : '';
    } });
    compare('linear.task-count', tasks.length, issues.length, 7);
    compare('linear.task-titles', sorted(tasks.map(task => task.title)), sorted(issues.map(issue => issue.title)), 7);
    const remaining = [...issues].sort((left, right) => String(left.identifier ?? left.id).localeCompare(String(right.identifier ?? right.id)));
    const identityMappings = [];
    for (const task of tasks) {
      const index = remaining.findIndex(issue => versioned ? issue.id === mapping.get(JSON.stringify([task.id]))
        : issue.title === task.title && (issue.description ?? '').startsWith(task.description ?? '') && issue.assignee?.email === people.get(task.assignee_id)?.email);
      check(`linear.task.${task.id}`, index >= 0, { finding: 7, expected: { id: task.id, title: task.title, assignee: people.get(task.assignee_id)?.email }, actual: index >= 0 ? { id: remaining[index].id, identifier: remaining[index].identifier } : null });
      if (index >= 0) {
        if (versioned) {
          const live = remaining[index], project = array(world.work?.projects).find(project => project.id === task.project_id);
          const legacy = legacyBusinessContract(world);
          const expected = { title: task.title, description: legacy ? `${task.description}\n\nProject: ${project?.name} · Due: ${task.due_on}` : task.description ?? '', assignee: people.get(task.assignee_id)?.email,
            state: legacy ? { backlog: 'Backlog', ready: 'Todo', 'in-progress': 'In Progress', review: 'In Progress', blocked: 'In Progress', done: 'Done' }[task.status] : task.status };
          const actual = { title: live.title, description: live.description, assignee: live.assignee?.email, state: live.state?.name };
          if (world.work?.team?.key) { expected.team = world.work.team.key; actual.team = live.team?.key; }
          compare(`linear.task-content.${task.id}`, expected, actual, 7);
        }
        identityMappings.push({ source: task.id, id: remaining[index].id, identifier: remaining[index].identifier });
        remaining.splice(index, 1);
      }
    }
    compare('linear.projection-completeness', sorted(tasks.map(task => task.id)), sorted(array(projections.linear?.issues).map(issue => issue.worldfixture_task_id)), 7);
    check('linear.source-identity-mapping', identityMappings.length === tasks.length && identityMappings.every(entry => entry.id && entry.identifier) && new Set(identityMappings.map(entry => entry.id)).size === tasks.length && new Set(identityMappings.map(entry => entry.identifier)).size === tasks.length, { finding: 7, actual: identityMappings, detail: versioned ? 'Exact source IDs map through the saved artifact receipt to public issue IDs; source content is checked separately.' : 'Legacy diagnostic matching by source content; this artifact has no durable source identity receipt.' });

    check('provider.linear.read', checks.every(entry => entry.status === 'passed'));
  } catch (error) { check('provider.linear.read', false, { detail: error.message }); }
  coverage.push({ collection: 'work.tasks', provider: 'linear', path: '/_worldfixture/seed-receipt + /graphql',
    status: checks.every(entry => entry.status === 'passed') ? 'passed' : 'failed',
    detail: 'Complete issue pagination and source content; versioned artifacts also require exact saved source-ID receipts.' });
  return { checks, responses, coverage };
}

export async function probeWorld({ artifact, bindings, credentials, fetchImpl = fetch, supplementalProviders = [], supplementalGoogle = false, elapsedMs = Infinity }) {
  const world = artifact.world;
  const projections = artifact.projections ?? {};
  const checks = [], responses = [], coverage = [];
  const people = new Map(array(world.people).map(person => [person.id, person]));
  const primaryOrg = array(world.organizations).find(org => org.primary)?.id;
  const staff = array(world.people).filter(person => person.organization_id === primaryOrg);
  const check = (name, passed, detail = {}) => checks.push({ check: name, status: passed ? 'passed' : 'failed', ...detail });
  const compare = (name, expected, actual, finding) => check(name, same(expected, actual), { expected, actual, ...(finding ? { finding } : {}) });
  const compareWithArrivals = (name, expected, actual, allowed, finding) => {
    const remaining = [...actual];
    const missing = [];
    for (const value of expected) {
      const index = remaining.indexOf(value);
      if (index < 0) missing.push(value); else remaining.splice(index, 1);
    }
    const extra = [];
    const pending = [...allowed];
    for (const value of remaining) {
      const index = pending.indexOf(value);
      if (index < 0) extra.push(value); else pending.splice(index, 1);
    }
    check(name, missing.length === 0 && extra.length === 0, { expected, actual, missing, extra, ...(finding ? { finding } : {}) });
  };
  const covered = (collection, provider, path, detail) => {
    const related = {
      people: ['slack.people'],
      'communication.channels': ['slack.channels'],
      'communication.channels[].messages': ['slack.history.'],
      'communication.mail': ['google.mail.', 'google.labels.', 'google.message-labels.'],
      'communication.resolved_mail': ['google.mail.', 'google.labels.', 'google.message-labels.'],
      'finance.customers': ['stripe.source-customers'],
      'finance.anchor_invoices': ['stripe.invoice.'],
      'finance.resolved.payments': ['stripe.source-payment.'],
      'communication.documents': ['s3.'],
    }[collection] ?? [];
    const failed = checks.some(entry => entry.status === 'failed' && related.some(prefix => entry.check.startsWith(prefix)));
    coverage.push({ collection, provider, path, status: failed ? 'failed' : 'passed', detail });
  };
  async function request(provider, path, options = {}, raw = false) {
    const base = bindings[`${provider.toUpperCase()}_BASE_URL`];
    if (!base) throw new Error(`Missing ${provider.toUpperCase()}_BASE_URL`);
    const token = sourceReadCredential({artifact, bindings, credentials, provider}).token;
    const read = provider === 's3' ? (url, init) => s3Fetch(url, init, bindings, fetchImpl) : fetchImpl;
    const response = await read(`${base.replace(/\/$/, '')}${path}`, {
      ...options, signal: AbortSignal.timeout(30000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
    });
    const text = await response.text();
    let body;
    try { body = raw ? text : JSON.parse(text); } catch { body = text; }
    responses.push({ provider, path, status: response.status, body });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    if (!raw && (!body || typeof body !== 'object')) throw new Error(`${path} returned invalid JSON`);
    if (body.ok === false || body.errors?.length) throw new Error(`${path} rejected the request: ${JSON.stringify(body.error ?? body.errors)}`);
    return body;
  }
  async function run(provider, operation) {
    const start = checks.length;
    try { await operation(); check(`provider.${provider}.read`, !checks.slice(start).some(entry => entry.status === 'failed')); }
    catch (error) {
      check(`provider.${provider}.read`, false, { detail: error.message });
    }
  }
  const selected = new Set(Object.keys(bindings).filter(key => key.endsWith('_BASE_URL')).map(key => key.slice(0, -9).toLowerCase()));
  // Projections are not proof that a provider was selected, but missing bindings
  // must be visible for declared provider data. Non-provider projections are excluded.
  const projectionProviders = new Set(['slack', 'google', 'linear', 'stripe', 'github', 'notion', 'apple', 'clerk', 'okta', 'microsoft', 'mongoatlas', 'resend', 'twilio', 'vercel', 'mail', 'domain']);
  for (const provider of Object.keys(projections)) if (projectionProviders.has(provider)) selected.add(provider);
  if (projections.aws?.s3) selected.add('s3');

  if (selected.has('slack')) await run('slack', async () => {
    const list = (method, key, args = {}) => paginate(cursor => request('slack', `/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ limit: '200', ...args, ...(cursor ? { cursor } : {}) }),
    }), { items: page => page[key], next: page => {
      const cursor = page.response_metadata?.next_cursor;
      if (page.has_more && !cursor) throw new Error('Slack has_more has no next cursor');
      return cursor;
    } });
    const users = await list('users.list', 'members');
    const members = users.filter(user => !user.is_bot && user.id !== 'USLACKBOT');
    const readActor = sourceReadCredential({artifact, bindings, credentials, provider: 'slack'});
    if (readActor.selection === 'per-person-read') {
      const auth = await request('slack', '/api/auth.test', {method: 'POST'});
      const servedActor = users.find(user => user.id === auth.user_id);
      compare('slack.read-actor', readActor.person.email ?? sourceGithubLogin(readActor.person), servedActor?.profile?.email ?? servedActor?.email ?? servedActor?.name);
      check('slack.read-actor-selection', true, {actual: {source_person_id: readActor.person.id, selection: readActor.selection}});
    }
    compare('slack.people', sorted(sourceProviderPeople(world, {emailOnly: true}).map(person => person.email)), sorted(members.map(user => user.profile?.email ?? user.email)));
    covered('people', 'slack', '/api/users.list', 'Source provider participants matched by email; explicit compatibility scope is primary-organization staff, otherwise all declared email people. Provider bots are excluded.');
    const channels = await list('conversations.list', 'channels', { types: 'public_channel,private_channel' });
    compare('slack.channels', sorted(array(world.communication?.channels).map(channel => channel.name)), sorted(channels.map(channel => channel.name)));
    covered('communication.channels', 'slack', '/api/conversations.list', 'Channel names; complete pagination.');
    for (const channel of channels) {
      const messages = await list('conversations.history', 'messages', { channel: channel.id });
      const expected = array(world.communication?.channels).find(entry => entry.name === channel.name);
      const normalize = values => sorted(values.map(value => JSON.stringify(value)));
      const arrivals = array(world.timeline).filter(event => event.kind === 'chat-message' && event.payload?.channel_id === expected?.id && event.after_seconds * 1000 <= elapsedMs);
      compareWithArrivals(`slack.history.${channel.name}`, normalize(array(expected?.messages).map(message => [message.text, people.get(message.author_id)?.email])),
        normalize(messages.map(message => [message.text, users.find(user => user.id === message.user)?.profile?.email ?? users.find(user => user.id === message.user)?.email])),
        normalize(arrivals.map(event => [event.payload.text, people.get(event.payload.author_id)?.email])));
    }
    covered('communication.channels[].messages', 'slack', '/api/conversations.history', 'Every listed channel; text and author email multiset preserves duplicate messages.');
  });

  if (selected.has('google') && projections['emulator-overlay']?.google?.worldfixture_seed_version === 1 && !supplementalGoogle) {
    const { probeGoogleWorld } = await import('./coupling-google-probes.mjs');
    const exact = await probeGoogleWorld({ artifact, bindings, credentials, fetchImpl, elapsedMs });
    checks.push(...exact.checks); responses.push(...exact.responses); coverage.push(...exact.coverage);
  }
  if (selected.has('google') && projections['emulator-overlay']?.google?.worldfixture_seed_version !== 1 && !supplementalGoogle) await run('google', async () => {
    check('google.seed-contract.legacy', true, { detail: 'Legacy artifact: no seed receipt contract; this reader checks observable mailbox content only.' });
    const identity = await request('google', '/oauth2/v2/userinfo');
    const {person: primary, selection} = sourceProviderActor(world, {emailOnly: true});
    check('google.current-actor-selection', Boolean(primary), {actual: {source_person_id: primary?.id, selection}});
    compare('google.current-identity', primary?.email, identity.email, 8);
    const mail = [...new Map([...array(world.communication?.resolved_mail), ...array(world.communication?.mail)].map(message => [message.id, message])).values()];
    // Every declared recipient is read directly. This exposes a seed that places
    // all mail in the primary mailbox. SENT records additionally belong to sender.
    const recipients = new Set(mail.flatMap(message => message.to_ids ?? []));
    for (const message of mail) if (message.labels?.includes('SENT')) recipients.add(message.from_id);
    if (primary) recipients.add(primary.id);
    for (const id of recipients) {
      const email = people.get(id)?.email;
      if (!email) { check(`google.mailbox.${id}`, false, { finding: 8, detail: 'Mailbox person has no email' }); continue; }
      await run(`google.mailbox.${id}`, async () => {
        const prefix = `/gmail/v1/users/${encodeURIComponent(email)}`;
        const references = await paginate(cursor => request('google', `${prefix}/messages?maxResults=500${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`), {
          items: page => page.messages ?? (page.resultSizeEstimate === 0 ? [] : undefined), next: page => page.nextPageToken,
        });
        const messages = [];
        for (const reference of references) messages.push(await request('google', `${prefix}/messages/${encodeURIComponent(reference.id)}?format=full`));
        const expected = mail.filter(message => array(message.to_ids).includes(id) || (message.from_id === id && message.labels?.includes('SENT')));
        const metadata = message => ({ subject: message.subject, from: message.from, to: message.to, ...Object.fromEntries(array(message.payload?.headers).map(header => [header.name.toLowerCase(), header.value])) });
        const signature = (subject, from, to) => JSON.stringify([subject, address(from), sorted(String(to ?? '').split(',').map(address))]);
        const arrivals = array(world.timeline).filter(event => event.kind === 'incoming-email' && event.payload?.via === 'gmail' && event.payload.to_id === id);
        compareWithArrivals(`google.mail.${id}`, sorted(expected.map(message => signature(message.subject, people.get(message.from_id)?.email, array(message.to_ids).map(to => people.get(to)?.email).join(',')))),
          sorted(messages.map(message => { const headers = metadata(message); return signature(headers.subject, headers.from, headers.to); })),
          sorted(arrivals.map(event => signature(event.payload.subject, people.get(event.payload.from_id)?.email, people.get(event.payload.to_id)?.email))), 8);
        const labels = await request('google', `${prefix}/labels`);
        if (!Array.isArray(labels.labels)) throw new Error('Gmail labels list is absent');
        const available = new Set(labels.labels.flatMap(label => [label.id, label.name]));
        const missing = sorted(new Set(expected.flatMap(message => array(message.labels)).filter(label => !available.has(label))));
        compare(`google.labels.${id}`, [], missing, 3);
        const unknownLabels = messages.flatMap(message => array(message.labelIds).filter(label => !available.has(label)));
        compare(`google.message-labels.${id}`, [], sorted(new Set(unknownLabels)), 3);
      });
    }
    const mailboxFailures = checks.some(entry => entry.status === 'failed' && entry.check.startsWith('provider.google.mailbox.'));
    if (!mailboxFailures) {
      covered('communication.mail', 'google', '/gmail/v1/users/{email}/messages', 'Subject, sender, recipients, multiplicity, and label existence for each source mailbox.');
      covered('communication.resolved_mail', 'google', '/gmail/v1/users/{email}/messages', 'Resolved source mail, deduplicated against authored mail by stable ID.');
    }
    // The upstream identity has a real API route even after its user row is removed.
    const samplePath = '/gmail/v1/users/testuser%40gmail.com/messages?maxResults=500';
    try {
      const sample = await paginate(cursor => request('google', `${samplePath}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`), {
        items: page => page.messages ?? (page.resultSizeEstimate === 0 ? [] : undefined), next: page => page.nextPageToken,
      });
      compare('google.sample-mail', [], sample.map(message => message.id), 6);
    } catch (error) {
      check('google.sample-mail', /HTTP (401|403|404)$/.test(error.message), { finding: 6, detail: error.message });
    }
  });

  if (selected.has('linear')) {
    const linear = await probeLinearWorld({ artifact, bindings, credentials, fetchImpl });
    checks.push(...linear.checks); responses.push(...linear.responses); coverage.push(...linear.coverage);
  }

  if (selected.has('stripe')) await run('stripe', async () => {
    const results = {};
    for (const collection of ['customers', 'products', 'prices', 'subscriptions', 'invoices', 'payment_intents', 'charges', 'refunds']) {
      await run(`stripe.${collection}`, async () => {
        const values = await paginate(cursor => request('stripe', `/v1/${collection}?limit=100${collection === 'subscriptions' ? '&status=all' : ''}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`), {
          items: page => page.data, next: (page, rows) => {
            if (typeof page.has_more !== 'boolean') throw new Error('Stripe pagination metadata is absent');
            if (page.has_more && !rows.at(-1)?.id) throw new Error('Stripe next page has no last record ID');
            return page.has_more ? rows.at(-1).id : '';
          },
        });
        results[collection] = values;
        if (projections.stripe?.[collection]) compare(`stripe.projection.${collection}`, sorted(projections.stripe[collection].map(value => value.id)), sorted(values.map(value => value.id)), 13);
        // Per-record currencies can differ from the world's default. Full
        // invoice, price, settlement and refund comparisons use source records
        // in coupling-finance-probes; a world-wide currency equality is invalid.
      });
    }
    if (results.customers) {
      compare('stripe.source-customers', sorted(array(world.finance?.customers).map(customer => `cus_${fragment(customer.id)}`)), sorted(results.customers.map(customer => customer.id)), 13);
      covered('finance.customers', 'stripe', '/v1/customers', 'Stable customer IDs from source; paginated API.');
    }
    if (results.invoices) {
      for (const invoice of array(world.finance?.anchor_invoices)) {
        const actual = results.invoices.find(value => value.metadata?.worldfixture_invoice_id === invoice.id || value.id === `in_${fragment(invoice.id)}`);
        compare(`stripe.invoice.${invoice.id}`, { amount: invoice.amount_cents, currency: invoice.currency.toLowerCase(), customer: `cus_${fragment(invoice.customer_id)}` }, actual ? { amount: actual.amount_due, currency: actual.currency, customer: actual.customer } : null, 13);
      }
      covered('finance.anchor_invoices', 'stripe', '/v1/invoices', 'Source ID, customer relationship, amount and currency.');
    }
    const payments = array(world.finance?.resolved?.payments);
    for (const payment of payments) {
      const actual = array(results.payment_intents).find(value => value.metadata?.worldfixture_payment_id === payment.id);
      compare(`stripe.source-payment.${payment.id}`, { amount: payment.amount_cents, currency: (payment.currency ?? world.finance?.currency)?.toLowerCase() }, actual ? { amount: actual.amount, currency: actual.currency } : null, 5);
    }
    if (results.payment_intents) covered('finance.resolved.payments', 'stripe', '/v1/payment_intents', 'Source payment identity in metadata, amount and currency. Missing identity fails.');
  });

  if (selected.has('s3')) await run('s3', async () => {
    const xmlValue = (text, tag) => text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '';
    const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const buckets = await paginate(cursor => request('s3', cursor ? `/?continuation-token=${encodeURIComponent(cursor)}` : '/', {}, true), {
      items: page => {
        if (!/<ListAllMyBucketsResult(?:\s|>)/.test(page)) throw new Error('S3 bucket list XML is invalid');
        return [...page.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)].map(match => decode(xmlValue(match[1], 'Name')));
      },
      next: page => decode(xmlValue(page, 'ContinuationToken')),
    });
    compare('s3.buckets', sorted(array(projections.aws?.s3?.buckets).map(bucket => bucket.name)), sorted(buckets), 12);
    // Exercise every declared bucket even if enumeration is incomplete.
    for (const bucket of new Set([...buckets, ...array(projections.aws?.s3?.buckets).map(entry => entry.name)])) {
      const objects = await paginate(cursor => request('s3', `/${encodeURIComponent(bucket)}/?list-type=2${cursor ? `&continuation-token=${encodeURIComponent(cursor)}` : ''}`, {}, true), {
        items: page => {
          if (!/<ListBucketResult(?:\s|>)/.test(page)) throw new Error('S3 object list XML is invalid');
          return [...page.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(match => decode(xmlValue(match[1], 'Key')));
        },
        next: page => { const token = xmlValue(page, 'NextContinuationToken'); if (xmlValue(page, 'IsTruncated') === 'true' && !token) throw new Error('S3 truncated page has no continuation token'); return decode(token); },
      });
      const expected = array(projections.aws?.s3?.objects).filter(object => object.bucket === bucket);
      compare(`s3.objects.${bucket}`, sorted(expected.map(object => object.key)), sorted(objects), 12);
      for (const object of expected) if (objects.includes(object.key)) {
        const content = await request('s3', `/${encodeURIComponent(bucket)}/${object.key.split('/').map(encodeURIComponent).join('/')}`, {}, true);
        compare(`s3.content.${bucket}.${object.key}`, object.content, content, 12);
      }
    }
    const docs = array(world.communication?.documents);
    compare('s3.document-projection-completeness', sorted(docs.map(doc => doc.id)), sorted(array(projections.aws?.s3?.objects).filter(object => object.worldfixture_document_id).map(object => object.worldfixture_document_id)), 12);
    for (const doc of docs) {
      const object = array(projections.aws?.s3?.objects).find(object => object.worldfixture_document_id === doc.id);
      compare(`s3.source-document.${doc.id}`, doc.content, object?.content, 12);
    }
    covered('communication.documents', 's3', '/{bucket}/{key}', 'Source document IDs and content checked against projection, then live object content.');
  });

  const xmlField = (text, field) => String(text).match(new RegExp(`<${field}>([^<]*)</${field}>`))?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") ?? '';
  for (const domain of ['iam', 'sqs']) if (projections.aws?.[domain]) {
    const operatorCollections = ['operator_teams', 'operator_ids', 'operator_limit']
      .filter(field => Object.hasOwn(world.software ?? {}, field)).map(field => `software.${field}`);
    if (!bindings.AWS_BASE_URL) {
      check(`coverage.provider.aws.${domain}`, false, { finding: 12, expected: projections.aws[domain], actual: null, detail: 'AWS declares IAM/SQS data, but no running AWS binding serves it.' });
      coverage.push({ collection: `projections.aws.${domain}`, provider: 'aws', path: null, status: 'failed', detail: 'Declared AWS data has no running public API binding.' });
      if (domain === 'iam') for (const collection of operatorCollections) coverage.push({ collection, provider: 'aws', path: null, status: 'failed', detail: 'Source operator policy cannot be checked without an AWS binding.' });
      continue;
    }
    await run(`aws.${domain}`, async () => {
      const query = async (action, args = {}) => {
        const xml = await request('aws', `/${domain}/`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ Action: action, Version: domain === 'iam' ? '2010-05-08' : '2012-11-05', ...args }) }, true);
        if (!xml.includes(`<${action}Result>`)) throw new Error(`${action} returned invalid AWS Query XML.`);
        return xml;
      };
      const list = (action, items) => paginate(cursor => query(action, cursor ? { [domain === 'iam' ? 'Marker' : 'NextToken']: cursor } : {}), { items, next: xml => {
        const next = xmlField(xml, domain === 'iam' ? 'Marker' : 'NextToken');
        if (xmlField(xml, 'IsTruncated') === 'true' && !next) throw new Error('AWS truncated list has no continuation token.');
        return next;
      } });
      if (domain === 'iam') {
        const users = await list('ListUsers', xml => [...xml.matchAll(/<member>([\s\S]*?)<\/member>/g)].map(match => ({ name: xmlField(match[1], 'UserName'), path: xmlField(match[1], 'Path') })));
        compare('aws.iam.users', sorted(array(projections.aws.iam.users).map(user => JSON.stringify([user.user_name, user.path]))), sorted(users.map(user => JSON.stringify([user.name, user.path]))), 1);
        const policy = world.software ?? {};
        const explicitSelection = Object.hasOwn(policy, 'operator_teams') || Object.hasOwn(policy, 'operator_ids');
        const teams = Object.hasOwn(policy, 'operator_teams') ? policy.operator_teams : explicitSelection ? [] : ['engineering'];
        const ids = Object.hasOwn(policy, 'operator_ids') ? policy.operator_ids : [];
        const limit = Object.hasOwn(policy, 'operator_limit') ? policy.operator_limit : 4;
        const validList = values => Array.isArray(values) && values.every(value => typeof value === 'string' && value.length > 0) && new Set(values).size === values.length;
        const validPolicy = validList(teams) && validList(ids) && (limit === null || (Number.isInteger(limit) && limit >= 0))
          && (!Object.hasOwn(policy, 'operator_teams') || teams.every(team => staff.some(person => person.team === team)))
          && ids.every(id => staff.some(person => person.id === id));
        check('aws.iam.operator-declaration', explicitSelection && Object.hasOwn(policy, 'operator_limit'), { finding: 1, detail: 'Source must declare operator eligibility and a limit; null means unlimited.' });
        check('aws.iam.source-operator-policy-valid', validPolicy, { finding: 1, expected: 'Valid primary-organization team/ID references and a null or nonnegative integer limit', actual: { teams, ids, limit } });
        if (validPolicy) {
          const eligible = staff.filter(person => teams.includes(person.team) || ids.includes(person.id) || (!explicitSelection && person.primary));
          if (explicitSelection || Object.hasOwn(policy, 'operator_limit')) eligible.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
          const expected = limit === null ? eligible : eligible.slice(0, limit);
          compare('aws.iam.source-operators', sorted(expected.map(sourceGithubLogin)), sorted(users.map(user => user.name)), 2);
          compare('aws.iam.source-operator-paths', sorted(expected.map(person => JSON.stringify([sourceGithubLogin(person), '/people/']))), sorted(users.map(user => JSON.stringify([user.name, user.path]))), 2);
        }
        const roles = await list('ListRoles', xml => [...xml.matchAll(/<member>([\s\S]*?)<\/member>/g)].map(match => ({ name: xmlField(match[1], 'RoleName'), path: xmlField(match[1], 'Path'), description: xmlField(match[1], 'Description') })));
        const expectedRoles = world.software?.service_roles ?? projections.aws.iam.roles;
        compare('aws.iam.roles', sorted(array(expectedRoles).map(role => JSON.stringify([role.role_name, role.path, role.description ?? '']))), sorted(roles.map(role => JSON.stringify([role.name, role.path, role.description]))), 1);
        const failed = checks.some(entry => entry.status === 'failed' && entry.check.startsWith('aws.iam.'));
        for (const collection of ['projections.aws.iam', ...operatorCollections, 'software.service_roles']) coverage.push({ collection, provider: 'aws', path: '/iam/', status: failed ? 'failed' : 'passed', detail: 'Paginated ListUsers/ListRoles; source team/ID union, nullable limit, stable-ID cap and role fields checked.' });
      } else {
        const urls = await list('ListQueues', xml => [...xml.matchAll(/<QueueUrl>([^<]*)<\/QueueUrl>/g)].map(match => xmlField(match[0], 'QueueUrl')));
        const expected = world.software?.queues ?? projections.aws.sqs.queues;
        compare('aws.sqs.queues', sorted(array(expected).map(queue => queue.name)), sorted(urls.map(url => decodeURIComponent(new URL(url).pathname.split('/').at(-1)))), 12);
        for (const url of urls) {
          const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
          const xml = await query('GetQueueAttributes', { QueueUrl: url, 'AttributeName.1': 'All' });
          const attributes = Object.fromEntries([...xml.matchAll(/<Attribute>([\s\S]*?)<\/Attribute>/g)].map(match => [xmlField(match[1], 'Name'), xmlField(match[1], 'Value')]));
          const source = array(expected).find(queue => queue.name === name);
          if (source?.visibility_timeout !== undefined) compare(`aws.sqs.visibility.${name}`, source.visibility_timeout, Number(attributes.VisibilityTimeout), 12);
        }
        const failed = checks.some(entry => entry.status === 'failed' && entry.check.startsWith('aws.sqs.'));
        for (const collection of ['projections.aws.sqs', 'software.queues']) coverage.push({ collection, provider: 'aws', path: '/sqs/', status: failed ? 'failed' : 'passed', detail: 'Paginated ListQueues plus GetQueueAttributes; source names and visibility timeout.' });
      }
    });
    if (domain === 'iam') for (const collection of operatorCollections) {
      if (!coverage.some(entry => entry.provider === 'aws' && entry.collection === collection)) coverage.push({ collection, provider: 'aws', path: '/iam/', status: 'failed', detail: 'IAM read did not complete; source operator policy has no complete live evidence.' });
    }
  }
  if (selected.has('domain')) {
    const domain = await probeDomainWorld({ artifact, bindings, fetchImpl });
    checks.push(...domain.checks); responses.push(...domain.responses); coverage.push(...domain.coverage);
  }
  const implemented = new Set(['slack', 'google', 'linear', 'stripe', 's3', 'aws', 'apple', 'domain', ...supplementalProviders]);
  for (const provider of selected) if (!implemented.has(provider)) {
    check(`coverage.provider.${provider}`, false, { failure_kind: 'reader_gap', detail: 'No complete public API content reader is implemented for this selected provider.' });
    coverage.push({ collection: `provider:${provider}`, provider, path: null, status: 'failed', detail: 'API reader absent.' });
  }
  // These are actual sample bearer credentials from the local seed/test contract.
  // Read-only rejection checks do not claim OAuth client lifecycle coverage.
  for (const [provider, path, sample] of [['google', '/oauth2/v2/userinfo', 'demo_token'], ['stripe', '/v1/customers', 'stripe_token'], ['github', '/user', 'github_token'], ['okta', '/api/v1/users', 'okta_token']]) {
    if (!selected.has(provider) || !bindings[`${provider.toUpperCase()}_BASE_URL`]) continue;
    try { await request(provider, path, { headers: { authorization: `Bearer ${sample}` } }); check(`${provider}.sample-credential-rejected`, false, { finding: 11, detail: 'Sample bearer credential was accepted.' }); }
    catch (error) { check(`${provider}.sample-credential-rejected`, /HTTP (401|403)$/.test(error.message), { finding: 11, detail: error.message }); }
  }
  // Local package handlers authenticate these clients before checking the grant.
  // A bogus authorization code keeps the Linear/Slack/GitHub probes non-mutating.
  // Okta supports client_credentials; never retain an issued token in evidence.
  const oauthClients = [
    { provider: 'linear', path: '/oauth/token', client_id: 'lin_example_client_id', client_secret: 'example_client_secret', rejected: ['invalid_client'] },
    { provider: 'okta', path: '/oauth2/default/v1/token', client_id: 'okta-test-client', client_secret: 'okta-test-secret', rejected: ['invalid_client'], grant_type: 'client_credentials' },
    { provider: 'slack', path: '/api/oauth.v2.access', client_id: '12345.67890', client_secret: 'example_client_secret', rejected: ['invalid_client', 'invalid_client_id', 'bad_client_secret'] },
    { provider: 'github', path: '/login/oauth/access_token', client_id: 'Iv1.example_client_id', client_secret: 'example_client_secret', rejected: ['invalid_client', 'incorrect_client_credentials'] },
  ];
  for (const sample of oauthClients) {
    if (!selected.has(sample.provider)) continue;
    const name = `${sample.provider}.sample-oauth-client-rejected`;
    const base = bindings[`${sample.provider.toUpperCase()}_BASE_URL`];
    if (!base) { check(name, false, { finding: 11, detail: 'Provider binding is absent.' }); continue; }
    try {
      const response = await fetchImpl(`${base.replace(/\/$/, '')}${sample.path}`, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: sample.grant_type ?? 'authorization_code', client_id: sample.client_id, client_secret: sample.client_secret, code: 'coupling-invalid-code', scope: 'read' }),
      });
      const body = await response.json();
      const evidence = { error: body.error ?? null, grant_issued: Boolean(body.access_token), status: response.status };
      responses.push({ provider: sample.provider, path: sample.path, status: response.status, body: evidence });
      check(name, !body.access_token && sample.rejected.includes(body.error), { finding: 11, expected: sample.rejected, actual: evidence, detail: 'Known upstream client credentials must fail client authentication, not only fail an authorization code.' });
    } catch (error) { check(name, false, { finding: 11, detail: error.message }); }
  }
  if (selected.has('apple')) await run('apple.identity', async () => {
    const clients = array(projections['emulator-overlay']?.apple?.oauth_clients ?? projections.apple?.oauth_clients);
    const chosen = projections['emulator-overlay']?.apple?.worldfixture_oauth_client;
    const client = bindings.APPLE_CLIENT_ID ? clients.find(entry => entry.client_id === bindings.APPLE_CLIENT_ID) : chosen ?? (clients.length === 1 ? clients[0] : undefined);
    const clientId = bindings.APPLE_CLIENT_ID ?? client?.client_id;
    const redirectUri = bindings.APPLE_REDIRECT_URI ?? client?.redirect_uris?.[0];
    if (!clientId || !redirectUri) {
      coverage.push({ collection: 'people', provider: 'apple', path: '/auth/token', status: 'failed', detail: 'Apple identity cannot be exercised without a declared source/session client and redirect. No test application is added to this shipped artifact.' });
      check('apple.source-identity-client', false, { failure_kind: 'capability_gap', detail: 'This source/session declares no usable Apple OAuth client; signed people identity remains unproved. The separate OAuth source-variant matrix supplies explicit test applications.' });
      throw new Error('Apple world/run has no declared OAuth client ID and redirect URI. APPLE_TOKEN alone has no identity API in this provider.');
    }
    if (!bindings.APPLE_TOKEN && !bindings.APPLE_CLIENT_SECRET && !client) throw new Error('Apple run has no current credential or declared client for the identity flow.');
    const discovery = await request('apple', '/.well-known/openid-configuration');
    const keys = await request('apple', '/auth/keys');
    const base = bindings.APPLE_BASE_URL.replace(/\/$/, '');
    const subjects = [];
    for (const person of staff) {
      await run(`apple.identity.${person.id}`, async () => {
        const nonce = randomUUID();
        const headers = { 'content-type': 'application/x-www-form-urlencoded', ...(bindings.APPLE_TOKEN ? { authorization: `Bearer ${bindings.APPLE_TOKEN}` } : {}) };
        const consent = await fetchImpl(`${base}/auth/authorize/callback`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), headers,
          body: new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, email: person.email, scope: 'openid email name', response_mode: 'query', nonce }),
        });
        const location = consent.headers.get('location');
        responses.push({ provider: 'apple', path: '/auth/authorize/callback', status: consent.status, body: { source_person: person.id, redirected: Boolean(location) } });
        if (consent.status !== 302 || !location) throw new Error('Apple rejected the world client authorization request.');
        const callback = new URL(location);
        const returned = new URL(callback);
        for (const field of ['code', 'state', 'user']) returned.searchParams.delete(field);
        if (returned.href !== new URL(redirectUri).href) throw new Error('Apple returned an unexpected world callback destination.');
        const code = callback.searchParams.get('code');
        if (!code) throw new Error('Apple world authorization callback has no code.');
        const grant = await fetchImpl(`${base}/auth/token`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000), headers,
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, ...(bindings.APPLE_CLIENT_SECRET ? { client_secret: bindings.APPLE_CLIENT_SECRET } : {}) }),
        });
        const body = await grant.json();
        const evidence = { source_person: person.id, grant_issued: Boolean(body.access_token), error: body.error ?? null };
        responses.push({ provider: 'apple', path: '/auth/token', status: grant.status, body: evidence });
        if (!grant.ok || !body.access_token || !body.id_token) throw new Error('Apple world client did not receive an access grant and signed identity.');
        const identity = verifyAppleIdentity(body.id_token, keys.keys, { issuer: discovery.issuer, audience: clientId, nonce, email: person.email });
        subjects.push(identity.subject);
        check(`apple.source-identity.${person.id}`, true, { expected: person.email, actual: identity });
      });
    }
    compare('apple.source-identity-count', staff.length, subjects.length);
    compare('apple.source-identity-unique', staff.length, new Set(subjects).size);
    const failed = checks.some(entry => entry.status === 'failed' && (entry.check.startsWith('apple.source-identity') || entry.check.startsWith('provider.apple.identity.')));
    coverage.push({ collection: 'people', provider: 'apple', path: '/auth/token', status: failed ? 'failed' : 'passed', detail: 'Each source staff email mapped to a unique signed ID token subject through a declared world/run OAuth client; issuer, audience, expiry and nonce verified.' });
  });

  // These handlers check a real pending code before client authentication.
  // Exercise only synthetic identities from this world, and never follow the
  // callback redirect outside the provider. Evidence excludes codes and tokens.
  for (const provider of ['apple', 'clerk', 'vercel']) {
    if (!selected.has(provider)) continue;
    const name = `${provider}.sample-oauth-client-rejected`;
    const base = bindings[`${provider.toUpperCase()}_BASE_URL`];
    if (!base) { check(name, false, { finding: 11, detail: 'Provider binding is absent.' }); continue; }
    try {
      const {person: primary, selection} = sourceProviderActor(world, {emailOnly: true});
      check(`${provider}.oauth-actor-selection`, Boolean(primary), {actual: {source_person_id: primary?.id, selection}});
      if (!primary?.email) throw new Error('Source world has no email person for the OAuth probe.');
      const isClerk = provider === 'clerk';
      const isVercel = provider === 'vercel';
      const clientId = isClerk ? 'clerk_emulate_client' : isVercel ? 'oac_example_client_id' : 'com.example.app';
      const redirectUri = `http://localhost:3000/api/auth/callback/${provider}`;
      const callbackPath = isClerk || isVercel ? '/oauth/authorize/callback' : '/auth/authorize/callback';
      const tokenPath = isClerk ? '/oauth/token' : isVercel ? '/login/oauth/token' : '/auth/token';
      let userRef;
      if (isClerk) {
        const current = await request('clerk', '/oauth/userinfo');
        compare('clerk.oauth-current-identity', primary.email, current.email, 11);
        userRef = current.sub;
        if (!userRef) throw new Error('Clerk authenticated userinfo has no public user ID.');
      }
      if (isVercel) {
        const current = await request('vercel', '/v2/user');
        compare('vercel.oauth-current-identity', primary.email, current.user?.email, 11);
        userRef = current.user?.username;
        if (!userRef) throw new Error('Vercel authenticated user has no public username.');
      }
      const consent = await fetchImpl(`${base.replace(/\/$/, '')}${callbackPath}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'openid email profile', response_mode: 'query', ...(isClerk ? { user_ref: userRef } : isVercel ? { username: userRef } : { email: primary.email }) }),
      });
      const consentText = await consent.text();
      const location = consent.headers.get('location');
      let consentBody; try { consentBody = JSON.parse(consentText); } catch { /* Legacy native rejection is HTML. */ }
      const refusedClient = ([400, 401].includes(consent.status) && consentBody?.error === 'invalid_client' && !consentBody.access_token && !location)
        || consent.status === 400 && /Application not found|client_id[^<]*not registered/.test(consentText);
      responses.push({ provider, path: callbackPath, status: consent.status, body: { client_rejected: refusedClient, redirected: Boolean(location) } });
      if (refusedClient) {
        check(name, true, { finding: 11, actual: { client_rejected: true, stage: 'authorization' }, detail: 'Known sample client rejected before a code can be issued.' });
        continue;
      }
      if (consent.status !== 302 || !location) throw new Error('Sample authorization callback did not return either a client rejection or an authorization-code redirect.');
      const callback = new URL(location);
      if (`${callback.origin}${callback.pathname}` !== redirectUri) throw new Error('Provider returned an unexpected callback destination.');
      const code = callback.searchParams.get('code');
      if (!code) throw new Error('Provider authorization callback has no code.');
      const exchange = await fetchImpl(`${base.replace(/\/$/, '')}${tokenPath}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, ...(isClerk ? { client_secret: 'clerk_emulate_secret' } : isVercel ? { client_secret: 'example_client_secret' } : {}) }),
      });
      const body = await exchange.json();
      const evidence = { error: body.error ?? null, grant_issued: Boolean(body.access_token), status: exchange.status };
      responses.push({ provider, path: tokenPath, status: exchange.status, body: evidence });
      check(name, !body.access_token && body.error === 'invalid_client', { finding: 11, expected: 'invalid_client', actual: evidence, detail: isClerk || isVercel ? 'Exchanged a real synthetic authorization code with the known upstream client secret.' : 'Exchanged a real synthetic authorization code for the upstream sample Apple client, which declares no secret.' });
    } catch (error) { check(name, false, { finding: 11, detail: error.message }); }
  }


  if (Object.keys(world.software?.oauth_clients ?? {}).length) {
    const oauth = await probeDeclaredOAuthWorld({ artifact, bindings, credentials, fetchImpl });
    checks.push(...oauth.checks); responses.push(...oauth.responses); coverage.push(...oauth.coverage);
  }

  return { checks, responses, coverage };
}
