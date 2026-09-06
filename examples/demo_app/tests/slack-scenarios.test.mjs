import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackScenarios } from '../src/server/slack-scenarios.mjs';
import { createWorkflowRunner } from '../src/workflows/runner.mjs';
import { createStore } from '../src/db/store.mjs';

const action = { id: 'slack.send', service: 'slack', label: 'Send', fields: [{ name: 'channel', required: true }, { name: 'text', required: true }] };
const world = { id: 'retail-dynamic-proof', version: 'v9' };
const channel = 'C_WORLD_GENERATED_9';
async function fixture(t, options = {}) {
  const store = await createStore({ ACCOUNT_DESK_DATABASE: 'sqlite', ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let writes = 0, reads = 0;
  const received = [], updates = [];
  const providers = {
    catalog: () => [{ id: 'slack', selected: options.selected !== false }],
    async read(id, settings) {
      assert.equal(id, 'slack');
      assert.equal(settings, undefined, 'Preview uses a fresh read, not poll cache.');
      reads++;
      return { conversations: [{ id: channel, name: 'delivery-review', messages: Array.from({ length: 35 }, (_, index) => ({ ts: `future-${index}` })) }] };
    },
    async execute(id, input) {
      assert.equal(id, 'slack.send');
      assert.equal(input.channel, channel);
      writes++;
      if (options.beforeWrite) await options.beforeWrite(writes);
      if (writes === options.failAt) throw new Error('Connection ended after send');
      const message = { ts: `${writes}.01`, text: input.text, user: 'U_AUTHENTICATED_LOCAL' };
      received.push(message);
      return { record: { channel, ts: message.ts }, readback: { messages: [{ ts: 'future', text: 'Unrelated old message' }, message] } };
    },
  };
  const workflows = createWorkflowRunner({ providers, store, actions: [action], world });
  const scenarios = createSlackScenarios({ providers, store, workflows, world, intervalMs: 1, onUpdate: run => updates.push(run), onMessage: options.onMessage });
  t.after(async () => { await scenarios.close(); await store.close(); });
  return { scenarios, store, providers, workflows, received, updates, get writes() { return writes; }, get reads() { return reads; } };
}

test('preview is read-only, uses dynamic IDs and exact visible texts; approval sends real workflow receipts once', async t => {
  const f = await fixture(t);
  const plan = await f.scenarios.preview(channel);
  assert.equal(f.reads, 1);
  assert.equal(f.writes, 0);
  assert.equal(plan.channel, channel);
  assert.equal(plan.name, 'delivery-review');
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.baselineMessageTs.length, 30);
  assert.equal(plan.sender.mode, 'authenticated-sdk-token');
  for (const step of plan.steps) {
    assert.deepEqual(Object.keys(step.input).sort(), ['channel', 'text']);
    assert.match(step.input.text, /^\[Account Desk local scenario [123]\/3\]/);
  }
  await assert.rejects(f.scenarios.start({ planId: plan.id }), /approve/);
  await assert.rejects(f.scenarios.start({ planId: plan.id, approved: 'true' }), /approve/);
  assert.equal(f.writes, 0);
  const [first, duplicate] = await Promise.all([f.scenarios.start({ planId: plan.id, approved: true }), f.scenarios.start({ planId: plan.id, approved: true })]);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.status, 'running');
  const completed = await f.scenarios.wait(first.id);
  assert.equal(completed.status, 'passed');
  assert.equal(completed.sent, 3);
  assert.deepEqual(f.received.map(message => message.text), plan.steps.map(step => step.input.text));
  for (const step of completed.steps) {
    assert.equal(step.status, 'passed');
    assert.equal(step.result.user, 'U_AUTHENTICATED_LOCAL');
    assert.equal(step.result.channel, channel);
    assert.equal(step.result.text, step.input.text);
    assert.equal(step.result.messages, undefined, 'Do not copy unrelated provider history into scenario output.');
    assert.equal((await f.store.get('receipts', step.receiptId)).status, 'passed');
  }
  await f.scenarios.start({ planId: plan.id, approved: true });
  assert.equal(f.writes, 3);
});

test('unknown or unselected conversations and expired plans never send', async t => {
  const f = await fixture(t);
  await assert.rejects(f.scenarios.preview('C_OTHER_WORLD'), /current world/);
  const plan = await f.scenarios.preview(channel);
  plan.expiresAt = '2000-01-01T00:00:00Z';
  await f.store.put('slackScenarioPlans', plan.id, plan);
  await assert.rejects(f.scenarios.start({ planId: plan.id, approved: true }), /expired/);
  await assert.rejects(f.scenarios.start({ planId: 'missing', approved: true }), /not available/);
  assert.equal(f.writes, 0);
  const absent = await fixture(t, { selected: false });
  await assert.rejects(absent.scenarios.preview(channel), /not selected/);
  assert.equal(absent.reads, 0);
});

test('an uncertain send stops later messages and is not repeated on another approval', async t => {
  const f = await fixture(t, { failAt: 2 });
  const plan = await f.scenarios.preview(channel);
  const started = await f.scenarios.start({ planId: plan.id, approved: true });
  const finished = await f.scenarios.wait(started.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.sent, 1);
  assert.deepEqual(finished.steps.map(step => step.status), ['passed', 'uncertain', 'pending']);
  await f.scenarios.start({ planId: plan.id, approved: true });
  assert.equal(f.writes, 2);
});

test('stop before the first timer sends nothing and never displays preview text as received', async t => {
  const f = await fixture(t);
  const plan = await f.scenarios.preview(channel);
  const started = await f.scenarios.start({ planId: plan.id, approved: true });
  await f.scenarios.stop(started.id);
  const final = await f.scenarios.wait(started.id);
  assert.equal(final.status, 'stopped');
  assert.equal(final.sent, 0);
  assert.ok(final.steps.every(step => !step.result));
  assert.equal(f.writes, 0);
});

test('stop during a send finishes that send and prevents later messages; close waits for it', async t => {
  let release, sending;
  const sent = new Promise(resolve => { sending = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeWrite: async () => { sending(); await gate; } });
  const plan = await f.scenarios.preview(channel);
  const started = await f.scenarios.start({ planId: plan.id, approved: true });
  await sent;
  assert.equal((await f.scenarios.stop(started.id)).status, 'stopping');
  let closed = false;
  const closing = f.scenarios.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  const final = await f.scenarios.wait(started.id);
  assert.equal(final.status, 'stopped');
  assert.equal(final.sent, 1);
  assert.equal(f.writes, 1);
});

test('restart marks unfinished runs interrupted without replaying any message', async t => {
  const f = await fixture(t);
  const plan = await f.scenarios.preview(channel);
  const started = await f.scenarios.start({ planId: plan.id, approved: true });
  const completed = await f.scenarios.wait(started.id);
  completed.status = 'running';
  await f.store.put('slackScenarios', completed.id, completed);
  const restarted = createSlackScenarios({ providers: f.providers, store: f.store, workflows: f.workflows, world, intervalMs: 1 });
  await restarted.restore();
  assert.equal((await restarted.list())[0].status, 'interrupted');
  assert.equal((await restarted.start({ planId: plan.id, approved: true })).status, 'interrupted');
  assert.equal(f.writes, 3);
  await restarted.close();
});

test('only one scenario can start at a time, including concurrent different approvals', async t => {
  const f = await fixture(t);
  const first = await f.scenarios.preview(channel), second = await f.scenarios.preview(channel);
  const results = await Promise.allSettled([f.scenarios.start({ planId: first.id, approved: true }), f.scenarios.start({ planId: second.id, approved: true })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /current Slack scenario/);
  await f.scenarios.close();
});
