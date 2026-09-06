import { createProviders, ACTIONS } from '../providers/index.mjs';
import { createStore } from '../db/store.mjs';
import { loadEnvironment } from '../server/bindings.mjs';
import { makeRedactor } from '../server/security.mjs';
import { createVerificationRunner } from './runner.mjs';
import { createWorkflowRunner } from '../workflows/runner.mjs';
import { buildWritePlan } from './plans.mjs';

const env = await loadEnvironment();
const store = await createStore(env);
try {
  const providers = createProviders(env);
  const world = { id: env.WORLDFIXTURE_WORLD_ID ?? 'unbound', version: env.WORLDFIXTURE_WORLD_VERSION ?? 'unknown' };
  const redact = makeRedactor(env);
  const workflows = createWorkflowRunner({ providers, store, actions: ACTIONS, world, redact });
  const runner = createVerificationRunner({ providers, store, world, workflows, redact });
  const args = process.argv.slice(2);
  const writes = args.includes('--writes');
  const ids = args.filter(arg => arg !== '--writes');
  if (writes && env.ACCOUNT_DESK_ALLOW_TEST_WRITES !== '1') throw new Error('Write checks create local test records. Set ACCOUNT_DESK_ALLOW_TEST_WRITES=1 only for an isolated test world.');
  const plan = writes ? await buildWritePlan({ providers, actions: ACTIONS, serviceIds: ids.length ? ids : undefined, env, world }) : null;
  const started = writes ? await runner.startWrites(plan) : await runner.start(ids.length ? ids : undefined);
  const run = await runner.wait(started.id);
  console.log(JSON.stringify(run, null, 2));
  process.exitCode = run.status === 'passed' && run.results.some(item => item.status === 'passed') ? 0 : 1;
} catch (error) {
  console.error(makeRedactor(env)(error.message));
  process.exitCode = 1;
} finally { await store.close(); }
