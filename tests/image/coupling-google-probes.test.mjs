import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailText, probeGoogleWorld } from './coupling-google-probes.mjs';

const reply = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const fixture = () => {
  const world = { id: 'alien-google', version: 'v1', people: [
    { id: 'mono', name: 'Mono', email: 'mono@alien.test', primary: true },
    { id: 'two', name: 'Two', email: 'two@alien.test' },
  ], communication: {
    calendars: [{ id: 'calendar-orbit', name: 'Orbit', primary: true }],
    calendar_events: [{ id: 'event-one', calendar_id: 'calendar-orbit', summary: 'Source event', description: 'Source description', start: '2031-02-11T09:00:00+02:00', end: '2031-02-11T10:00:00+02:00', attendees: ['mono@alien.test', 'two@alien.test'] }],
    mail: [{ id: 'mail-one', thread_id: 'thread-one', subject: 'Source mail', body_text: 'First line\nSecond line', from_id: 'two', to_ids: ['mono'], labels: ['INBOX', 'Orbit'] }],
  } };
  return { world, projections: { google: { calendars: world.communication.calendars, calendar_events: world.communication.calendar_events, messages: [{ id: 'mail-one' }] } } };
};
const credentials = { world: { id: 'alien-google', version: 'v1' }, values: { 'token:google_token_mono': 'run-mono', 'token:google_token_two': 'run-two' } };
const bindings = { GOOGLE_BASE_URL: 'http://google.test', GOOGLE_TOKEN: 'run-mono' };

test('Google provider actor selection is explicit when no primary exists and no-email people do not get invented mailboxes', async () => {
  const artifact = fixture(); delete artifact.world.people[0].primary;
  artifact.world.people.push({id: 'no-mail', name: 'No mailbox'});
  artifact.world.communication.calendars[0].owner_id = 'mono';
  artifact.world.communication.calendar_events[0].owner_id = 'mono';
  const result = await probeGoogleWorld({artifact, bindings: {GOOGLE_BASE_URL: bindings.GOOGLE_BASE_URL}, credentials, ...service()});
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.deepEqual(result.checks.find(row => row.check === 'google.exact.current-actor-selection').actual,
    {source_person_id: null, selection: 'none'});
  assert.equal(result.responses.some(row => row.actor_id === 'no-mail'), false);
});
const message = (id = 'mail-one') => ({ id, threadId: 'thread-one', labelIds: ['INBOX', 'Label_orbit'], payload: {
  mimeType: 'text/plain', headers: [{ name: 'From', value: 'Two <two@alien.test>' }, { name: 'To', value: 'Mono <mono@alien.test>' }, { name: 'Subject', value: 'Source mail' }],
  body: { data: Buffer.from('First line\nSecond line').toString('base64url') },
} });
function service({ changedEvent = false, missingMail = false, foreignMail = false, changedMail = false, wrongLabels = false, pagination = false, loop = false, secondMailbox = false } = {}) {
  const calls = [];
  const fetchImpl = async (value, options) => {
    const url = new URL(value), actor = options.headers.authorization === 'Bearer run-two' ? 'two' : 'mono';
    calls.push({ path: url.pathname, query: url.search, actor });
    if (url.pathname === '/oauth2/v2/userinfo') return reply({ email: `${actor}@alien.test` });
    if (url.pathname.includes('calendarList')) {
      const items = [{ id: 'calendar-orbit', summary: 'Orbit', primary: true }];
      if (pagination && !url.searchParams.has('pageToken')) return reply({ items: [], nextPageToken: 'next-calendar' });
      return reply({ items, ...(loop ? { nextPageToken: 'next-calendar' } : {}) });
    }
    if (url.pathname.endsWith('/events')) {
      const items = [{ id: 'event-one', summary: 'Source event', description: 'Source description', start: { dateTime: '2031-02-11T07:00:00Z' }, end: { dateTime: '2031-02-11T08:00:00Z' }, attendees: [{ email: 'mono@alien.test' }, { email: changedEvent ? 'foreign@other.test' : 'two@alien.test' }] }];
      if (pagination && !url.searchParams.has('pageToken')) return reply({ items: [], nextPageToken: 'next-event' });
      return reply({ items });
    }
    if (url.pathname.endsWith('/labels')) return reply({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, ...((secondMailbox ? actor === 'two' : actor === 'mono') ? [{ id: 'Label_orbit', name: 'Orbit', type: 'user' }] : []), { id: 'UNREAD', name: 'UNREAD', type: 'system' }] });
    if (url.pathname.endsWith('/messages')) {
      const messages = missingMail || (secondMailbox ? actor === 'mono' : actor === 'two') ? [] : [{ id: 'mail-one' }, ...(foreignMail ? [{ id: 'foreign-mail' }] : [])];
      if (pagination && !url.searchParams.has('pageToken')) return reply({ messages: [], nextPageToken: 'next-mail' });
      return reply({ messages, resultSizeEstimate: messages.length });
    }
    const result = message(url.pathname.split('/').at(-1));
    if (changedMail) result.payload.body.data = Buffer.from('Changed source body').toString('base64url');
    if (wrongLabels) result.labelIds = ['INBOX', 'UNREAD'];
    if (secondMailbox) {
      result.payload.headers.find(header => header.name === 'To').value = 'two@alien.test';
      result.payload.headers.find(header => header.name === 'From').value = 'mono@alien.test';
    }
    return reply(result);
  };
  return { fetchImpl, calls };
}
const find = (result, name) => result.checks.find(entry => entry.check === name);

test('Google exact reader follows pagination and checks source event attendees and Gmail content', async () => {
  const server = service({ pagination: true });
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: server.fetchImpl });
  assert.equal(result.checks.filter(entry => entry.status === 'failed').length, 0);
  for (const page of ['next-calendar', 'next-event', 'next-mail']) assert(server.calls.some(call => call.query.includes(page)));
  assert.equal(result.coverage.length, 9);
  assert(result.coverage.every(entry => entry.status === 'passed'));
  assert.equal(JSON.stringify(result).includes('run-mono'), false);
});

test('changed calendar attendee fails the event and nested attendee coverage', async () => {
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: service({ changedEvent: true }).fetchImpl });
  assert.equal(find(result, 'google.exact.event.attendees.event-one').status, 'failed');
  assert.equal(result.coverage.find(entry => entry.collection.endsWith('[].attendees')).status, 'failed');
});

for (const change of ['missingMail', 'foreignMail', 'changedMail', 'wrongLabels']) test(`${change} cannot pass Gmail source checks`, async () => {
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: service({ [change]: true }).fetchImpl });
  const check = change === 'missingMail' || change === 'foreignMail' ? 'google.exact.mail.ids.mono' : change === 'changedMail' ? 'google.exact.mail.record.mono.mail-one' : 'google.exact.mail.labels.mono.mail-one';
  assert.equal(find(result, check).status, 'failed');
  assert.equal(result.coverage.find(entry => entry.collection === 'communication.mail[].labels').status, 'failed');
});

test('repeated Calendar page token is a failure, never partial coverage', async () => {
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: service({ pagination: true, loop: true }).fetchImpl });
  assert.equal(find(result, 'google.exact.calendar-owner.mono@alien.test').status, 'failed');
  assert.match(find(result, 'google.exact.calendar-owner.mono@alien.test').detail, /repeated/);
  assert.equal(result.coverage.find(entry => entry.collection === 'communication.calendars').status, 'failed');
});

test('mailbox reads use its current personal credential, and absent credentials fail', async () => {
  const input = fixture();
  input.world.communication.mail[0].to_ids = ['two'];
  input.world.communication.mail[0].from_id = 'mono';
  const server = service({ secondMailbox: true });
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: server.fetchImpl });
  assert.equal(find(result, 'google.exact.mail.record.two.mail-one').status, 'passed');
  assert(server.calls.some(call => call.path.includes('two%40alien.test/messages') && call.actor === 'two'));
  const missing = await probeGoogleWorld({ artifact: input, bindings, credentials: { ...credentials, values: {} }, fetchImpl: server.fetchImpl });
  assert.equal(find(missing, 'google.exact.mailbox.two').status, 'failed');
  assert.match(find(missing, 'google.exact.mailbox.two').detail, /No current Google credential/);
});

test('plain MIME body is selected from multipart mail and CRLF is normalized', () => {
  assert.equal(gmailText({ payload: { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', filename: 'attachment.txt', body: { data: Buffer.from('Attachment').toString('base64url') } },
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Body\r\nSecond').toString('base64url') } }] },
  ] } }), 'Body\nSecond');
});


test('a foreign live label name cannot redefine the source label expectation', async () => {
  const server = service();
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: async (url, options) => {
    const response = await server.fetchImpl(url, options);
    const body = await response.json();
    if (new URL(url).pathname.endsWith('/labels') && body.labels.some(label => label.id === 'Label_orbit')) {
      body.labels.find(label => label.id === 'Label_orbit').id = 'Orbit';
      body.labels.find(label => label.id === 'Orbit').name = 'Foreign';
    } else if (new URL(url).pathname.endsWith('/mail-one')) body.labelIds = ['INBOX', 'Orbit'];
    return reply(body);
  } });
  assert.equal(find(result, 'google.exact.mail.labels.mono.mail-one').status, 'failed');
  assert.deepEqual(find(result, 'google.exact.mail.labels.mono.mail-one').expected, ['INBOX', 'Orbit']);
  assert.deepEqual(find(result, 'google.exact.mail.labels.mono.mail-one').actual, ['Foreign', 'INBOX']);
  assert.equal(find(result, 'google.exact.mail.custom-label.mono.Orbit').status, 'failed');
  assert.equal(result.coverage.find(entry => entry.collection === 'communication.mail[].labels').status, 'failed');
});

test('a system label cannot become a custom label with the same name', async () => {
  const server = service();
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: async (url, options) => {
    const response = await server.fetchImpl(url, options);
    const body = await response.json();
    if (new URL(url).pathname.endsWith('/labels')) body.labels.find(label => label.id === 'INBOX').type = 'user';
    return reply(body);
  } });
  assert.equal(find(result, 'google.exact.mail.system-label.mono.INBOX').status, 'failed');
  assert.equal(result.coverage.find(entry => entry.collection === 'communication.mail[].labels').status, 'failed');
});

for (const after_seconds of [0, 3600]) test(`arrival at ${after_seconds}s uses source defaults and only passes when due`, async () => {
  const input = fixture();
  input.world.timeline = [{ id: 'arrival-extra', kind: 'incoming-email', after_seconds, payload: { via: 'gmail', from_id: 'two', to_id: 'mono', snippet: 'Source snippet body' } }];
  const server = service();
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, elapsedMs: 0, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/arrival-extra')) return reply({ id: 'arrival-extra', threadId: 'thread-arrival-extra', labelIds: ['INBOX', 'UNREAD'], payload: { mimeType: 'text/plain', body: { data: Buffer.from('Source snippet body').toString('base64url') }, headers: [{ name: 'Subject', value: '' }, { name: 'From', value: 'two@alien.test' }, { name: 'To', value: 'mono@alien.test' }] } });
    const body = await (await server.fetchImpl(url, options)).json();
    if (path.includes('mono%40alien.test') && path.endsWith('/messages')) body.messages.push({ id: 'arrival-extra' });
    return reply(body);
  } });
  assert.equal(find(result, 'google.exact.mail.ids.mono').status, after_seconds === 0 ? 'passed' : 'failed');
  if (after_seconds === 0) assert.equal(find(result, 'google.exact.mail.record.mono.arrival-extra').status, 'passed');
});

test('future authored labels may be present before their message is due', async () => {
  const input = fixture();
  input.world.timeline = [{ id: 'future', kind: 'incoming-email', after_seconds: 10000, payload: { via: 'gmail', from_id: 'two', to_id: 'mono', labels: ['Future source label'] } }];
  const server = service();
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, elapsedMs: 0, fetchImpl: async (url, options) => {
    const body = await (await server.fetchImpl(url, options)).json();
    if (new URL(url).pathname.includes('mono%40alien.test') && new URL(url).pathname.endsWith('/labels')) body.labels.push({ id: 'Label_future', name: 'Future source label', type: 'user' });
    return reply(body);
  } });
  assert.equal(find(result, 'google.exact.mail.foreign-custom-labels.mono').status, 'passed');
  assert.equal(find(result, 'google.exact.mail.ids.mono').status, 'passed');
});

test('a source person with an empty expected mailbox is read and foreign mail fails', async () => {
  const server = service();
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: async (url, options) => {
    const body = await (await server.fetchImpl(url, options)).json();
    if (new URL(url).pathname.includes('two%40alien.test') && new URL(url).pathname.endsWith('/messages')) body.messages = [{ id: 'foreign-mail' }];
    return reply(body);
  } });
  assert(server.calls.some(call => call.path.includes('two%40alien.test/messages') && call.actor === 'two'));
  assert.equal(find(result, 'google.exact.mail.ids.two').status, 'failed');
});

test('text/plain attachment bodies are fetched and checked against source text', async () => {
  const server = service();
  let fetched = false;
  const result = await probeGoogleWorld({ artifact: fixture(), bindings, credentials, fetchImpl: async (url, options) => {
    if (new URL(url).pathname.endsWith('/attachments/body-part')) { fetched = true; return reply({ size: 22, data: Buffer.from('First line\nSecond line').toString('base64url') }); }
    const body = await (await server.fetchImpl(url, options)).json();
    if (new URL(url).pathname.endsWith('/mail-one')) body.payload.body = { size: 22, attachmentId: 'body-part' };
    return reply(body);
  } });
  assert(fetched);
  assert.equal(find(result, 'google.exact.mail.record.mono.mail-one').status, 'passed');
  assert(result.responses.some(entry => entry.path.endsWith('/attachments/body-part')));
});

const systemLabels = ['INBOX', 'SENT', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'DRAFT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
function versionedFixture() {
  const input = fixture();
  input.identity = { id: input.world.id, version: input.world.version, digest: 'a'.repeat(64) };
  input.world.communication.mailboxes = [{ owner_id: 'mono', labels: ['Orbit', 'FutureUnused'] }, { owner_id: 'two', labels: [] }];
  input.projections['emulator-overlay'] = { google: { worldfixture_seed_version: 1 } };
  input.projections.google.messages = [{ id: 'provider-mail', worldfixture_message_id: 'mail-one', worldfixture_owner_id: 'mono' }];
  const receipt = { api_version: 'worldfixture.google-seed-receipt/v1', world: { ...input.identity },
    mailboxes: input.world.people.map(person => ({ source_person_id: person.id, email: person.email })),
    messages: [{ source_person_id: 'mono', source_message_id: 'mail-one', provider_message_id: 'provider-mail' }], drive_items: [] };
  return { input, receipt };
}
function versionedService(receipt, { alter = () => {}, pagination = false } = {}) {
  const server = service({ pagination });
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    const path = new URL(url), actor = options.headers.authorization === 'Bearer run-two' ? 'two' : 'mono';
    calls.push({ path: path.pathname, query: path.search, actor });
    if (path.pathname === '/_worldfixture/seed-receipt') return reply(receipt);
    if (path.pathname === '/drive/v3/files') return reply({ files: [] });
    let body = await (await server.fetchImpl(url, options)).json();
    if (path.pathname.endsWith('/messages')) body.messages = body.messages.map(row => ({ ...row, id: row.id === 'mail-one' ? 'provider-mail' : row.id }));
    if (path.pathname.endsWith('/labels')) body.labels = [...systemLabels.map(name => ({ id: name, name, type: 'system' })),
      ...(actor === 'mono' ? [{ id: 'Label_orbit', name: 'Orbit', type: 'user' }, { id: 'Label_future', name: 'FutureUnused', type: 'user' }] : [])];
    alter(body, path, actor);
    return reply(body);
  } };
}

test('versioned Google uses receipt IDs and actual owner/label reads for authored mailbox coverage', async () => {
  const { input, receipt } = versionedFixture(), server = versionedService(receipt, { pagination: true });
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: server.fetchImpl });
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.equal(find(result, 'google.exact.mail.record.mono.mail-one').actual.id, 'provider-mail');
  assert(server.calls.some(call => call.path.endsWith('/provider-mail')));
  assert(server.calls.some(call => call.actor === 'two' && call.path.endsWith('/labels')));
  assert(result.coverage.some(row => row.collection === 'communication.mailboxes' && row.status === 'passed'));
  assert(result.coverage.some(row => row.collection === 'communication.mailboxes[].labels' && row.status === 'passed'));
});

for (const damage of ['digest', 'missing', 'foreign', 'duplicate-source', 'duplicate-provider', 'owner']) test(`Google receipt ${damage} cannot establish identity or pass content coverage`, async () => {
  const { input, receipt } = versionedFixture();
  if (damage === 'digest') receipt.world.digest = 'b'.repeat(64);
  if (damage === 'missing') receipt.messages = [];
  if (damage === 'foreign') receipt.messages[0].source_message_id = 'foreign';
  if (damage === 'duplicate-source') receipt.messages.push({ ...receipt.messages[0], provider_message_id: 'another' });
  if (damage === 'duplicate-provider') receipt.messages.push({ ...receipt.messages[0], source_message_id: 'another' });
  if (damage === 'owner') receipt.mailboxes[0].email = 'foreign@other.test';
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: versionedService(receipt).fetchImpl });
  assert.equal(find(result, 'google.exact.receipt').status, 'failed');
  assert(result.coverage.filter(row => row.collection.startsWith('communication.mail')).every(row => row.status === 'failed'));
});

test('a valid Google mapping cannot hide changed API content or a missing future-only custom label', async () => {
  for (const change of ['body', 'label']) {
    const { input, receipt } = versionedFixture();
    const server = versionedService(receipt, { alter: (body, path) => {
      if (change === 'body' && path.pathname.endsWith('/provider-mail')) body.payload.body.data = Buffer.from('Changed').toString('base64url');
      if (change === 'label' && path.pathname.endsWith('/labels')) body.labels = body.labels.filter(label => label.name !== 'FutureUnused');
    } });
    const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: server.fetchImpl });
    assert.equal(find(result, change === 'body' ? 'google.exact.mail.record.mono.mail-one' : 'google.exact.mail.custom-label.mono.FutureUnused').status, 'failed');
    assert.equal(find(result, 'google.exact.mailbox.mono').status, 'failed');
  }
});

test('explicit Google subsets and empty declarations never infer other source mailbox owners', async () => {
  for (const owners of [['two'], []]) {
    const { input, receipt } = versionedFixture();
    input.world.communication.mailboxes = owners.map(owner_id => ({ owner_id, labels: [] }));
    input.world.communication.calendars = []; input.world.communication.calendar_events = [];
    input.projections.google = { messages: [], calendars: [], calendar_events: [] };
    receipt.mailboxes = receipt.mailboxes.filter(row => owners.includes(row.source_person_id)); receipt.messages = [];
    const server = versionedService(receipt);
    const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: server.fetchImpl });
    assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
    assert.equal(server.calls.some(call => call.path.includes('mono%40alien.test')), false);
    assert.equal(server.calls.filter(call => call.path.endsWith('/labels')).length, owners.length);
  }
});

test('Google receipt HTTP failures remain measured failures with response evidence', async () => {
  const { input } = versionedFixture();
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: async url => new URL(url).pathname === '/oauth2/v2/userinfo'
    ? reply({ email: 'mono@alien.test' }) : new Response('unavailable', { status: 503 }) });
  assert.equal(find(result, 'google.exact.receipt').status, 'failed');
  assert(result.responses.some(row => row.path === '/_worldfixture/seed-receipt' && row.status === 503));
});

test('versioned Gmail arrivals use the actual provider ID from current runtime evidence', async () => {
  const { input, receipt } = versionedFixture();
  input.world.timeline = [{ id: 'arrival-source', kind: 'incoming-email', after_seconds: 0,
    payload: { via: 'gmail', from_id: 'two', to_id: 'mono', subject: 'Arrival subject', body_text: 'Arrival body', labels: ['INBOX'] } }];
  const server = versionedService(receipt, { alter: (body, path, actor) => {
    if (path.pathname.endsWith('/messages') && actor === 'mono') body.messages.push({ id: 'arrival-provider' });
    if (path.pathname.endsWith('/arrival-provider')) {
      body.threadId = 'thread-arrival-source'; body.labelIds = ['INBOX'];
      body.payload.headers.find(row => row.name === 'Subject').value = 'Arrival subject';
      body.payload.body.data = Buffer.from('Arrival body').toString('base64url');
    }
  } });
  const accepted = { source: 'google', actor_id: 'mono', provider_evidence: { arrival: 'arrival-source', message_id: 'arrival-provider' } };
  const result = await probeGoogleWorld({ artifact: input, bindings, credentials, arrivalReceipts: [accepted], fetchImpl: server.fetchImpl });
  assert.equal(find(result, 'google.exact.mail.record.mono.arrival-source').status, 'passed');
  assert.equal(find(result, 'google.exact.mail.ids.mono').status, 'passed');
  const missing = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: server.fetchImpl });
  assert.equal(find(missing, 'google.exact.mail.ids.mono').status, 'failed');
  const duplicate = await probeGoogleWorld({ artifact: input, bindings, credentials, arrivalReceipts: [accepted, accepted], fetchImpl: server.fetchImpl });
  assert.equal(find(duplicate, 'google.exact.mail.arrival-identities.mono').status, 'failed');
});

test('Drive reader uses receipt IDs but source ownership, fields and media content', async () => {
  const { input, receipt } = versionedFixture();
  input.world.communication.documents = [{ id: 'doc-source', owner_id: 'two', name: 'Source.md', mime_type: 'text/markdown', content: '# Exact\n\nContent.\n' }];
  receipt.drive_items = [{ source_person_id: 'two', source_document_id: 'doc-source', provider_file_id: 'doc-provider' }];
  for (const changed of [false, true]) {
    const server = versionedService(receipt);
    const result = await probeGoogleWorld({ artifact: input, bindings, credentials, fetchImpl: async (url, options) => {
      const path = new URL(url), second = options.headers.authorization === 'Bearer run-two';
      if (path.pathname === '/drive/v3/files' && second) return reply(path.searchParams.has('pageToken') ? { files: [{ id: 'doc-provider' }] } : { files: [], nextPageToken: 'drive-next' });
      if (path.pathname === '/drive/v3/files/doc-provider') {
        assert.equal(second, true);
        return path.searchParams.get('alt') === 'media' ? new Response(changed ? 'Changed' : '# Exact\n\nContent.\n') : reply({ id: 'doc-provider', name: 'Source.md', mimeType: 'text/markdown' });
      }
      return server.fetchImpl(url, options);
    } });
    assert.equal(find(result, 'google.exact.drive.body.doc-source').status, changed ? 'failed' : 'passed');
    assert.equal(result.coverage.find(row => row.collection === 'communication.documents').status, changed ? 'failed' : 'passed');
  }
});
