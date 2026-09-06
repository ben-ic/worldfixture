import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, ACTIONS } from '../src/providers/index.mjs';
import { localUrl, localFetch, hostPort, required, headerValue, pages, assertReadback, serializableData } from '../src/providers/safety.mjs';

test('protocol metadata is JSON-safe without losing 64-bit counter precision', () => {
  const message = { uid: 42, modseq: 18446744073709551615n, envelope: { date: new Date('2026-09-05T00:00:00Z') } };
  const result = serializableData({ items: [message], messages: [message] });
  assert.equal(result.items[0].modseq, '18446744073709551615');
  assert.equal(result.items[0].envelope.date, '2026-09-05T00:00:00.000Z');
  assert.deepEqual(result.items, result.messages);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(typeof message.modseq, 'bigint', 'Do not mutate the original SDK object.');
});

test('provider requests accept only explicit loopback URLs and cannot redirect', async () => {
  for (const url of ['https://api.slack.com', 'http://127.0.0.1.evil.test', 'file:///tmp/a', 'http://user:pass@localhost:8080']) assert.throws(() => localUrl(url));
  assert.equal(localUrl('http://127.0.0.1:1234').port, '1234');
  let seen;
  const request = localFetch('http://localhost:1234', async (_url, options) => { seen = options; return { ok: true }; });
  await request('http://localhost:1234/api');
  assert.equal(seen.redirect, 'error');
  await assert.rejects(request('http://localhost:4321/api'));
  assert.deepEqual(hostPort('127.0.0.1:1143'), { host: '127.0.0.1', port: 1143 });
});

test('no services are invented when bindings are absent', async () => {
  const providers = createProviders({});
  assert.ok(providers.catalog().every(item => !item.selected));
  await assert.rejects(providers.read('slack'), /not selected/);
  await assert.rejects(providers.execute('unsupported', {}), /not supported/);
});

test('catalog never returns binding credentials and reports invalid bindings', () => {
  const entries = createProviders({ SLACK_BASE_URL: 'https://slack.com', SLACK_TOKEN: 'private-token-must-not-leak' }).catalog();
  assert.equal(entries[0].selected, true);
  assert.equal(entries[0].baseUrl, null);
  assert.ok(entries[0].bindingError);
  assert.ok(!JSON.stringify(entries).includes('private-token-must-not-leak'));
});

test('action forms declare required inputs and validate before SDK loading', async () => {
  assert.equal(new Set(ACTIONS.map(item => item.id)).size, ACTIONS.length);
  const providers = createProviders({});
  for (const action of ACTIONS) {
    assert.ok(action.fields.length);
    await assert.rejects(providers.execute(action.id, {}), /required/);
  }
  assert.throws(() => required({ text: '' }, 'text'));
  assert.throws(() => headerValue({ to: 'one@test\r\nBcc: other@test' }, 'to'));
});

test('pagination follows cursors and rejects cycles or safety-limit truncation', async () => {
  const result = await pages(async cursor => cursor ? { rows: [2] } : { rows: [1], next: 'a' }, value => value.rows, value => value.next);
  assert.deepEqual(result, [1, 2]);
  await assert.rejects(pages(async () => ({ rows: [], next: 'a' }), value => value.rows, value => value.next), /repeated/);
  await assert.rejects(pages(async () => ({ rows: [], next: 'a' }), value => value.rows, value => value.next, 1), /safety limit/);
});

test('unconfirmed readback is not reported as successful', () => {
  assert.throws(() => assertReadback(false, 'send'), error => error.code === 'READBACK_UNCONFIRMED');
});
