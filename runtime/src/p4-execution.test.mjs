import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { capabilityWorldErrors, selectCompatibleCapabilities } from './capability-world.mjs';
import { executionPreflight } from './execution-preflight.mjs';
import { executeDomainOperation } from './domain-operations.mjs';
import { queueEffects } from './causal-queue.mjs';
import { lifecyclePath } from './lifecycle-paths.mjs';
import { advanceClock, pauseClock, startClock } from './clock.mjs';
import { playDue, playOne } from './scheduler.mjs';
import { appendEvent, eventsAfter, openState } from './state.mjs';
import { Instance } from './supervisor.mjs';
const NOW = 1700000000000;
const world = { id: 'test.sparse', version: 'v1', clock: { anchor: '2031-01-01T00:00:00Z' },
  people: [{ id: 'person.one', name: 'One', email: 'one@sparse.test' }, { id: 'person.two', name: 'Two', email: 'two@sparse.test' }],
  communication: { channels: [{ id: 'channel.one', name: 'general', member_ids: ['person.one', 'person.two'] }] }, timeline: [{ id: 'test.inspection', after_seconds: 1, kind: 'webhook', payload: { body: { action: 'inspect-fixture', world: 'test.sparse' } } }] };
const rule = { api_version: 'worldfixture.causal-rule/v1', id: 'rule.notify', when: 'communication.message.sent.v1', emit: [{ type: 'mail.notification.requested.v1', after: '5s', with: {
  author: { copy: 'actor_id' }, channel: { copy: 'provider_evidence.channel_name' }, text: { copy: 'provider_evidence.text' }, recipients: { value: ['person.two'] },
} }] };
function dbFor(t) { const db = openState(':memory:'); t.after(() => db.close()); startClock(db, { anchor: world.clock.anchor, now: NOW }); pauseClock(db, { now: NOW }); return db; }

test('capability requirements preserve explicit empty collections and do not require unrelated identities', () => {
  const cap = { world: { requires: ['communication.channels'], identities: [{ collection: 'people', scope: 'all', fields: ['id'] }] } };
  assert.deepEqual(capabilityWorldErrors({}, cap, { world: { ...world, communication: { channels: [] } }, artifact: {} }), []);
  assert.match(capabilityWorldErrors({}, cap, { world: { people: world.people }, artifact: {} }).join(' '), /communication.channels/);
});

test('preflight rejects unknown kinds and references even when a generated partial run excludes their adapter', () => {
  const timeline = [{ id: 'arrival.one', after_seconds: 0, kind: 'chat-message', payload: { author_id: 'missing', channel_id: 'channel.one', text: 'hello' } }];
  const bad = executionPreflight({ ...world, timeline }, { capabilities: [], allowUnselected: true });
  assert.match(bad.errors.join(' '), /author_id/); assert.equal(bad.timeline.excluded.length, 1);
  timeline[0].payload.author_id = 'person.one';
  assert.deepEqual(executionPreflight({ ...world, timeline }, { capabilities: [], allowUnselected: true }).errors, []);
  assert.match(executionPreflight({ ...world, timeline }, { capabilities: [] }).errors.join(' '), /required capability/);
  timeline[0].kind = 'telepathy';
  assert.match(executionPreflight({ ...world, timeline }, { capabilities: [], allowUnselected: true }).errors.join(' '), /unknown executable kind/);
});

test('one shared executable rule contract rejects descriptive ambiguity and unavailable adapters', () => {
  assert.deepEqual(executionPreflight(world, { capabilities: ['mail.smtp-submission.v1', 'slack.messaging.v1'], rules: [rule] }).errors, []);
  assert.match(executionPreflight(world, { capabilities: [], rules: [rule] }).errors.join(' '), /required capability/);
  assert.match(executionPreflight(world, { capabilities: [], rules: [{ id: 'old', when: 'invoice.paid', emits: ['mail'] }] }).errors.join(' '), /api_version/);
  const descriptive = executionPreflight(world, { capabilities: [], rules: [{ id: 'old', execution: 'descriptive', reason: 'No executable receipt payload' }] });
  assert.deepEqual(descriptive.errors, []); assert.equal(descriptive.rules.length, 0); assert.equal(descriptive.ruleDiagnostics[0].status, 'descriptive');
});

test('the active causal queue accepts command ancestry and rejects unlinked or cyclic events', t => {
  const db = dbFor(t);
  db.prepare("INSERT INTO commands(id,type,actor_id,target,input,status,submitted_at) VALUES(?,?,?,?,?,'accepted',?)")
    .run('cmd_origin', 'communication.message.send.v1', 'person.one', '{}', '{}', NOW);
  const event = (id, caused_by) => ({ id, caused_by, type: rule.when, actor_id: 'person.one',
    source: 'slack', occurred_at: world.clock.anchor, provider_evidence: { channel_name: 'general', text: id } });
  const records = [event('evt_unlinked', null), event('evt_missing', 'evt_absent'), event('evt_cycle', 'evt_cycle'),
    event('evt_command', 'cmd_origin'), event('evt_child', 'evt_command')];
  for (const record of records) appendEvent(db, record);
  for (const record of records.slice(0, 3)) {
    assert.deepEqual(queueEffects(db, record, { world, rules: [rule], now: NOW }), []);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_events').get().count, 0);
  for (const record of records.slice(3)) {
    const [effect] = queueEffects(db, record, { world, rules: [rule], now: NOW });
    assert.equal(effect.caused_by, record.id);
    assert.equal(effect.due_at, 5000);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_events').get().count, 2);
});

test('causal effects wait for world time, survive re-read, preserve cause, and reject a cycle', async t => {
  const db = dbFor(t), sent = [];
  const event = { id: 'evt_source', type: rule.when, actor_id: 'person.one', source: 'slack', occurred_at: world.clock.anchor,
    provider_evidence: { channel_name: 'general', text: 'hello' }, caused_by: 'cmd_source' };
  appendEvent(db, event);
  const [effect] = queueEffects(db, event, { world, rules: [rule], now: NOW });
  assert.equal(effect.due_at, 5000);
  const context = { world, rules: [rule], bindings: { SMTP_HOST_PORT: 'smtp.invalid:25' }, now: () => NOW + 100000, sendMail: async (_, mail) => sent.push(mail) };
  assert.deepEqual(await playDue(db, context, { now: NOW + 100000 }), []); assert.equal(sent.length, 0);
  advanceClock(db, 5000, { now: NOW });
  await playDue(db, context, { now: NOW }); assert.equal(sent.length, 1);
  const delivered = eventsAfter(db, 0).find(row => row.type === 'mail.notification.delivered.v1');
  assert.equal(delivered.caused_by, event.id); assert.equal(delivered.occurred_at, '2031-01-01T00:00:05.000Z');
  const loop = { ...rule, when: delivered.type };
  assert.deepEqual(queueEffects(db, delivered, { world, rules: [loop], now: NOW }), []);
  assert.ok(eventsAfter(db, 0).some(row => row.type === 'world.causal.effect.rejected.v1'));
  await playDue(db, context, { now: NOW }); assert.equal(sent.length, 1);
});

test('domain write uses public API and records its exact acceptance with world time', async t => {
  const db = dbFor(t), calls = [];
  const record = { id: 'post.one', author_id: 'person.one', title: 'First', body: 'World data' };
  const result = await executeDomainOperation(db, { api_version: 'worldfixture.runtime-operation/v1', type: 'social.post.publish.v1', actor_id: 'person.one', record }, {
    world, bindings: { DOMAIN_BASE_URL: 'http://domain.test', DOMAIN_TOKEN: 'synthetic-secret' }, rules: [], now: () => NOW,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, record, event: { id: 'domain-event-1', seq: 1, type: 'domain.record.created.v1', collection: 'social.posts', record_id: record.id, actor_id: 'person.one', world, before: null, after: record } }); },
  });
  assert.equal(calls[0].url, 'http://domain.test/v1/collections/social.posts');
  assert.deepEqual(JSON.parse(calls[0].options.body), { actor_id: 'person.one', record });
  assert.equal(result.event.provider_evidence.event_id, 'domain-event-1'); assert.equal(result.event.occurred_at, '2031-01-01T00:00:00.000Z');
  assert.equal(eventsAfter(db, 0).length, 1); assert.match(result.event.caused_by, /^cmd_/);
});

test('a failed domain write does not invent an accepted event or expose tokens', async t => {
  const db = dbFor(t);
  await assert.rejects(executeDomainOperation(db, { method: 'DELETE', collection: 'social.posts', recordId: 'post.one', actor_id: 'person.one' }, {
    world, bindings: { DOMAIN_BASE_URL: 'http://domain.test', DOMAIN_TOKEN: 'never-echo' }, fetchImpl: async () => Response.json({ ok: false, error: { code: 'conflict', message: 'never-echo' } }, { status: 409 }),
  }), error => error.code === 'conflict' && error.status === 409 && !error.message.includes('never-echo'));
  assert.equal(eventsAfter(db, 0).length, 0); assert.equal(db.prepare('SELECT status FROM commands').get().status, 'failed');
});

test('scheduled domain operations and delayed effects keep one command with the declared actor', async t => {
  const db = dbFor(t);
  const operation = { api_version: 'worldfixture.runtime-operation/v1', type: 'social.post.publish.v1', actor_id: 'person.one',
    record: { id: 'post.scheduled', author_id: 'person.one', body: 'Scheduled content' } };
  const context = { world, rules: [], bindings: { DOMAIN_BASE_URL: 'http://domain.test', DOMAIN_TOKEN: 'synthetic' }, now: () => NOW,
    fetchImpl: async (_url, options) => { const { record, actor_id } = JSON.parse(options.body); return Response.json({ ok: true, record,
      event: { id: `domain-${record.id}`, seq: 1, type: 'domain.record.created.v1', collection: 'social.posts', record_id: record.id, actor_id, world, before: null, after: record } }); } };
  await playOne(db, { id: 'arrival.domain', type: 'domain-operation', payload: JSON.stringify(operation), due_at: 0 }, context);
  let commands = db.prepare('SELECT * FROM commands').all();
  assert.equal(commands.length, 1); assert.equal(commands[0].actor_id, 'person.one'); assert.equal(commands[0].status, 'accepted');
  const first = eventsAfter(db, 0)[0]; assert.equal(first.caused_by, commands[0].id); assert.equal(commands[0].event_id, first.id);
  const effect = { type: operation.type, payload: { actor_id: 'person.two', record: { ...operation.record, id: 'post.effect', author_id: 'person.two' } },
    rule: 'rule.follow-up', caused_by: first.id };
  await playOne(db, { id: 'effect.domain', type: 'world.causal.effect.v1', payload: JSON.stringify(effect), due_at: 5000 }, context);
  commands = db.prepare('SELECT * FROM commands ORDER BY rowid').all();
  assert.equal(commands.length, 2); assert.equal(commands[1].actor_id, 'person.two'); assert.equal(commands[1].status, 'accepted');
  const second = eventsAfter(db, 0)[1]; assert.equal(second.caused_by, first.id); assert.equal(commands[1].event_id, second.id);
});

test('service lifecycle paths stay inside owned state, including dangling symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'worldfixture-lifecycle-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'state')); mkdirSync(join(root, 'outside')); writeFileSync(join(root, 'outside', 'keep'), 'unchanged');
  assert.equal(lifecyclePath('domain', join(root, 'state')), join(realpathSync(join(root, 'state')), 'domain'));
  for (const path of ['..', '../outside', '.', '/etc', '/tmp/seaweedfs/../../outside']) assert.throws(() => lifecyclePath(path, join(root, 'state')));
  symlinkSync(join(root, 'outside'), join(root, 'state', 'link')); assert.throws(() => lifecyclePath('link/keep', join(root, 'state')), /symlink/);
  symlinkSync(join(root, 'absent'), join(root, 'state', 'broken')); assert.throws(() => lifecyclePath('broken/file', join(root, 'state')), /symlink/);
});

test('a child crash clears accepted readiness; expected reset stops do not mark failure', () => {
  const instance = new Instance({ lock: { services: [{ name: 'domain' }] }, allocation: new Map(), children: [] });
  instance.phase = 'ready'; instance.readiness.set('domain', { ready: true });
  instance.childExited({ service: 'domain', exited: { code: 7 } });
  assert.equal(instance.phase, 'failed'); assert.equal(instance.serviceStates.get('domain'), 'failed'); assert.equal(instance.readiness.get('domain').ready, false);
  instance.phase = 'ready'; instance.childExited({ service: 'domain', expectedStop: true }); assert.equal(instance.phase, 'ready');
});

test('service entrypoints consistently reject a missing world before state or provider startup', () => {
  const root = new URL('../../', import.meta.url).pathname, env = { ...process.env }; delete env.WORLDFIXTURE_WORLD_PATH;
  for (const service of ['mail', 's3', 'postgres', 'mysql']) {
    const result = spawnSync('/bin/sh', [`${root}emulators/${service}/worldfixture-entrypoint.sh`], { env, encoding: 'utf8' });
    assert.equal(result.status, 64, service); assert.match(result.stderr, /worldfixture: missing world:/);
  }
  const result = spawnSync(process.execPath, [`${root}emulators/http-targets/server.mjs`], { env, encoding: 'utf8' });
  assert.equal(result.status, 64); assert.match(result.stderr, /worldfixture: missing world:/);
});

test('required application events need an explicit connector, including partial environments', () => {
  const variant = { ...world, timeline: [{ id: 'app.one', kind: 'application-event', after_seconds: 1, payload: { kind: 'review.requested' } }] };
  assert.match(executionPreflight(variant, { capabilities: [], allowUnselected: true }).errors.join(' '), /configured HTTP application connector/);
  assert.deepEqual(executionPreflight(variant, { capabilities: [], applicationTarget: 'http://app.test' }).errors, []);
});

test('Stripe arrivals confirm the payment before recording success and preserve customer and currency', async t => {
  const { deliverArrival } = await import('./arrivals.mjs');
  const db = dbFor(t), requests = [], variant = { ...world, finance: { customers: [{ id: 'customer.one', contact_id: 'person.one' }] } };
  const arrival = { id: 'payment.one', kind: 'stripe-payment', payload: { customer_id: 'customer.one', amount_cents: 500, currency: 'JPY' } };
  const responses = [{ data: [{ id: 'cus_one', email: 'one@sparse.test' }], has_more: false }, { id: 'pi_one', status: 'requires_confirmation' },
    { id: 'pi_one', status: 'succeeded', amount: 500, currency: 'jpy' }];
  await deliverArrival(db, arrival, { world: variant, bindings: { STRIPE_BASE_URL: 'http://stripe.test', STRIPE_TOKEN: 'synthetic' }, commandId: 'cmd_payment', now: () => NOW,
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json(responses.shift()); } });
  assert.equal(requests[2].url, 'http://stripe.test/v1/payment_intents/pi_one/confirm');
  assert.equal(new URLSearchParams(requests[1].options.body).get('customer'), 'cus_one');
  const event = eventsAfter(db, 0)[0]; assert.equal(event.provider_evidence.currency, 'jpy'); assert.equal(event.occurred_at, world.clock.anchor.replace('Z', '.000Z'));
});

test('Stripe invoice arrivals refuse a paid invoice before any second settlement', async t => {
  const { deliverArrival } = await import('./arrivals.mjs');
  const db = dbFor(t), requests = [];
  await assert.rejects(deliverArrival(db, { id: 'duplicate', kind: 'stripe-payment', payload: { invoice_id: 'invoice.one', amount_cents: 500, currency: 'usd' } }, {
    world, bindings: { STRIPE_BASE_URL: 'http://stripe.test', STRIPE_TOKEN: 'synthetic' }, commandId: 'cmd_duplicate',
    fetchImpl: async (url, options) => { requests.push({ url, options }); return Response.json({ data: [{ id: 'in_one', status: 'paid', metadata: { worldfixture_invoice_id: 'invoice.one' } }], has_more: false }); },
  }), /cannot be settled twice/);
  assert.equal(requests.length, 1); assert.equal(requests[0].options.method, 'GET'); assert.equal(eventsAfter(db, 0).length, 0);
});


test('generated mail selection keeps no-primary mailboxes and records omitted personal bindings', t => {
  const root = mkdtempSync(join(tmpdir(), 'worldfixture-no-primary-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'world.json'), JSON.stringify(world)); writeFileSync(join(root, 'manifest.json'), JSON.stringify({ files: {} }));
  const manifests = [{ provides: [{ profile: 'mail.imap.v1', world: { requires: ['people'], identities: [{ collection: 'people', scope: 'all', fields: ['id', 'email'] }] },
    binds: [{ name: 'host_port', from: 'port.host_port' }, { name: 'username', per_person: true }] }] }];
  const spec = { requires: ['mail.imap.v1'], bindings: { IMAP_HOST_PORT: 'mail.imap.v1/host_port', IMAP_USERNAME: 'mail.imap.v1/username' }, target: { kind: 'none' }, execution: { mode: 'all' } };
  const generated = selectCompatibleCapabilities(spec, { manifests, artifactPath: root });
  assert.deepEqual(generated.requires, ['mail.imap.v1']); assert.deepEqual(generated.bindings, { IMAP_HOST_PORT: 'mail.imap.v1/host_port' });
  assert.equal(generated.target.identity, undefined); assert.equal(generated.execution.binding_diagnostics[0].binding, 'IMAP_USERNAME');
  const explicitActor = selectCompatibleCapabilities({ ...spec, target: { kind: 'none', identity: 'person.two' } }, { manifests, artifactPath: root });
  assert.equal(explicitActor.bindings.IMAP_USERNAME, 'mail.imap.v1/username'); assert.deepEqual(explicitActor.execution.binding_diagnostics, []);
});

test('an absent SQS declaration differs from an explicitly empty queue inventory', t => {
  const root = mkdtempSync(join(tmpdir(), 'worldfixture-sqs-requirement-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projections')); const file = 'projections/emulator-overlay.json';
  const capability = { world: { projections: [{ file, subtree: '/aws/sqs' }] } }, options = { world, artifactPath: root, artifact: { files: { [file]: {} } } };
  writeFileSync(join(root, file), JSON.stringify({ aws: { account_id: '123400005678', region: 'eu-west-2' } }));
  assert.match(capabilityWorldErrors({}, capability, options).join(' '), /missing declared projection subtree/);
  writeFileSync(join(root, file), JSON.stringify({ aws: { account_id: '123400005678', region: 'eu-west-2', sqs: { queues: [] } } }));
  assert.deepEqual(capabilityWorldErrors({}, capability, options), []);
});

test('malformed timeline entries produce preflight errors without starting an adapter', () => {
  assert.match(executionPreflight({ ...world, timeline: {} }).errors.join(' '), /timeline must be an array/);
  assert.match(executionPreflight({ ...world, timeline: [null] }).errors.join(' '), /timeline entry 0 must be an object/);
  assert.match(executionPreflight(world, { rules: null }).errors.join(' '), /Causal rules must be an array/);
});

test('an explicit GitHub OAuth app resolves without adding repositories to its world', async t => {
  const { createHash } = await import('node:crypto');
  const { canonical, resolveEnvironment } = await import('./resolve.mjs');
  const { loadManifests } = await import('./manifests.mjs');
  const { inspectWorldArtifact } = await import('./world-catalogue.mjs');
  const root = mkdtempSync(join(tmpdir(), 'worldfixture-github-app-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'projections'));
  const app = { id: 'app.one', name: 'Declared App', client_id: 'declared-client', redirect_uris: ['http://localhost:3100/callback'] };
  const source = { ...world, api_version: 'worldfixture.world-source/v1', software: { oauth_clients: { github: [app] } } };
  const bytes = value => Buffer.from(`${canonical(value)}\n`), hash = value => createHash('sha256').update(value).digest('hex');
  const bodies = { 'world.json': bytes(source), 'projections/emulator-overlay.json': bytes({ github: { oauth_apps: [app] }, tokens: {} }) };
  const files = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, { size: body.length, sha256: hash(body) }]));
  const manifest = { api_version: 'worldfixture.world-artifact/v1', world_id: source.id, world_version: source.version,
    files, artifact_sha256: hash(bytes(files)), source_files: { 'world.json': files['world.json'] }, source_sha256: files['world.json'].sha256 };
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(root, name), body);
  writeFileSync(join(root, 'manifest.json'), bytes(manifest));
  assert.equal(inspectWorldArtifact(root).valid, true);
  const options = { manifests: loadManifests(new URL('../../emulators', import.meta.url).pathname), artifactPath: root };
  const spec = { api_version: 'worldfixture.environment/v1', world: { use: `${source.id}:${source.version}` }, requires: ['github.apps.v1'],
    bindings: { GITHUB_BASE_URL: 'github.apps.v1/base_url' }, target: { kind: 'none' } };
  const lock = resolveEnvironment(spec, options);
  assert.equal(lock.capabilities['github.apps.v1'].service, 'emulate'); assert.equal(source.software.repositories, undefined);
  assert.throws(() => resolveEnvironment({ ...spec, requires: ['github.repositories.v1'], bindings: {} }, options), /software.repositories/);
});


test('runtime preflight rejects empty authored artifacts while allowing an empty selected arc', () => {
  for (const timeline of [undefined, []]) assert.match(executionPreflight({ ...world, timeline }).errors.join(' '), /test.sparse:v1.*at least one authored arrival/);
  const result = executionPreflight({ ...world, timeline: [{ id: 'message', after_seconds: 1, kind: 'chat-message', payload: { author_id: 'person.one', channel_id: 'channel.one', text: 'A declared update' } }] }, { capabilities: [], allowUnselected: true });
  assert.deepEqual(result.errors, []); assert.deepEqual(result.timeline.active, []); assert.equal(result.timeline.excluded.length, 1);
});
