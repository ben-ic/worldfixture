import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProviders } from '../src/providers/index.mjs';
import { localFetch } from '../src/providers/safety.mjs';

test('Google media defaults are blocked before any production network request', async () => {
  const { google } = await import('googleapis');
  let requests = 0;
  const guarded = localFetch('http://127.0.0.1:34567', async () => { requests++; throw new Error('Unexpected network request'); });
  const drive = google.drive({ version: 'v3', rootUrl: 'http://127.0.0.1:34567/', fetchImplementation: guarded, retry: false });
  // googleapis computes mediaUrl before its constructor-level root rewrite.
  // The app also passes rootUrl per upload call. This test proves defense in
  // depth if a future upload call forgets that per-call option.
  await assert.rejects(drive.files.create({ requestBody: { name: 'blocked' }, media: { mimeType: 'text/plain', body: 'Local test content' } }), /Only generated local HTTP bindings/);
  assert.equal(requests, 0);
});

// These tests prove adapter/SDK request construction against a local test
// server. They do not prove emulator integration or production-provider parity.
test('official SDK adapters use dynamic local bindings and fresh write readback', async t => {
  const requests = [];
  let googleRateLimited = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, body });
    if (googleRateLimited && /^\/(gmail|calendar|drive)\//.test(url.pathname)) {
      response.writeHead(403, { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600) });
      response.end('{"message":"API rate limit exceeded"}');
      return;
    }
    let result;
    if (url.pathname === '/api/users.list') result = { ok: true, members: [{ id: 'u1', real_name: 'User One' }] };
    else if (url.pathname === '/api/conversations.list') result = { ok: true, channels: [{ id: 'c1', name: 'customer-help' }] };
    else if (url.pathname === '/api/conversations.history') {
      const parameters = new URLSearchParams(body);
      // Without an upper timestamp bound, future-authored world messages fill
      // the first page and hide the message this action just created.
      const exact = parameters.get('oldest') === '123.01' && parameters.get('latest') === '123.01' && parameters.get('inclusive') === 'true';
      const found = exact && parameters.get('cursor') === 'find-write';
      result = { ok: true, messages: [{ ts: found ? '123.01' : '999.01', user: 'u1', text: found ? 'Approved update' : 'Future-authored message' }], response_metadata: exact && !found ? { next_cursor: 'find-write' } : {} };
    }
    else if (url.pathname === '/api/chat.postMessage') result = { ok: true, channel: 'c1', ts: '123.01' };
    else if (url.pathname === '/user/repos') result = [];
    else if (url.pathname === '/search/repositories') result = { total_count: 1, items: [{ id: 1, name: 'app', owner: { login: 'team' } }] };
    else if (url.pathname === '/repos/team/app/issues' && request.method === 'GET') result = [{ id: 2, number: 1, title: 'Follow up', state: 'open' }];
    else if (url.pathname === '/repos/team/app/issues') result = { id: 2, number: 1, title: 'Follow up', state: 'open' };
    else if (url.pathname === '/repos/team/app/issues/1') result = { id: 2, number: 1, title: 'Follow up', state: 'open' };
    else if (url.pathname === '/gmail/v1/users/me/messages') result = { messages: [{ id: 'mail1' }] };
    else if (url.pathname === '/gmail/v1/users/me/messages/send') result = { id: 'mail1', threadId: 'thread1' };
    else if (url.pathname === '/gmail/v1/users/me/messages/mail1') result = { id: 'mail1', threadId: 'thread1', labelIds: ['SENT'], snippet: 'Hello', payload: { headers: [{ name: 'Subject', value: 'Follow up' }, { name: 'From', value: 'person@world.test' }] } };
    else if (url.pathname === '/gmail/v1/users/me/threads/thread1') result = { id: 'thread1', messages: [{ id: 'original1', payload: { headers: [{ name: 'Message-ID', value: '<original1@world.test>' }, { name: 'Subject', value: 'Follow up' }] } }, { id: 'mail1' }] };
    else if (url.pathname === '/calendar/v3/users/me/calendarList') result = { items: [{ id: 'cal1', summary: 'Team' }] };
    else if (url.pathname === '/calendar/v3/calendars/cal1/events') result = { items: [{ id: 'event1', summary: 'Meeting' }] };
    else if (url.pathname === '/drive/v3/files') result = { files: [{ id: 'file1', name: 'Brief' }] };
    else if (url.pathname === '/upload/drive/v3/files') result = { id: 'file1', name: 'Brief', mimeType: 'text/plain' };
    else if (url.pathname === '/drive/v3/files/file1') result = { id: 'file1', name: 'Brief', mimeType: 'text/plain' };
    else if (url.pathname === '/v1/search') result = { results: [{ id: 'page1', object: 'page', properties: { title: { type: 'title', title: [{ plain_text: 'Account note' }] } } }], has_more: false };
    else if (url.pathname === '/v1/blocks/page1/children') result = { results: [{ id: 'block1', paragraph: { rich_text: [{ plain_text: 'Approved note' }] } }], has_more: false };
    else if (url.pathname === '/v1/customers') result = { object: 'list', data: [{ id: 'cus1', name: 'Customer One' }], has_more: false };
    else if (url.pathname === '/v1/invoices' || url.pathname === '/v1/subscriptions') result = { object: 'list', data: [], has_more: false };
    else if (url.pathname === '/bucket' || url.pathname === '/bucket/') {
      response.setHeader('Content-Type', 'application/xml');
      response.end('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><IsTruncated>false</IsTruncated><Contents><Key>brief.txt</Key><Size>3</Size></Contents></ListBucketResult>');
      return;
    } else if (url.pathname === '/bucket/brief.txt') {
      response.setHeader('ETag', '"etag"');
      response.end(request.method === 'PUT' ? '' : 'Approved file');
      return;
    } else { response.statusCode = 404; result = { error: `Unexpected route ${url.pathname}` }; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { S3_BUCKET: 'bucket', S3_ACCESS_KEY_ID: 'local', S3_SECRET_ACCESS_KEY: 'local' };
  for (const prefix of ['SLACK', 'GITHUB', 'GOOGLE', 'NOTION', 'STRIPE', 'S3']) { env[`${prefix}_BASE_URL`] = base; env[`${prefix}_TOKEN`] = 'local-token'; }
  const providers = createProviders(env);
  for (const id of ['slack', 'github', 'gmail', 'calendar', 'drive', 'notion', 'stripe', 's3']) {
    await t.test(`${id} SDK read`, async () => { const data = await providers.read(id); assert.ok(data.items.length > 0); });
  }
  const detailCalls = () => requests.filter(item => item.path === '/gmail/v1/users/me/messages/mail1').length;
  const beforePoll = detailCalls();
  const polling = await providers.read('gmail', { purpose: 'poll' });
  assert.equal(detailCalls(), beforePoll, 'Background polling reuses unchanged message details.');
  assert.equal(polling.messages[0].detailCached, true);
  assert.match(polling.note, /message list is fresh/);
  const [freshOne, freshTwo] = await Promise.all([providers.read('gmail'), providers.read('gmail')]);
  assert.equal(detailCalls(), beforePoll + 1, 'Concurrent fresh reads share one in-flight request, not a saved result.');
  assert.equal(freshOne.messages[0].detailCached, false);
  assert.deepEqual(freshOne, freshTwo);
  const actions = [
    ['slack.send', { channel: 'c1', text: 'Approved update' }],
    ['github.issue', { owner: 'team', repo: 'app', title: 'Follow up', body: 'Details' }],
    ['gmail.send', { to: 'person@world.test', subject: 'Follow up', text: 'Hello' }],
    ['gmail.send', { to: 'person@world.test', subject: 'Re: Follow up', text: 'Confirmed reply', threadId: 'thread1', inReplyTo: '<original1@world.test>', references: '<original1@world.test>' }],
    ['notion.note', { pageId: 'page1', text: 'Approved note' }],
    ['s3.put', { bucket: 'bucket', key: 'brief.txt', text: 'Approved file' }],
    ['drive.file', { name: 'Brief', text: 'Approved file' }],
  ];
  for (const [id, input] of actions) await t.test(`${id} SDK write and readback`, async () => {
    const result = await providers.execute(id, input);
    assert.equal(result.operation, id);
    assert.ok(result.record);
    assert.ok(result.readback);
  });
  assert.ok(requests.some(item => item.path === '/gmail/v1/users/me/messages/send' && JSON.parse(item.body).raw));
  const replied = requests.find(item => item.path === '/gmail/v1/users/me/messages/send' && JSON.parse(item.body).threadId);
  assert.equal(JSON.parse(replied.body).threadId, 'thread1');
  assert.match(Buffer.from(JSON.parse(replied.body).raw, 'base64url').toString(), /In-Reply-To: <original1@world.test>\r\nReferences: <original1@world.test>/);
  const sendsBeforeInvalidReply = requests.filter(item => item.path.endsWith('/messages/send')).length;
  await assert.rejects(providers.execute('gmail.send', { to: 'person@world.test', subject: 'Different subject', text: 'Must not send', threadId: 'thread1', inReplyTo: '<original1@world.test>', references: '<original1@world.test>' }), /keep the original subject/);
  assert.equal(requests.filter(item => item.path.endsWith('/messages/send')).length, sendsBeforeInvalidReply);
  assert.ok(requests.some(item => item.path === '/upload/drive/v3/files' && item.body.includes('Approved file')));
  googleRateLimited = true;
  const beforeLimited = requests.length;
  for (const service of ['gmail', 'calendar', 'drive']) {
    await assert.rejects(providers.read(service), error => error.code === 'PROVIDER_RATE_LIMIT' && typeof error.retryAt === 'string' && !error.config);
  }
  assert.equal(requests.length, beforeLimited + 1, 'The real Google SDK preserves one shared cooldown without more requests.');
});
