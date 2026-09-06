import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIONS, createProviders } from '../src/providers/index.mjs';
import { COVERAGE_BASELINE, PROVIDER_COVERAGE, WORKFLOW_COVERAGE } from '../src/providers/coverage.mjs';

test('coverage maps every app service and action without a production-parity claim', () => {
  assert.deepEqual(PROVIDER_COVERAGE.map(item => item.service).sort(), createProviders({}).catalog().map(item => item.id).sort());
  assert.deepEqual(PROVIDER_COVERAGE.flatMap(item => item.actionIds).sort(), ACTIONS.map(item => item.id).sort());
  assert.equal(COVERAGE_BASELINE.productionVerified, false);
  assert.equal(new Set(WORKFLOW_COVERAGE.map(item => item.workflow)).size, WORKFLOW_COVERAGE.length);
  for (const item of WORKFLOW_COVERAGE) assert.ok(['tested', 'untested', 'unsupported'].includes(item.status));
});

test('coverage app-local evidence references name real test files in standalone installs too', () => {
  const app = fileURLToPath(new URL('../', import.meta.url));
  for (const item of WORKFLOW_COVERAGE) for (const path of item.tests) {
    if (path.startsWith('examples/demo_app/')) assert.ok(existsSync(resolve(app, path.slice('examples/demo_app/'.length))), `${item.workflow}: ${path}`);
  }
});

test('coverage repository-only references name real files when the full checkout is present', t => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  if (!existsSync(resolve(root, 'emulators/emulate/service.json')) || !existsSync(resolve(root, 'runtime/src/cli.mjs'))) {
    t.skip('Standalone Account Desk install: repository-only provider contract references are checked in the full WorldFixture checkout.');
    return;
  }
  for (const item of WORKFLOW_COVERAGE) for (const path of item.tests) {
    if (!path.startsWith('examples/demo_app/')) assert.ok(existsSync(resolve(root, path)), `${item.workflow}: ${path}`);
  }
});
