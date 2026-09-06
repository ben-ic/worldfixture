import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CLOCK_CASES, assertAcceptedWorldTimes, assertAuthoredRows, assertBoundary, assertProviderArrivals, prepareClockCase, readTimelinePages, requestReader, workbenchRequestReader, runClockMatrix, selectClockCases } from './clock-world-test.mjs';

const world = { id: 'test.clock', version: 'v1', clock: { anchor: '2031-01-01T00:00:00Z' }, people: [{ id: 'one', email: 'one@clock.test' }, { id: 'two', email: 'two@clock.test' }],
  timeline: [{ id: 'arrival.mail', kind: 'incoming-email', after_seconds: 0, payload: { from_id: 'one', to_id: 'two', subject: 'Subject', body_text: 'Source body' } },
    { id: 'arrival.chat', kind: 'chat-message', after_seconds: 30, payload: { author_id: 'two', channel_id: 'channel.one', text: 'Source text' } }] };
const timeline = world.timeline.map((arrival, index) => ({ id: arrival.id, seq: index + 1, type: arrival.kind, payload: arrival.payload, due_at: arrival.after_seconds * 1000,
  status: 'pending', caused_by: null, event_id: `event-${index}`, command_id: `command-${index}` }));
const page = (data, total = data.length, more = false, cursor = data.at(-1)?.seq ?? 0) => ({ data, total_count: total, has_more: more, next_cursor: cursor, epoch: 1 });

test('complete timeline paging retains every one of 2000 records and exact window bounds', async () => {
  const rows = Array.from({ length: 2000 }, (_, index) => ({ id: `arrival-${index}`, seq: index + 1 })), calls = [];
  const actual = await readTimelinePages(async path => {
    const params = new URL(path, 'http://clock.test').searchParams; calls.push(params);
    const after = Number(params.get('after')), limit = Number(params.get('limit')), data = rows.slice(after, after + limit);
    return page(data, rows.length, after + limit < rows.length);
  }, { limit: 137, fromMs: 0, toMs: 604800000 });
  assert.deepEqual(actual, rows); assert.equal(calls.length, 15);
  assert.ok(calls.every(params => params.get('fromMs') === '0' && params.get('toMs') === '604800000'));
});

test('timeline pagination rejects truncation, repeated cursors, duplicate IDs, and generation changes', async () => {
  for (const kind of ['truncated', 'cursor', 'duplicate', 'epoch', 'metadata', 'empty-more']) {
    let calls = 0;
    await assert.rejects(readTimelinePages(async () => {
      calls++;
      if (kind === 'truncated') return page([timeline[0]], 2);
      if (kind === 'metadata') return { data: [] };
      if (kind === 'empty-more') return page([], 1, true);
      if (calls === 1) return page([timeline[0]], 2, true);
      if (kind === 'cursor') return page([timeline[1]], 2, false, 1);
      if (kind === 'duplicate') return page([{ ...timeline[1], id: timeline[0].id }], 2);
      return { ...page([timeline[1]], 2), epoch: 2 };
    }));
    assert.ok(calls <= 2, kind);
  }
});

test('source oracle rejects missing, foreign, changed, reordered and early timeline rows', () => {
  assertAuthoredRows(world, timeline);
  for (const mutate of [rows => rows.pop(), rows => { rows[0].id = 'foreign'; }, rows => { rows[0].payload.subject = 'changed'; }, rows => rows.reverse(), rows => { rows[0].due_at = 1; }]) {
    const changed = structuredClone(timeline); mutate(changed); assert.throws(() => assertAuthoredRows(world, changed));
  }
  const boundary = structuredClone(timeline); boundary[0].status = 'delivered'; assertBoundary(world, boundary, 0);
  boundary[1].status = 'delivered'; assert.throws(() => assertBoundary(world, boundary, 0)); assertBoundary(world, boundary, 30000);
  for (const status of ['failed', 'skipped', 'uncertain', 'in_flight']) { boundary[1].status = status; assertAuthoredRows(world, boundary); assert.throws(() => assertBoundary(world, boundary, 30000)); }
});

test('accepted event time, actor and command remain source-derived', () => {
  const rows = timeline.map(row => ({ ...row, status: 'delivered' }));
  const events = rows.map(row => ({ id: row.event_id, occurred_at: new Date(Date.parse(world.clock.anchor) + row.due_at).toISOString(),
    actor_id: 'two', caused_by: row.command_id, provider_evidence: { arrival: row.id } }));
  assertAcceptedWorldTimes(world, rows, events);
  for (const field of ['occurred_at', 'actor_id', 'caused_by']) { const changed = structuredClone(events); changed[0][field] = 'foreign'; assert.throws(() => assertAcceptedWorldTimes(world, rows, changed)); }
  assert.throws(() => assertAcceptedWorldTimes(world, rows, events.slice(1)));
});

function content() {
  return { users: [{ id: 'U_TWO', profile: { email: 'two@clock.test' } }], slack: { 'channel.one': [{ user: 'U_TWO', text: 'Source text', ts: '1.000001' }] },
    mail: { two: { messages: [{ headers: { 'x-worldfixture-arrival': 'arrival.mail', subject: 'Subject', from: 'one@clock.test', to: 'two@clock.test', date: 'Wed, 01 Jan 2031 00:00:00 GMT' }, body_text: 'Source body\r\n' }] } } };
}
test('public content oracle catches duplicate writes and foreign authors, bodies and dates', () => {
  const rows = timeline.map(row => ({ ...row, status: 'delivered' })); assertProviderArrivals(world, rows, content());
  for (const mutate of [value => value.slack['channel.one'].push(value.slack['channel.one'][0]), value => { value.slack['channel.one'][0].user = 'FOREIGN'; },
    value => value.mail.two.messages.push(value.mail.two.messages[0]), value => { value.mail.two.messages[0].body_text = 'changed'; },
    value => { value.mail.two.messages[0].headers.date = '2032-01-01'; }]) {
    const changed = content(); mutate(changed); assert.throws(() => assertProviderArrivals(world, rows, changed));
  }
  assert.throws(() => assertProviderArrivals(world, timeline, content()), /arrival count/);
  const failed = rows.map(row => ({ ...row, status: 'skipped', error: 'Explicit unbound destination' }));
  assert.throws(() => assertProviderArrivals(world, failed, content()), /skipped: Explicit unbound destination/);
});

test('HTTP control failures preserve measured status and partial delivery evidence', async () => {
  const responses = [], body = { error: 'delivery failed', state_changed: true, result: { played: [{ id: 'arrival.one', status: 'failed' }] } };
  const request = requestReader('http://clock.test', responses, { fetchImpl: async () => Response.json(body, { status: 409 }) });
  await assert.rejects(request('/api/clock', { method: 'POST', body: { action: 'advance', duration: '1w' } }), error => error.response === responses[0].body && error.response.result.played[0].status === 'failed');
  assert.equal(responses[0].status, 409); assert.deepEqual(responses[0].body, body);
});

test('case selection rejects unknown names and duplicate work', () => {
  assert.equal(selectClockCases().length, 3); assert.deepEqual(selectClockCases(['alien-long']), [CLOCK_CASES[2]]);
  assert.throws(() => selectClockCases(['unknown'])); assert.throws(() => selectClockCases(['starter', 'starter']));
});

test('frozen source preparation is deterministic and cannot replace evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'clock-fixture-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = readFileSync(resolve('examples/minimal-world/fragments/core.json'));
  for (const definition of CLOCK_CASES) {
    const first = await prepareClockCase({ definition, outputPath: join(root, `${definition.name}-one`) });
    const second = await prepareClockCase({ definition, outputPath: join(root, `${definition.name}-two`) });
    assert.equal(first.artifact.identity.digest, second.artifact.identity.digest);
    assert.deepEqual(first.evidence.artifact_files, second.evidence.artifact_files);
    assert.equal(first.artifact.world.timeline.length, definition.count);
    if (definition.variant) assert.equal(first.artifact.world.people.every(person => !person.name.includes(' ')), true);
    await assert.rejects(prepareClockCase({ definition, outputPath: join(root, `${definition.name}-one`) }), /already exists/);
  }
  assert.deepEqual(readFileSync(resolve('examples/minimal-world/fragments/core.json')), original);
});

test('prepare-only clearly reports no live proof and preserves its report', async t => {
  const root = mkdtempSync(join(tmpdir(), 'clock-prepare-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = join(root, 'report'); const report = await runClockMatrix({ reportPath, prepareOnly: true, caseNames: ['starter'] });
  assert.equal(report.status, 'prepared'); assert.equal(report.cases[0].responses.length, 0); assert.equal(report.cases[0].snapshots.length, 0);
  assert.match(report.cases[0].scope, /no live clock/);
  const before = readFileSync(join(reportPath, 'report.json'));
  await assert.rejects(runClockMatrix({ reportPath, prepareOnly: true }), /overwrite/); assert.deepEqual(readFileSync(join(reportPath, 'report.json')), before);
  await assert.rejects(runClockMatrix({ reportPath: join(root, 'bad'), image: 'mutable-tag' }), /immutable image ID/);
});


test('managed clock reader pins one generation across reset and never retries a stale write', async () => {
  const calls = [], responses = [];
  let generation = 'original';
  const request = await workbenchRequestReader('http://clock.test', responses, { fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, options });
    if (url.endsWith('/api/session')) return Response.json({ managed: true, phase: 'ready', generation });
    if (options.headers['X-WorldFixture-Generation'] !== generation) return Response.json({ code: 'stale_generation', error: 'Old world' }, { status: 409, headers: { 'X-WorldFixture-Generation': generation } });
    return Response.json({ ok: true }, { headers: { 'X-WorldFixture-Generation': generation } });
  } });
  await request('/api/clock', { method: 'POST', body: { action: 'reset' } });
  await request('/api/clock', { method: 'POST', body: { action: 'start', duration: '0s' } });
  generation = 'replacement';
  await assert.rejects(request('/api/clock', { method: 'POST', body: { action: 'advance', duration: '1s' } }), error => error.response.code === 'stale_generation');
  assert.equal(calls.filter(row => row.path === '/api/session').length, 1);
  assert.equal(calls.filter(row => row.options.method === 'POST').length, 3);
  assert.ok(calls.slice(1).every(row => row.options.headers['X-WorldFixture-Generation'] === 'original'));
});
test('managed clock reader rejects missing generation and unmanaged normal launches before writes', async () => {
  for (const session of [{ managed: false, phase: 'ready' }, { managed: true, phase: 'ready' }, { managed: true, phase: 'switching', generation: 'one' }]) {
    const calls = [];
    await assert.rejects(workbenchRequestReader('http://clock.test', [], { fetchImpl: async url => { calls.push(url); return Response.json(session); } }));
    assert.equal(calls.length, 1);
  }
});
