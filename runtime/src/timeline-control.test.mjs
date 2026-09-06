import assert from 'node:assert/strict';
import test from 'node:test';
import { attachTimelineControl } from './timeline-control.mjs';
import { parseDuration, advanceClock } from './clock.mjs';
import { openState, resetState } from './state.mjs';
import { deliverArrival } from './arrivals.mjs';
const T0 = 1800000000000;
function operation(id, seconds = 0, actor = 'person.one') {
  return { id, after_seconds: seconds, kind: 'domain-operation', payload: { api_version: 'worldfixture.runtime-operation/v1',
    type: 'social.post.publish.v1', actor_id: actor, record: { id: `post.${id}`, author_id: actor, body: id } } };
}
function fixture(t, arrivals = [operation('first', 1)], overrides = {}) {
  const db = openState(':memory:'), writes = [], world = { id: 'test.timeline', version: 'v1', clock: { anchor: '2030-01-01T00:00:00Z' },
    people: [{ id: 'person.one', email: 'one@world.test' }], timeline: arrivals };
  const instance = { state: db, lock: {}, restores: 0, async restoreBaseline() { this.restores++; resetState(db); return { services: ['domain'], preserved: ['application'] }; } };
  const context = { world, tickMs: 3600000, now: () => T0, rules: [], bindings: { DOMAIN_BASE_URL: 'http://domain.test', DOMAIN_TOKEN: 'synthetic' },
    fetchImpl: async (_url, options) => { const { record, actor_id } = JSON.parse(options.body); writes.push(record.id); return Response.json({ ok: true, record,
      event: { id: `provider-${writes.length}`, seq: writes.length, type: 'domain.record.created.v1', collection: 'social.posts', record_id: record.id, actor_id, world, before: null, after: record } }); }, ...overrides };
  const control = attachTimelineControl(instance, world, context);
  t.after(async () => { await control.stop(); if (db.isOpen) db.close(); });
  return { control, db, instance, world, writes, context };
}
test('duration parsing rejects invalid, fractional millisecond, and overflowing values', () => {
  assert.equal(parseDuration('90s'), 90000); assert.equal(parseDuration('1w'), 604800000); assert.equal(parseDuration('1.5s'), 1500);
  for (const bad of ['-1s', '1', 'Infinitys', '1e3s', '0.1ms', '999999999999999w', '', null]) assert.throws(() => parseDuration(bad), error => error.status === 400);
});
test('the active controller pauses lifecycle ticks, resumes, and stops delivery', async t => {
  const { control, instance, db, writes } = fixture(t, [operation('first', 1), operation('second', 2), operation('third', 3)]);
  await control.initialize();
  advanceClock(db, 1000, { now: T0 }); await control.tick();
  assert.deepEqual(writes, ['post.first']);
  await instance.scheduler.suspend();
  advanceClock(db, 1000, { now: T0 }); await control.tick();
  assert.deepEqual(writes, ['post.first']);
  instance.scheduler.resume(); await control.tick();
  assert.deepEqual(writes, ['post.first', 'post.second']);
  await control.stop();
  advanceClock(db, 1000, { now: T0 }); await control.tick();
  assert.deepEqual(writes, ['post.first', 'post.second']);
});
test('setup leaves zero pending; start includes the boundary and advance is forward only', async t => {
  const { control, writes } = fixture(t, [operation('zero'), operation('edge', 5), operation('future', 10)]);
  assert.equal(control.status().mode, 'initializing');
  await control.initialize({ setup: true }); assert.deepEqual(writes, []); assert.equal(control.status().mode, 'setup');
  await assert.rejects(control.command({ action: 'advance', duration: '1s' }), /Start the timeline/);
  const result = await control.command({ action: 'start', duration: '5s' });
  assert.deepEqual(writes, ['post.zero', 'post.edge']); assert.equal(result.clock.elapsed_ms, 5000);
  await control.command({ action: 'pause' }); await control.command({ action: 'advance', duration: '5s' });
  assert.equal(control.status().clock.running, false); assert.deepEqual(writes, ['post.zero', 'post.edge', 'post.future']);
  await control.command({ action: 'advance', duration: '1w' }); assert.equal(writes.length, 3);
  await assert.rejects(control.command({ action: 'start', duration: '0s' }), /only be selected during setup/);
});
test('advance drains new causal effects at cause time plus delay and retains the cause', async t => {
  const rules = [{ api_version: 'worldfixture.causal-rule/v1', id: 'rule.follow', when: 'domain.record.created.v1', emit: [{ type: 'social.post.publish.v1', after: '5s',
    with: { actor_id: { value: 'person.one' }, record: { value: { id: 'post.effect', author_id: 'person.one', body: 'Effect' } } } }] }];
  const { control, writes, db } = fixture(t, [operation('first', 2), operation('later', 20)], { rules });
  await control.initialize({ setup: true }); await control.command({ action: 'start', duration: '10s' });
  assert.deepEqual(writes, ['post.first', 'post.effect']);
  const effect = control.timeline().data.find(row => row.type === 'world.causal.effect.v1');
  assert.equal(effect.due_at, 7000); assert.equal(effect.status, 'delivered'); assert.match(effect.caused_by, /^evt_/);
  assert.equal(db.prepare('SELECT occurred_at FROM events WHERE id=?').get(effect.event_id).occurred_at, '2030-01-01T00:00:07.000Z');
});
test('concurrent advances and reset never overlap provider calls or duplicate arrivals', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { control, context, instance, db } = fixture(t);
  const native = context.fetchImpl; context.fetchImpl = async (...args) => { entered(); await gate; return native(...args); };
  await control.initialize({ setup: true });
  const start = control.command({ action: 'start', duration: '1s' }); await started;
  assert.equal(control.status().timeline.in_flight, 1);
  const advance = control.command({ action: 'advance', duration: '1s' }), reset = control.command({ action: 'reset' });
  assert.equal(instance.restores, 0); release(); await Promise.all([start, advance, reset]);
  assert.equal(instance.restores, 1); assert.equal(control.status().repeat.cycle, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
});
test('failed and skipped deliveries remain distinct; failure pauses and disables repeat', async t => {
  const { control } = fixture(t, [{ id: 'optional', after_seconds: 0, kind: 'webhook', payload: {} }, operation('bad', 1)], {
    fetchImpl: async () => Response.json({ ok: false, error: { message: 'Rejected record' } }, { status: 400 }) });
  await assert.rejects(control.initialize({ startAtMs: 1000, repeat: true }), error => error.state_changed && error.result.mode === 'failed');
  const state = control.status(); assert.equal(state.timeline.skipped, 1); assert.equal(state.timeline.failed, 1); assert.equal(state.timeline.delivered, 0);
  assert.equal(state.clock.running, false); assert.equal(state.repeat.enabled, false);
  assert.ok(control.timeline().data.every(row => row.delivered_at === null));
});
test('append cursor reaches late additions and repeat refuses zero-duration arcs', async t => {
  const { control, db } = fixture(t, [operation('a'), operation('b', 20)]); await control.initialize({ setup: true });
  const first = control.timeline({ limit: 1 }); assert.equal(first.has_more, true);
  const second = control.timeline({ after: first.next_cursor, limit: 1 });
  db.prepare('INSERT INTO scheduled_events(id,due_at,type,payload) VALUES(?,?,?,?)').run('late-added', 1, 'webhook', '{}');
  assert.equal(control.timeline({ after: second.next_cursor }).data[0].id, 'late-added');
  assert.equal(control.timeline({ fromMs: 0, toMs: 1 }).data.length, 2);
  const zero = fixture(t, [operation('zero')]); await assert.rejects(zero.control.initialize({ repeat: true }), /positive duration/);
});
test('legacy repeat loops without restoring; explicit reset remains separate', async t => {
  const { control, instance, db } = fixture(t); await control.initialize({ repeat: true });
  await control.command({ action: 'advance', duration: '1s' });
  await control.tick(); assert.equal(instance.restores, 0); assert.equal(control.status().repeat.cycle, 2);
  assert.equal(control.status().timeline.pending, 1); assert.equal(control.status().timeline.delivered, 1);
  assert.equal(control.status().loop.enabled, true);
  await control.command({ action: 'reset' }); assert.equal(instance.restores, 1);
  assert.equal(control.status().clock.elapsed_ms, 0); assert.equal(control.status().timeline.delivered, 0);
  instance.restoreBaseline = async () => { throw new Error('Restore refused'); };
  await assert.rejects(control.command({ action: 'reset' }), /Restore refused/);
  assert.equal(control.status().mode, 'failed'); assert.equal(control.status().loop.enabled, false);
});
test('connector envelope survives failed retry and provider reset; accepted receipts prevent replay', async t => {
  const { control, db, world } = fixture(t, []); await control.initialize({ setup: true });
  const sent = []; let fail = true;
  const context = { world, bindings: {}, commandId: 'cmd_connector', now: () => T0, applicationConnector: () => ({ baseUrl: 'http://app.test', token: 'synthetic' }),
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/.well-known/worldfixture')) return Response.json({ api_version: 'worldfixture.connector/v1', application: { id: 'app', name: 'App' }, capabilities: { event: true }, endpoints: { event: '/events' } });
      sent.push(JSON.parse(options.body)); if (fail) throw new Error('Connection lost');
      return Response.json({ api_version: 'worldfixture.connector-receipt/v1', status: 'applied', request_id: 'receipt' });
    } };
  const arrival = { id: 'arrival.connector', kind: 'application-event', payload: { kind: 'review.created', data: { id: 'review.one' } } };
  await assert.rejects(deliverArrival(db, arrival, context), /Connection lost/);
  advanceClock(db, 10000, { now: T0 }); fail = false; await deliverArrival(db, arrival, context);
  assert.equal(sent.length, 2); assert.equal(sent[0].event_id, sent[1].event_id); assert.equal(sent[0].occurred_at, sent[1].occurred_at);
  resetState(db); await deliverArrival(db, arrival, context); assert.equal(sent.length, 2);
  await assert.rejects(deliverArrival(db, { ...arrival, payload: { ...arrival.payload, data: { id: 'changed' } } }, context), /payload changed/);
  await deliverArrival(db, arrival, { ...context, world: { ...world, id: 'other.world' } });
  assert.equal(sent.length, 3); assert.notEqual(sent[1].event_id, sent[2].event_id);
});

test('interrupted claims become uncertain on recovery and cannot be silently retried', async t => {
  const { control, instance, world, db } = fixture(t); await control.initialize({ setup: true });
  db.prepare("UPDATE scheduled_events SET status='in_flight',command_id='cmd_interrupted'").run();
  await control.stop(); delete instance.timelineControl;
  const recovered = attachTimelineControl(instance, world, { now: () => T0, tickMs: 3600000 });
  t.after(() => recovered.stop());
  await assert.rejects(recovered.initialize(), error => error.code === 'timeline_recovery_required');
  assert.equal(recovered.status().timeline.uncertain, 1); assert.equal(recovered.status().clock.running, false);
  assert.equal(recovered.status().ok, true);
  await assert.rejects(recovered.command({ action: 'resume' }), /Reset the failed timeline/);
  await recovered.stop();
});
test('timeline query validation is strict and stopped status stays readable after database close', async t => {
  const { control, db } = fixture(t); await control.initialize({ setup: true });
  assert.equal(control.timeline(new URLSearchParams('after=0&limit=1')).data.length, 1);
  for (const query of [new URLSearchParams('limit=1&limit=2'), { typo: 1 }, { limit: '' }, { after: '-1' }, { fromMs: 5, toMs: 1 }]) {
    assert.throws(() => control.timeline(query), error => error.status === 400);
  }
  await control.stop(); db.close(); assert.equal(control.status().mode, 'stopped');
});


test('overflowing advance rejects before changing a running clock or its offset', async t => {
  const { control, db } = fixture(t); await control.initialize();
  await control.command({ action: 'advance', duration: '2s' });
  const before = control.status(), stored = db.prepare('SELECT * FROM clock').get();
  await assert.rejects(control.command({ action: 'advance', duration: '8640000000000000ms' }), error => error.code === 'bad_advance' && !error.state_changed);
  assert.equal(control.status().mode, 'running'); assert.deepEqual(control.status().clock, before.clock);
  assert.deepEqual(db.prepare('SELECT * FROM clock').get(), stored);
});
test('overflowing setup position rejects before changing repeat or arming the schedule', async t => {
  const first = fixture(t);
  await assert.rejects(first.control.initialize({ startAtMs: 8640000000000000, repeat: true }), error => error.code === 'bad_advance');
  assert.equal(first.control.status().mode, 'initializing'); assert.equal(first.control.status().timeline.total, 0);
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM timeline_cycle').get().n, 0);
  assert.equal(first.db.prepare('SELECT COUNT(*) AS n FROM clock').get().n, 0);
  const second = fixture(t); await second.control.initialize({ setup: true });
  const before = second.control.status();
  await assert.rejects(second.control.command({ action: 'start', duration: '8640000000000000ms', enabled: true }), error => error.code === 'bad_advance');
  assert.deepEqual(second.control.status(), before);
});


for (const action of ['initialize', 'advance']) test(`stop during ${action} settles only the current provider delivery`, async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { control, context, writes } = fixture(t, [operation('first', 1), operation('second', 2), operation('third', 3)]);
  const original = context.fetchImpl;
  context.fetchImpl = async (...args) => { entered(); await gate; return original(...args); };
  if (action === 'advance') await control.initialize();
  const moving = action === 'initialize' ? control.initialize({ startAtMs: 3000 }) : control.command({ action: 'advance', duration: '3s' });
  await started; assert.equal(control.status().timeline.in_flight, 1);
  const stopping = control.stop(); release();
  const result = await moving; await stopping;
  assert.deepEqual(writes, ['post.first']); assert.equal(result.clock.running, false); assert.equal(result.mode, 'stopped');
  assert.equal(result.played.length, 1); assert.equal(result.played[0].status, 'delivered');
  const status = control.status(); assert.equal(status.timeline.delivered, 1); assert.equal(status.timeline.pending, 2);
  assert.equal(status.timeline.failed, 0); assert.equal(status.timeline.uncertain, 0); assert.equal(status.timeline.in_flight, 0);
  assert.deepEqual(control.timeline().data.map(row => row.status), ['delivered', 'pending', 'pending']);
});


test('setup, reset baseline, and initial offset exclude time spent arming', async t => {
  let sampledAt = T0;
  const first = fixture(t, [operation('future', 10)], { now: () => sampledAt++ });
  const setup = await first.control.initialize({ setup: true });
  assert.equal(setup.clock.elapsed_ms, 0); assert.equal(setup.clock.world_now, new Date(first.world.clock.anchor).toISOString());
  const reset = await first.control.command({ action: 'reset' });
  assert.equal(reset.clock.elapsed_ms, 0); assert.equal(reset.clock.running, false);
  assert.equal(first.db.prepare('SELECT offset_ms FROM clock').get().offset_ms, 0);
  const second = fixture(t, [operation('future', 10)], { now: () => sampledAt++ });
  await second.control.initialize({ startAtMs: 5000 });
  assert.equal(second.db.prepare('SELECT offset_ms FROM clock').get().offset_ms, 5000);
});


test('reset in setup never delivers zero-time domain or application arrivals', async t => {
  const { control, writes, db } = fixture(t, [operation('zero'), { id: 'app-zero', after_seconds: 0, kind: 'application-event', payload: { kind: 'review.requested', data: {} } }]);
  await control.initialize({ setup: true, repeat: false });
  const result = await control.command({ action: 'reset', preserveSetup: true });
  assert.equal(result.mode, 'setup'); assert.equal(result.clock.elapsed_ms, 0); assert.equal(result.clock.running, false);
  assert.deepEqual(writes, []); assert.equal(result.timeline.pending, 2); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
});

test('loop preserves provider writes, history, and clock across passes; pause and disable stop further passes', async t => {
  const { control, instance, db, writes } = fixture(t, [operation('zero'), operation('last', 1)]);
  await control.initialize({ setup: true });
  await control.command({ action: 'start', duration: '0s', loop: true });
  assert.equal(control.status().loop.enabled, true);
  assert.equal(control.status().repeat.enabled, true);
  db.exec("CREATE TABLE manual_data(value TEXT); INSERT INTO manual_data VALUES('keep me')");
  for (let pass = 1; pass <= 3; pass++) {
    await control.command({ action: 'advance', duration: '1s' });
    await control.tick();
    assert.equal(instance.restores, 0);
    assert.equal(control.status().clock.elapsed_ms, pass * 1000);
    assert.equal(control.status().repeat.cycle, pass + 1);
    assert.equal(control.status().timeline.delivered, pass * 2);
    assert.equal(db.prepare('SELECT value FROM manual_data').get().value, 'keep me');
  }
  assert.equal(writes.length, 6);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT idempotency_key) AS n FROM commands').get().n, 6);
  await control.command({ action: 'pause' }); await control.tick();
  assert.equal(control.status().repeat.cycle, 4);
  await control.command({ action: 'loop', enabled: false });
  await control.command({ action: 'advance', duration: '1s' });
  await control.command({ action: 'resume' }); await control.tick();
  assert.equal(control.status().repeat.cycle, 4);
  assert.equal(control.status().timeline.delivered, 8);
});

test('loop rejects invalid settings before mutations and does not append after failure', async t => {
  const { control } = fixture(t, [operation('bad', 1)], { fetchImpl: async () => Response.json({ error: { message: 'Rejected' } }, { status: 400 }) });
  await control.initialize({ setup: true });
  const before = control.status();
  await assert.rejects(control.command({ action: 'loop', enabled: 'yes' }), /boolean/);
  await assert.rejects(control.command({ action: 'start', loop: true, enabled: true }), /either loop or repeat/);
  assert.deepEqual(control.status(), before);
  await control.command({ action: 'start', loop: true });
  await assert.rejects(control.command({ action: 'advance', duration: '1s' }), /delivery failed/);
  await control.tick();
  assert.equal(control.status().loop.enabled, false);
  assert.equal(control.status().repeat.cycle, 1);
  assert.equal(control.status().timeline.total, 1);
});


test('loop waits for delayed effects and keeps their evidence before appending the next pass', async t => {
  const rules = [{ api_version: 'worldfixture.causal-rule/v1', id: 'rule.follow', when: 'domain.record.created.v1', emit: [{ type: 'social.post.publish.v1', after: '5s',
    with: { actor_id: { value: 'person.one' }, record: { value: { id: 'post.effect', author_id: 'person.one', body: 'Effect' } } } }] }];
  const { control, instance } = fixture(t, [operation('last', 1)], { rules });
  await control.initialize({ loop: true });
  await control.command({ action: 'advance', duration: '1s' }); await control.tick();
  assert.equal(control.status().repeat.cycle, 1);
  await control.command({ action: 'advance', duration: '5s' }); await control.tick();
  assert.equal(control.status().repeat.cycle, 2); assert.equal(instance.restores, 0);
  const rows = control.timeline().data;
  assert.equal(rows.filter(row => row.status === 'delivered').length, 2);
  assert.equal(rows.find(row => row.id === 'loop:2:last').due_at, 7000);
  assert.ok(rows.find(row => row.type === 'world.causal.effect.v1').caused_by);
});
