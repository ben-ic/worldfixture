import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from '../src/server/app.mjs';
import { createStore } from '../src/db/store.mjs';

test('Slack scenario HTTP routes require approval and support stop and saved status', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let writes = 0;
  const app = createApplication({ store, connector: {}, actions: [], providers: {
    catalog: () => [{ id: 'slack', selected: true }],
    read: async () => ({ conversations: [{ id: 'dynamic-channel', name: 'Local channel', messages: [] }] }),
    execute: async () => { writes++; },
  } });
  try {
    const url = await app.listen(0);
    const call = (path, body) => fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const plan = await (await call('/api/slack-scenarios/preview', { channel: 'dynamic-channel' })).json();
    assert.equal(plan.steps.length, 3);
    assert.equal(writes, 0);
    assert.equal((await call('/api/slack-scenarios', { planId: plan.id })).status, 400);
    const started = await (await call('/api/slack-scenarios', { planId: plan.id, approved: true })).json();
    assert.equal(started.id, plan.id);
    await call(`/api/slack-scenarios/${started.id}/stop`, {});
    const saved = await (await call(`/api/slack-scenarios/${started.id}`)).json();
    assert.ok(['stopping', 'stopped'].includes(saved.status));
    const state = await (await call('/api/state')).json();
    assert.equal(state.slackScenarios.length, 1);
    assert.equal((await call('/api/slack-scenarios/missing')).status, 404);
    assert.equal(writes, 0);
  } finally { await app.close(); await store.close(); }
});

test('background polling permits cached details, but concurrent manual reads stay fresh', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let release;
  const calls = [];
  const app = createApplication({ store, connector: {}, actions: [], providers: {
    catalog: () => [{ id: 'gmail', selected: true }],
    async read(id, options = {}) {
      calls.push(options.purpose || 'fresh');
      if (options.purpose === 'poll') await new Promise(resolve => { release = resolve; });
      return { items: [{ id: options.purpose === 'poll' ? 'cached' : 'fresh' }] };
    },
  } });
  try {
    const url = await app.listen(0);
    const poll = app.refreshAll({ purpose: 'poll' });
    const manual = app.refreshAll();
    release();
    await Promise.all([poll, manual]);
    assert.deepEqual(calls, ['poll', 'fresh']);
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.data.gmail.items[0].id, 'fresh');
  } finally { await app.close(); await store.close(); }
});

test('scheduled polls wait for the provider reset time without hiding a failed connection', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let calls = 0;
  const retryAt = new Date(Date.now() + 60000).toISOString();
  const app = createApplication({ store, connector: {}, actions: [], providers: {
    catalog: () => [{ id: 'gmail', selected: true }],
    async read() { calls++; throw Object.assign(new Error('Local request limit reached.'), { retryAt }); },
  } });
  try {
    const url = await app.listen(0);
    await app.refreshAll({ purpose: 'poll' });
    await app.refreshAll({ purpose: 'poll' });
    assert.equal(calls, 1);
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.services[0].state, 'failed');
    assert.equal(state.services[0].retryAt, retryAt);
    await app.refreshAll();
    assert.equal(calls, 2, 'An explicit refresh still checks the provider.');
  } finally { await app.close(); await store.close(); }
});

test('app HTTP API has real loading/error states, safe JSON, drafts and approval receipts', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let writes = 0;
  const app = createApplication({ store, connector: { handle: async () => ({ status: 404, body: {} }) },
    actions: [{ id: 'mail.send', service: 'mail', label: 'Send', fields: [{ name: 'text', required: true }] }],
    providers: {
      catalog: () => [{ id: 'mail', selected: true, name: 'Local Mail' }, { id: 'down', selected: true }],
      async read(id) { if (id === 'down') throw new Error('Local test service is unavailable'); return { items: [{ id: '1', modseq: 9n }] }; },
      async execute() { writes++; return { record: { id: 'new' }, readback: { id: 'new' } }; },
    },
  });
  try {
    const url = await app.listen(0);
    const call = (path, input, headers = {}) => fetch(url + path, input ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) } : {});
    await app.refreshAll();
    const state = await (await call('/api/state')).json();
    assert.equal(state.data.mail.items[0].modseq, '9');
    assert.equal(state.services.find(item => item.id === 'down').state, 'failed');
    assert.equal((await call('/api/drafts', { text: 'local draft' })).status, 200);
    assert.equal((await (await call('/api/drafts')).json()).drafts.length, 1);
    const change = { action: 'mail.send', input: { text: 'approved' }, idempotencyKey: 'test-server-approval' };
    assert.equal((await call('/api/actions', change, { origin: 'https://external.test' })).status, 403);
    assert.equal(writes, 0);
    assert.equal((await (await call('/api/actions', change)).json()).status, 'passed');
    await call('/api/actions', change);
    assert.equal(writes, 1);
    assert.equal((await call('/api/connector/seed', { approved: true })).status, 400);
    assert.equal((await call('/api/unknown')).status, 404);
    const denied = await fetch(url + '/oauth/google/callback?state=invalid&code=not-a-real-code', { redirect: 'manual' });
    assert.equal(denied.status, 303);
    const destination = new URL(denied.headers.get('location'), url);
    assert.equal(destination.origin, url);
    assert.ok(destination.searchParams.get('oauth_error'));
  } finally { await app.close(); await store.close(); }
});
