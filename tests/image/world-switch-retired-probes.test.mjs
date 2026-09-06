import assert from 'node:assert/strict';
import test from 'node:test';
import { probeOldProviderCredentials, probeRetiredListeners, retiredListeners } from './world-switch-retired-probes.mjs';

test('retired aliases share one listener and retained aliases remain selected', () => {
  const before = { SITE_BASE_URL: 'http://127.0.0.1:1', NOTION_BASE_URL: 'http://127.0.0.1:2', NOTION_ADMIN_BASE_URL: 'http://127.0.0.1:2' };
  assert.deepEqual(retiredListeners(before, { NOTION_BASE_URL: before.NOTION_BASE_URL }), [{ binding: 'SITE_BASE_URL', base: before.SITE_BASE_URL }]);
});
test('only connection refusal proves a retired listener stopped', async () => {
  const input = { previous: { SITE_BASE_URL: 'http://127.0.0.1:1' }, current: {} };
  const refused = await probeRetiredListeners({ ...input, fetchImpl: async () => { throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(refused.checks[0].status, 'passed');
  for (const fetchImpl of [async () => Response.json({}, { status: 404 }), async () => { throw new Error('timeout'); }]) assert.equal((await probeRetiredListeners({ ...input, fetchImpl })).checks[0].status, 'failed');
});
test('old credentials require real authorization denial, not readiness or route failure', async () => {
  const input = { previous: { GOOGLE_TOKEN: 'old' }, current: { GOOGLE_BASE_URL: 'http://google.test', GOOGLE_TOKEN: 'new' } };
  let authorization;
  const good = await probeOldProviderCredentials({ ...input, fetchImpl: async (_url, options) => { authorization = options.headers.authorization; return Response.json({ error: 'unauthorized' }, { status: 401 }); } });
  assert.equal(authorization, 'Bearer old'); assert.equal(good.checks[0].status, 'passed');
  for (const status of [200, 404, 500]) assert.equal((await probeOldProviderCredentials({ ...input, fetchImpl: async () => Response.json({}, { status }) })).checks[0].status, 'failed');
});

test('container listener proof cannot accept a live socket or a timeout', async () => {
  const input = { previous: { SITE_BASE_URL: 'http://127.0.0.1:1234' }, current: {} };
  for (const [result, status] of [[{ connected: false, code: 'ECONNREFUSED' }, 'passed'], [{ connected: true }, 'failed'], [{ connected: false, code: 'TIMEOUT' }, 'failed']]) {
    const evidence = await probeRetiredListeners({ ...input, connectImpl: async row => { assert.equal(row.binding, 'SITE_BASE_URL'); return result; } });
    assert.equal(evidence.checks[0].status, status);
  }
});
