import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openState, resetState } from './state.mjs';
import { attachTimelineControl } from './timeline-control.mjs';
import { serveControl, requestControl, requestReset } from './control.mjs';

test('two socket clients share one clock and serialized reset; failed status remains readable', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'worldfixture-control-')), db = openState(':memory:');
  const world = { id: 'test.control', version: 'v1', clock: { anchor: '2030-01-01T00:00:00Z' }, timeline: [
    { id: 'optional', after_seconds: 1, kind: 'webhook', payload: {} },
    { id: 'fails', after_seconds: 10, kind: 'unknown', payload: {} },
  ] };
  const instance = { state: db, lock: {}, async restoreBaseline() { resetState(db); return { services: ['provider'], preserved: ['app'] }; } };
  const controller = attachTimelineControl(instance, world, { bindings: {}, now: () => 1800000000000, tickMs: 3600000 });
  await controller.initialize({ setup: true }); const server = await serveControl(instance, stateDir);
  t.after(async () => { await server.close(); await controller.stop(); db.close(); rmSync(stateDir, { recursive: true, force: true }); });
  await requestControl(stateDir, { action: 'start', duration: '0s' }); await requestControl(stateDir, { action: 'pause' });
  await Promise.all([requestControl(stateDir, { action: 'advance', duration: '1s' }), requestControl(stateDir, { action: 'advance', duration: '2s' })]);
  const [one, two] = await Promise.all([requestControl(stateDir, { action: 'status' }), requestControl(stateDir, { action: 'status' })]);
  assert.equal(one.clock.elapsed_ms, 3000); assert.deepEqual(one.clock, two.clock); assert.equal(one.timeline.skipped, 1);
  await assert.rejects(requestControl(stateDir, { action: 'advance', duration: '7s' }), error => error.code === 'timeline_delivery_failed' && error.status === 409 && error.result.mode === 'failed' && error.state_changed);
  assert.equal((await requestControl(stateDir, { action: 'status' })).mode, 'failed');
  const reset = await requestReset(stateDir); assert.deepEqual(reset.preserved, ['app']); assert.equal(reset.repeat.cycle, 2);
});
