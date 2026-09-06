import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createSecondarySdk } from '../src/providers/secondary-sdks.mjs';

const sid = `AC${'1'.repeat(32)}`;
const messageId = `SM${'2'.repeat(32)}`;
const message = { sid: messageId, account_sid: sid, body: 'Test SMS', from: '+15550000001', to: '+15550000002', status: 'queued' };
async function fixture(handler) {
  const requests = [];
  const state = { issue: { id: 'issue-1', identifier: 'DEMO-1', title: 'Test issue', description: 'Description' }, email: { id: 'email-1', subject: 'Test email', text: 'Text', from: 'sender@demo.test', to: ['recipient@demo.test'] } };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const record = { method: request.method, url: request.url, headers: request.headers, body };
    requests.push(record);
    if (handler) return handler(record, response);
    const url = new URL(request.url, 'http://127.0.0.1');
    let result;
    if (url.pathname === '/graphql') {
      const { query, variables } = JSON.parse(body);
      assert.equal(request.headers.authorization, 'Bearer linear-test-token');
      if (query.includes('issueCreate')) {
        state.issue = { id: 'issue-1', ...variables.input };
        result = { data: { issueCreate: { success: true, issue: state.issue } } };
      } else if (query.includes('issue(id:')) result = { data: { issue: state.issue } };
      else {
        const resource = query.includes('teams(') ? 'teams' : 'issues';
        result = { data: { [resource]: { nodes: resource === 'teams' ? [{ id: 'team-1', name: 'Team one' }] : [state.issue], pageInfo: { hasNextPage: false } } } };
      }
    } else if (url.pathname.startsWith('/emails')) {
      assert.equal(request.headers.authorization, 'Bearer resend-test-token');
      if (request.method === 'POST') { state.email = { id: 'email-1', ...JSON.parse(body) }; result = { id: 'email-1' }; }
      else result = url.pathname === '/emails' ? { object: 'list', has_more: false, data: [state.email] } : state.email;
    } else {
      assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${sid}:twilio-test-token`).toString('base64')}`);
      if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) result = { incoming_phone_numbers: [{ sid: `PN${'3'.repeat(32)}`, phone_number: message.from, friendly_name: 'Demo phone' }], next_page_uri: null };
      else if (request.method === 'POST') {
        assert.match(request.headers['content-type'], /application\/x-www-form-urlencoded/);
        const form = new URLSearchParams(body);
        Object.assign(message, { body: form.get('Body'), from: form.get('From'), to: form.get('To') });
        result = message;
      } else result = url.pathname.endsWith('/Messages.json') ? { messages: [message], next_page_uri: null } : message;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { LINEAR_BASE_URL: base, LINEAR_TOKEN: 'linear-test-token', RESEND_BASE_URL: base, RESEND_TOKEN: 'resend-test-token', TWILIO_BASE_URL: base, TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: 'twilio-test-token' };
  return { sdk: createSecondarySdk(env), env, requests, close: () => new Promise(resolve => server.close(resolve)) };
}

test('official secondary SDK reads use local endpoints and expected authentication', async () => {
  const item = await fixture();
  try {
    const linear = await item.sdk.read('linear');
    assert.equal(linear.teams[0].name, 'Team one');
    assert.equal(linear.items[0].id, 'issue-1');
    const resend = await item.sdk.read('resend');
    assert.equal(resend.items[0].title, 'Test email');
    const twilio = await item.sdk.read('twilio');
    assert.equal(twilio.numbers[0].phone_number, '+15550000001');
    assert.equal(twilio.messages[0].sid, messageId);
    assert.ok(item.requests.some(request => /resend-node/.test(request.headers['user-agent'])));
    assert.ok(item.requests.some(request => /twilio-node/.test(request.headers['user-agent'])));
    assert.ok(item.requests.some(request => request.url.startsWith(`/2010-04-01/Accounts/${sid}/Messages.json`)));
  } finally { await item.close(); }
});

test('secondary SDK writes send official shapes and confirm fresh readback', async () => {
  const item = await fixture();
  try {
    const issue = await item.sdk.execute('linear.issue', { teamId: 'team-1', title: 'Changed title', description: 'Changed description' });
    assert.equal(issue.readback.title, 'Changed title');
    const email = await item.sdk.execute('resend.send', { from: 'from@demo.test', to: 'to@demo.test', subject: 'New subject', text: 'New text' });
    assert.equal(email.readback.text, 'New text');
    const sms = await item.sdk.execute('twilio.send', { from: '+15550000001', to: '+15550000002', text: 'New SMS' });
    assert.equal(sms.readback.body, 'New SMS');
    const resendWrite = item.requests.find(request => request.url === '/emails' && request.method === 'POST');
    assert.deepEqual(JSON.parse(resendWrite.body), { from: 'from@demo.test', to: ['to@demo.test'], subject: 'New subject', text: 'New text' });
    assert.equal(item.requests.filter(request => request.method === 'POST' && request.url.endsWith('/Messages.json')).length, 1);
  } finally { await item.close(); }
});

test('secondary SDK writes do not retry failures or follow redirects', async () => {
  const item = await fixture((request, response) => { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ errors: [{ message: 'Test failure' }], message: 'Test failure' })); });
  try {
    const actions = [
      ['linear.issue', { teamId: 'team-1', title: 'Failure', description: 'Test' }],
      ['resend.send', { from: 'from@demo.test', to: 'to@demo.test', subject: 'Failure', text: 'Test' }],
      ['twilio.send', { from: '+15550000001', to: '+15550000002', text: 'Failure' }],
    ];
    for (const [action, input] of actions) await assert.rejects(item.sdk.execute(action, input));
    assert.equal(item.requests.length, 3);
  } finally { await item.close(); }
  let escaped = 0;
  const destination = await fixture((request, response) => { escaped++; response.end('{}'); });
  const redirect = await fixture((request, response) => { response.writeHead(302, { location: destination.env.RESEND_BASE_URL }); response.end(); });
  try {
    for (const id of ['linear', 'resend', 'twilio']) await assert.rejects(redirect.sdk.read(id));
    assert.equal(escaped, 0);
  } finally { await redirect.close(); await destination.close(); }
});

test('secondary SDKs reject production endpoints and missing generated credentials', async () => {
  const sdk = createSecondarySdk({ LINEAR_BASE_URL: 'https://api.linear.app', LINEAR_TOKEN: 'test', RESEND_BASE_URL: 'https://api.resend.com', RESEND_TOKEN: 'test', TWILIO_BASE_URL: 'https://api.twilio.com', TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: 'test' });
  for (const id of ['linear', 'resend', 'twilio']) await assert.rejects(sdk.read(id), /local/);
  await assert.rejects(createSecondarySdk({}).read('resend'), /required/);
});

test('live official secondary SDK reads and local writes', { skip: process.env.ACCOUNT_DESK_SECONDARY_LIVE !== '1' }, async () => {
  const sdk = createSecondarySdk(process.env);
  const linear = await sdk.read('linear');
  const resend = await sdk.read('resend');
  const twilio = await sdk.read('twilio');
  assert.ok(linear.teams.length, 'The selected world must have a Linear team for the write test.');
  assert.ok(twilio.numbers.length, 'The selected world must have a Twilio sender number.');
  const suffix = randomUUID();
  const issue = await sdk.execute('linear.issue', { teamId: linear.teams[0].id, title: `Account Desk SDK check ${suffix}`, description: 'Local SDK readback test.' });
  assert.equal(issue.record.id, issue.readback.id);
  const from = resend.emails[0]?.from || process.env.IMAP_USERNAME;
  const to = (Array.isArray(resend.emails[0]?.to) ? resend.emails[0].to[0] : resend.emails[0]?.to) || process.env.IMAP_USERNAME;
  assert.ok(from && to, 'The world must supply an email sender and recipient.');
  const email = await sdk.execute('resend.send', { from, to, subject: `Account Desk SDK check ${suffix}`, text: 'Local email SDK readback test.' });
  assert.equal(email.record.id, email.readback.id);
  const sms = await sdk.execute('twilio.send', { from: twilio.numbers[0].phone_number, to: twilio.messages[0]?.to || twilio.numbers[0].phone_number, text: `Local SDK check ${suffix}` });
  assert.equal(sms.record.sid, sms.readback.sid);
});
