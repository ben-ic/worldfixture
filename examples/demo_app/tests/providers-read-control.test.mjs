import test from 'node:test';
import assert from 'node:assert/strict';
import { createDetailCache, createGoogleTransport } from '../src/providers/read-control.mjs';

test('poll detail cache is bounded, expires, and never replaces a fresh read', async () => {
  let clock = 1000, loads = 0;
  const read = createDetailCache({ ttlMs: 100, maxEntries: 2, now: () => clock });
  const load = async () => ({ revision: ++loads });
  assert.equal((await read('a', load, { allowCached: true })).cached, false);
  assert.equal((await read('a', load, { allowCached: true })).cached, true);
  assert.equal(loads, 1);
  assert.equal((await read('a', load)).data.revision, 2, 'Explicit verification must fetch fresh data.');
  await read('new-id', load, { allowCached: true });
  assert.equal(loads, 3, 'New message IDs are fetched immediately.');
  clock += 101;
  assert.equal((await read('a', load, { allowCached: true })).cached, false);
  await read('b', load, { allowCached: true });
  assert.equal((await read('new-id', load, { allowCached: true })).cached, false, 'Evicted IDs are loaded again.');
});

test('Google cooldown is shared across APIs, preserves reset time, and never retries a write', async () => {
  let clock = 100000, calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1
      ? new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200' } })
      : new Response('{}');
  };
  const request = createGoogleTransport('http://127.0.0.1:4444', { fetcher, now: () => clock });
  await assert.rejects(request('http://127.0.0.1:4444/gmail/v1/send', { method: 'POST' }), error => error.code === 'PROVIDER_RATE_LIMIT' && error.retryAt === '1970-01-01T00:03:20.000Z');
  await assert.rejects(request('http://127.0.0.1:4444/calendar/v3'), /Gmail, Calendar and Drive share this limit/);
  await assert.rejects(request('http://127.0.0.1:4444/drive/v3'), /No request was retried/);
  assert.equal(calls, 1);
  clock = 200001;
  assert.equal((await request('http://127.0.0.1:4444/drive/v3')).status, 200);
  assert.equal(calls, 2);
});

test('Google does not mislabel permission failures as rate limits or weaken the local URL guard', async () => {
  let calls = 0;
  const request = createGoogleTransport('http://127.0.0.1:4444', { fetcher: async () => { calls++; return new Response('{}', { status: 403 }); } });
  assert.equal((await request('http://127.0.0.1:4444/gmail/v1')).status, 403);
  await assert.rejects(request('https://gmail.googleapis.com/gmail/v1'), /Only generated local HTTP bindings/);
  assert.equal(calls, 1);
});
