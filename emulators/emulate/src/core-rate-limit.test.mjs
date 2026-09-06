import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from '@emulators/core';
import { patchCoreSource, CORE_VERSION } from '../scripts/patch-core-rate-limit.mjs';

test('core patch is exact, idempotent and refuses dependency/source drift', () => {
  const installed = readFileSync(new URL('../node_modules/@emulators/core/dist/index.js', import.meta.url), 'utf8');
  const patched = patchCoreSource(installed, CORE_VERSION);
  assert.equal(patchCoreSource(patched, CORE_VERSION), patched);
  const original = patched
    .replace('counter = { remaining: 1e5, resetAt: now + 3600 };', 'counter = { remaining: 5e3, resetAt: now + 3600 };')
    .replace('c.header("X-RateLimit-Limit", "100000");', 'c.header("X-RateLimit-Limit", "5000");');
  assert.equal(patchCoreSource(original, CORE_VERSION), patched);
  assert.throws(() => patchCoreSource(original, '0.11.0'), /requires/);
  assert.throws(() => patchCoreSource(`${original}\n`, CORE_VERSION), /reviewed bytes/);
  assert.throws(() => patchCoreSource(original.replace('now + 3600', 'now + 60'), CORE_VERSION), /reviewed bytes/);
});

test('real core middleware uses the 100K per-token hourly budget and retains its exact cutoff', { timeout: 180000 }, async () => {
  const realNow = Date.now;
  let now = 1800000000000;
  Date.now = () => now;
  try {
    const { app } = createServer({ name: 'rate-limit-proof', register(app) { app.get('/proof', c => c.get('authUser') ? c.json({ ok: true }) : c.json({ message: 'Unauthorized' }, 401)); } }, {
      tokens: { first: { login: 'first', id: 1 }, second: { login: 'second', id: 2 } },
    });
    const request = token => app.request('/proof', { headers: { Authorization: `Bearer ${token}` } });
    let result = await request('first');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-ratelimit-limit'), '100000');
    assert.equal(result.headers.get('x-ratelimit-remaining'), '99999');
    const resetAt = Number(result.headers.get('x-ratelimit-reset'));
    assert.equal(resetAt, now / 1000 + 3600);
    for (let count = 2; count <= 99999; count++) {
      result = await request('first');
      if (result.status !== 200) assert.fail(`Unexpected rejection at request ${count}`);
    }
    assert.equal(result.headers.get('x-ratelimit-remaining'), '1');
    result = await request('first');
    assert.equal(result.status, 403, 'Upstream decrements before checking: request 100000 is rejected.');
    assert.equal(result.headers.get('x-ratelimit-remaining'), '0');
    assert.equal((await request('first')).status, 403, 'Request 100001 stays blocked.');
    assert.equal((await request('second')).status, 200, 'Another token has its own bucket.');
    assert.equal((await request('unknown')).status, 401, 'The patch does not grant authentication.');
    now = resetAt * 1000;
    result = await request('first');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-ratelimit-remaining'), '99999');
  } finally { Date.now = realNow; }
});
