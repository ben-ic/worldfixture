import assert from 'node:assert/strict';
import { createProviders, ACTIONS } from '../src/providers/index.mjs';
import { createStore } from '../src/db/store.mjs';
import { createWorkflowRunner } from '../src/workflows/runner.mjs';
import { createVerificationRunner } from '../src/verification/runner.mjs';
import { buildWritePlan } from '../src/verification/plans.mjs';

if (process.env.ACCOUNT_DESK_ISOLATED_PROVIDER_TEST !== '1') throw new Error('This test runs approved provider writes. Use a separate test project and set ACCOUNT_DESK_ISOLATED_PROVIDER_TEST=1.');
if (process.env.EXPECTED_WORLD_ID) assert.equal(process.env.WORLDFIXTURE_WORLD_ID, process.env.EXPECTED_WORLD_ID);
const world = `${process.env.WORLDFIXTURE_WORLD_ID}:${process.env.WORLDFIXTURE_WORLD_VERSION}`;
const providers = createProviders(process.env);
const catalog = providers.catalog();
const selected = catalog.filter(service => service.selected).map(service => service.id).sort();
if (process.env.EXPECT_ONLY) assert.deepEqual(selected, process.env.EXPECT_ONLY.split(',').sort());
let writes = 0;
const execute = providers.execute;
providers.execute = (...args) => { writes++; return execute(...args); };
const store = await createStore({ ...process.env, ACCOUNT_DESK_DATABASE: 'sqlite', ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
const workflows = createWorkflowRunner({ providers, store, actions: ACTIONS, world });
const verification = createVerificationRunner({ providers, store, workflows, world });
try {
  // Including unselected services proves that the runner reports them as
  // skipped rather than inventing provider data or selected/ready counts.
  const readRun = await verification.start(catalog.map(service => service.id));
  const reads = await verification.wait(readRun.id);
  for (const result of reads.results) {
    if (!selected.includes(result.service)) assert.equal(result.status, 'skipped');
    console.log(JSON.stringify({ world, workflow: `${result.service}.read`, status: result.status, count: result.count, reason: result.reason || result.error }));
  }
  const plan = await buildWritePlan({ providers, actions: ACTIONS, serviceIds: selected, env: process.env, world });
  assert.equal(writes, 0, 'Building the write plan must not execute provider writes.');
  for (const step of plan.steps) console.log(JSON.stringify({ world, workflow: step.action, phase: 'plan', ready: step.ready, reason: step.reason, kind: step.kind }));
  const started = await verification.startWrites(plan);
  const completed = await verification.wait(started.id);
  for (const result of completed.results) {
    const receipt = result.receipt ? await store.get('receipts', result.receipt) : null;
    console.log(JSON.stringify({ world, workflow: result.action, status: result.status, reason: result.error, receipt: result.receipt, providerErrors: receipt?.steps?.filter(step => step.error).map(step => step.error) }));
  }
  const beforeRepeat = writes;
  const repeated = await verification.startWrites(plan);
  assert.equal(repeated.id, completed.id);
  assert.equal(writes, beforeRepeat, 'A repeated approval must not send a second provider write.');
  console.log(JSON.stringify({ apiVersion: 'account-desk.dynamic-world-proof/v1', world, selected, readSummary: reads.summary, writeSummary: completed.summary, approvedWrites: writes, repeatedApprovalSentNoWrites: true, productionVerified: false }));
  process.exitCode = reads.status === 'failed' || completed.status === 'failed' ? 1 : 0;
} finally {
  await verification.close();
  await store.close();
}
