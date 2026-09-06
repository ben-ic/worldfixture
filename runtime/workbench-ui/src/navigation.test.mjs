import assert from 'node:assert/strict';
import test from 'node:test';
import { availableScreen, guideSteps, reconcileScreen, recordAction, runIdentity, selectAcceptedActor, selectActor, selectedNavigation, serviceBadge, serviceScreen } from './navigation.mjs';

const fixture = () => ({ world: { id: 'moon.collective', version: 'v17', artifact_sha256: 'current-digest' },
  people: [{ id: 'person:µ/17', name: 'Tavi', email: 'tavi@moon.test' }],
  surfaces: [{ id: 'stripe', name: 'Stripe', state: 'ready', capabilities: ['stripe.customers.v1'] },
    { id: 'linear', name: 'Linear', state: 'ready', capabilities: ['linear.issues.v1'] },
    { id: 'notion', name: 'Notion', state: 'ready', capabilities: ['notion.pages-read.v1'] }],
  bindings: { CUSTOM_CONNECTION: 'local' }, providers: { stripe: { customers: [{ id: 'customer:one' }] }, linear: { issues: [] }, notion: { pages: [] } }, activity: [{ id: 'old-event' }] });
const action = (data, state, event) => recordAction(state, { success: true, ...event }, runIdentity(data), data);
const step = (data, evidence, id) => guideSteps(data, evidence).find(row => row.id === id);

test('selected surfaces define navigation; unknown IDs stay exact and cannot collide with screen labels', () => {
  const data = fixture();
  data.bindings = { SLACK_BASE_URL: 'stale-value' };
  data.surfaces.push({ id: 'new:vendor/µ?', name: 'New provider', state: 'starting' }, { id: 'Overview', state: 'ready' }, { id: '__proto__', state: 'ready' });
  const nav = selectedNavigation(data);
  assert.equal(nav.length, data.surfaces.length);
  assert.ok(!nav.some(row => row.id === 'slack'));
  assert.equal(nav.find(row => row.id === 'new:vendor/µ?').screen, 'service:new:vendor/µ?');
  assert.equal(serviceScreen('Overview'), 'service:Overview');
  assert.equal(serviceScreen('__proto__'), 'service:__proto__');
  assert.equal(serviceScreen('google'), 'Gmail');
  assert.equal(availableScreen(data, 'Chat'), false);
  assert.equal(availableScreen(data, 'service:new:vendor/µ?'), true);
  assert.equal(availableScreen(data, 'service:stripe'), true);
  assert.equal(availableScreen(data, 'service:slack'), false);
});

test('loaded-world changes remove unavailable screens and preserve only actual actor IDs', () => {
  const data = fixture();
  assert.equal(reconcileScreen(data, 'Stripe'), 'Stripe');
  data.surfaces = [{ id: 'unknown', state: 'ready' }];
  assert.equal(reconcileScreen(data, 'Stripe'), 'Overview');
  assert.equal(selectActor(data, 'missing').name, 'Tavi');
  assert.equal(selectActor(data, 'person:µ/17').id, 'person:µ/17');
  data.people = [];
  assert.equal(selectActor(data, 'person:µ/17'), null);
  assert.equal(selectedNavigation(data)[0].screen, 'service:unknown');
});

test('sparse capabilities omit unavailable guide actions even with old activity and bindings', () => {
  const data = fixture(), steps = guideSteps(data);
  assert.ok(steps.every(row => !row.done));
  assert.ok(!steps.some(row => ['Chat', 'Website', 'Gmail', 'Local Mail'].includes(row.target)));
  assert.equal(step(data, null, 'write').target, 'Stripe');
  assert.equal(step(data, null, 'activity'), undefined);
  data.people = [];
  assert.equal(step(data, null, 'write'), undefined);
  data.surfaces = [{ id: 'slack', state: 'ready', capabilities: ['slack.oauth.v1'] }];
  data.providers.slack = { channels: [{ id: 'one' }] };
  assert.equal(step(data, null, 'read'), undefined);
});

test('guide completion requires the matching successful action and active run', () => {
  const data = fixture();
  let evidence = action(data, null, { type: 'read', target: 'services' });
  assert.equal(step(data, evidence, 'probe').done, false);
  evidence = action(data, evidence, { type: 'probe', target: 'services', success: false });
  assert.equal(step(data, evidence, 'probe').done, false);
  evidence = action(data, evidence, { type: 'probe', surface: 'stripe', target: 'services' });
  assert.equal(step(data, evidence, 'probe').done, false);
  evidence = action(data, evidence, { type: 'probe', target: 'services' });
  assert.equal(step(data, evidence, 'probe').done, true);
  evidence = action(data, evidence, { type: 'read', target: 'bindings' });
  assert.equal(step(data, evidence, 'copy').done, false);
  evidence = action(data, evidence, { type: 'copy', target: 'bindings' });
  assert.equal(step(data, evidence, 'copy').done, true);
  evidence = action(data, evidence, { type: 'write', surface: 'slack', target: 'message' });
  assert.equal(step(data, evidence, 'write').done, false);
  evidence = action(data, evidence, { type: 'write', surface: 'stripe', target: 'payments' });
  assert.equal(step(data, evidence, 'write').done, true);
  const oldKey = runIdentity(data);
  data.world.artifact_sha256 = 'new-digest';
  evidence = recordAction(evidence, { type: 'reset', target: 'world', success: true }, oldKey, data);
  assert.ok(guideSteps(data, evidence).every(row => !row.done));
});

test('activity read must succeed after this guide accepted a write', () => {
  const data = fixture();
  let evidence = action(data, null, { type: 'read', target: 'activity' });
  evidence = action(data, evidence, { type: 'write', target: 'payments', surface: 'stripe' });
  assert.equal(step(data, evidence, 'activity').done, false);
  evidence = action(data, evidence, { type: 'read', target: 'activity' });
  assert.equal(step(data, evidence, 'activity').done, true);
});

test('HTTP guide requires selected capability and actual targets, and only successful target evidence completes it', () => {
  const data = fixture(); data.providers.website = { targets: [{ kind: 'new-target', path: '/new' }] };
  assert.equal(step(data, null, 'http'), undefined);
  data.surfaces.push({ id: 'http', state: 'ready', capabilities: ['http.public-site.v1'] });
  assert.equal(step(data, null, 'http').target, 'Website');
  let evidence = action(data, null, { type: 'probe', target: 'services' });
  assert.equal(step(data, evidence, 'http').done, false);
  evidence = action(data, evidence, { type: 'probe', target: 'services', surface: 'http' });
  assert.equal(step(data, evidence, 'http').done, false);
  evidence = action(data, evidence, { type: 'read', target: '/new', surface: 'http' });
  assert.equal(step(data, evidence, 'http').done, true);
});

test('badges distinguish actual empty reads from missing and failed reads', () => {
  const data = fixture();
  assert.equal(serviceBadge(data, 'linear'), 0);
  assert.equal(serviceBadge(data, 'google'), undefined);
  data.providers.gmail = { inbox: { resultSizeEstimate: 3 } };
  assert.equal(serviceBadge(data, 'google'), undefined);
  data.providers.gmail.sent = { resultSizeEstimate: 2 };
  assert.equal(serviceBadge(data, 'google'), 5);
  data.providers.errors = [{ provider: 'Gmail', message: 'not measured' }];
  assert.equal(serviceBadge(data, 'google'), undefined);
});


test('provider errors and incomplete collection counts cannot appear as measured zero badges', () => {
  const data = fixture();
  data.providers.linear = { status: 'error', available: false, issues: [] };
  assert.equal(serviceBadge(data, 'linear'), undefined);
  data.providers.linear = { status: 'ready', available: true, issues: [], collectionStatus: { issues: { status: 'failed' } } };
  assert.equal(serviceBadge(data, 'linear'), undefined);
  data.providers.linear.collectionStatus.issues.status = 'partial';
  assert.equal(serviceBadge(data, 'linear'), undefined);
  data.providers.linear.collectionStatus.issues.status = 'complete';
  assert.equal(serviceBadge(data, 'linear'), 0);
});


test('known accepted event requires the same event ID in a later successful Activity read', () => {
  const data = fixture();
  let evidence = action(data, null, { type: 'write', surface: 'stripe', target: 'payments', eventId: 'event:current' });
  evidence = action(data, evidence, { type: 'read', target: 'activity', eventIds: ['event:older'] });
  assert.equal(step(data, evidence, 'activity').done, false);
  evidence = action(data, evidence, { type: 'read', target: 'activity', eventIds: ['event:older', 'event:current'] });
  assert.equal(step(data, evidence, 'activity').done, true);
});

test('partial optional reads preserve complete core badges and guide actions only', () => {
  const data = fixture();
  data.surfaces = [{ id: 'notion', state: 'ready', capabilities: ['notion.pages-read.v1', 'notion.pages-write.v1'] }];
  data.providers.notion = { status: 'partial', available: true, pages: [{ id: 'page' }], collectionStatus: {
    pages: { status: 'complete' }, adminAgents: { status: 'unavailable', error: 'No admin capability' } } };
  data.providers.errors = [{ provider: 'notion', message: 'adminAgents: No admin capability' }];
  assert.equal(serviceBadge(data, 'notion'), 1);
  assert.equal(step(data, null, 'read').target, 'Notion');
  assert.equal(step(data, null, 'write').target, 'Notion');
  data.providers.notion.collectionStatus.pages.status = 'failed';
  assert.equal(serviceBadge(data, 'notion'), undefined);
  assert.equal(step(data, null, 'write'), undefined);
});


test('accepted current-generation overview selects its own primary instead of a retained old-world ID', () => {
  const old = { ...fixture(), session: { generation: 'old' }, people: [{ id: 'shared', name: 'Old person', primary: true }] };
  const next = { ...old, session: { generation: 'new' }, people: [{ id: 'shared', name: 'Different person' }, { id: 'new-primary', name: 'Tavi', primary: true }] };
  assert.equal(selectAcceptedActor(next, old, 'shared').id, 'new-primary');
  assert.equal(selectAcceptedActor(next, null, null).id, 'new-primary', 'First accepted managed load has a default actor');
  assert.equal(selectAcceptedActor(next, next, 'shared').id, 'shared', 'An explicit selection survives a same-generation refresh');
  assert.equal(selectAcceptedActor({ ...next, people: [{ id: 'sole', name: 'Tavi' }] }, old, 'shared').id, 'sole');
  assert.equal(selectAcceptedActor({ ...next, people: [] }, old, 'shared'), null, 'An actor-free world remains actor-free');
  assert.equal(selectAcceptedActor(null, old, 'shared'), null, 'No actor is selected during the transition');
});
