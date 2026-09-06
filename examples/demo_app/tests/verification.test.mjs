import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWritePlan } from '../src/verification/plans.mjs';
import { createVerificationRunner } from '../src/verification/runner.mjs';
import { createWorkflowRunner } from '../src/workflows/runner.mjs';
import { createStore } from '../src/db/store.mjs';
import { createApplication } from '../src/server/app.mjs';
import { runSummary } from '../src/verification/summary.mjs';

const actions = [{ id: 'slack.send', service: 'slack', name: 'Send message', fields: [{ name: 'channel' }, { name: 'text' }] }];
const world = { id: 'different-world', version: 'v7' };
const providers = {
  catalog: () => [{ id: 'slack', selected: true }, { id: 'apple', selected: true }],
  async read() { return { items: [], conversations: [{ id: 'old-channel', latest: '1' }, { id: 'new-dm', is_im: true, latest: '2' }] }; },
};
test('live run summaries preserve measured progress without copying provider evidence', () => {
  const source = { id: 'run', status: 'passed', results: [{ service: 'mail', status: 'passed', durationMs: 10, actual: 'Read one record', evidence: { large: 'private response evidence' } }] };
  const summary = runSummary(source);
  assert.equal(summary.summaryOnly, true);
  assert.equal(summary.results[0].durationMs, 10);
  assert.equal(summary.results[0].evidence, undefined);
  assert.ok(source.results[0].evidence);
});
test('write plan uses fresh dynamic records without sending any action', async () => {
  const plan = await buildWritePlan({ providers, actions, world, serviceIds: ['slack', 'apple'], now: 1000000 });
  assert.equal(plan.steps[0].input.channel, 'new-dm');
  assert.equal(plan.steps[0].ready, true);
  assert.deepEqual(plan.readOnlyServices, ['apple']);
  assert.equal(Date.parse(plan.expiresAt), 1900000);
  assert.deepEqual(plan.world, world);
});
test('write plan records missing prerequisites and unsupported input builders', async () => {
  const plan = await buildWritePlan({ providers: { ...providers, async read() { throw new Error('Service down'); } }, actions, world });
  assert.equal(plan.steps[0].ready, false);
  assert.match(plan.steps[0].reason, /Service down/);
  const unknown = await buildWritePlan({ providers, actions: [{ ...actions[0], id: 'slack.new-operation' }], world });
  assert.equal(unknown.steps[0].ready, false);
  await assert.rejects(buildWritePlan({ providers, actions, world, serviceIds: ['apple'] }), /No write checks/);
});
test('write verification uses durable workflows, failed prerequisites do not pass, approval is not replayed', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let writes = 0;
  const live = { ...providers, async execute() { writes++; return { readback: { id: 'actual-record' } }; } };
  try {
    const workflows = createWorkflowRunner({ providers: live, store, actions });
    const runner = createVerificationRunner({ providers: live, store, actions, world, workflows });
    const plan = await buildWritePlan({ providers: live, actions, world });
    plan.steps.push({ id: 'missing-prerequisite', service: 'slack', action: 'slack.send', input: {}, ready: false, reason: 'Missing channel' });
    const started = await runner.startWrites(plan);
    const completed = await runner.wait(started.id);
    assert.equal(completed.status, 'failed');
    assert.deepEqual(completed.summary, { passed: 1, failed: 1, skipped: 0 });
    assert.equal(completed.results[0].evidence.steps[0].result.readback.id, 'actual-record');
    assert.equal(writes, 1);
    await runner.startWrites(plan);
    assert.equal(writes, 1);
  } finally { await store.close(); }
});
test('HTTP write verification requires a prepared plan and explicit approval', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let writes = 0;
  const app = createApplication({ providers: { ...providers, async execute() { writes++; return { readback: { id: 'saved' } }; } }, store, actions, connector: { handle: async () => null } });
  try {
    const origin = await app.listen(0);
    const post = async (path, body) => {
      const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const prepared = await post('/api/verify/plan', { services: ['slack'] });
    assert.equal(prepared.status, 200); assert.equal(writes, 0);
    assert.equal((await post('/api/verify', { planId: prepared.body.id })).status, 400);
    assert.equal((await post('/api/verify', { planId: 'unknown', approved: true })).status, 400);
    const [a, b] = await Promise.all([post('/api/verify', { planId: prepared.body.id, approved: true }), post('/api/verify', { planId: prepared.body.id, approved: true })]);
    assert.equal(a.status, 202); assert.equal(b.body.id, a.body.id);
    const run = await app.verification.wait(a.body.id);
    assert.equal(run.status, 'passed'); assert.equal(writes, 1);
    const repeated = await post('/api/verify', { planId: prepared.body.id, approved: true });
    assert.equal(repeated.body.status, 'passed');
    assert.deepEqual(repeated.body.summary, { passed: 1, failed: 0, skipped: 0 });
    assert.equal(writes, 1);
    const state = await (await fetch(origin + '/api/state')).json();
    assert.equal(state.runs.find(item => item.id === run.id).summaryOnly, true);
    const full = await (await fetch(origin + '/api/runs/' + run.id)).json();
    assert.ok(full.results[0].evidence);
  } finally { await app.close(); await store.close(); }
});
test('read verification treats unexpected probe behavior as failure', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  try {
    const runner = createVerificationRunner({ providers: { ...providers, async read() { return { items: [], checks: [{ id: 'flap', status: 'failed', expected: '200,503', actual: '200,200' }] }; } }, world, store });
    const run = await runner.wait((await runner.start(['slack'])).id);
    assert.equal(run.status, 'failed'); assert.match(run.results[0].error, /flap: expected 200,503; got 200,200/);
  } finally { await store.close(); }
});

test('Stop allows the current read to finish and prevents the next check', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let release;
  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  const called = [];
  const runner = createVerificationRunner({ world, store, providers: { ...providers, async read(id) { called.push(id); await new Promise(resolve => { release = resolve; signalEntered(); }); return { items: [] }; } } });
  try {
    const started = await runner.start(['slack', 'apple']);
    await entered;
    runner.stop(started.id);
    release();
    const run = await runner.wait(started.id);
    assert.equal(run.status, 'stopped');
    assert.deepEqual(called, ['slack']);
    assert.deepEqual(run.results.map(item => item.status), ['passed', 'skipped']);
  } finally { release?.(); await runner.close(); await store.close(); }
});
