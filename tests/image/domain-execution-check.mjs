// Run inside the product image with the compiled domain-execution fixture at
// /world. All record writes use the public domain API through the scheduler.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadManifests } from '/opt/worldfixture/runtime/src/manifests.mjs';
import { resolveEnvironment } from '/opt/worldfixture/runtime/src/resolve.mjs';
import { start } from '/opt/worldfixture/runtime/src/supervisor.mjs';
import { startClock, pauseClock, advanceClock } from '/opt/worldfixture/runtime/src/clock.mjs';
import { armTimeline, playDue, pending } from '/opt/worldfixture/runtime/src/scheduler.mjs';
import { eventsAfter } from '/opt/worldfixture/runtime/src/state.mjs';
import { SINGLE_CONTAINER_PORTS } from '/opt/worldfixture/runtime/src/ports.mjs';

const world = JSON.parse(readFileSync('/world/world.json'));
const lock = resolveEnvironment({api_version: 'worldfixture.environment/v1', world: {use: `${world.id}:${world.version}`},
  requires: ['domain.collections.v1'], bindings: {DOMAIN_BASE_URL: 'domain.collections.v1/base_url', DOMAIN_TOKEN: 'domain.collections.v1/token'},
  rules: [], target: {kind: 'none'}}, {artifactPath: '/world', manifests: loadManifests('/opt/worldfixture/emulators')});
const instance = await start(lock, {artifactPath: '/world', stateDir: '/state', serviceRoot: '/opt/worldfixture/emulators', runner: 'process', fixedPorts: SINGLE_CONTAINER_PORTS});
const bindings = instance.bindings(), db = instance.state, now = Date.now();
const context = {world, bindings, rules: lock.rules, now: () => now};
const report = {world: lock.world, checks: [], cycles: [], responses: []};
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({check: name, status: 'passed'}); };
const read = async path => {
  const response = await fetch(bindings.DOMAIN_BASE_URL + path, {headers: {authorization: `Bearer ${bindings.DOMAIN_TOKEN}`}});
  assert.equal(response.status, 200, path);
  const body = await response.json();
  report.responses.push({path, status: response.status, body});
  return body;
};
const rearm = () => { startClock(db, {anchor: world.clock.anchor, now}); pauseClock(db, {now}); armTimeline(db, world); };
instance.rearmTimeline = rearm;
try {
  rearm();
  for (let cycle = 0; cycle < 2; cycle++) {
    const prefix = `cycle-${cycle + 1}`;
    check(`${prefix}.baseline`, (await read('/v1/collections/commerce.orders')).data.length === 0 && (await read('/v1/events')).data.length === 0);
    check(`${prefix}.not-early`, (await playDue(db, context, {now})).length === 0);
    advanceClock(db, 1000, {now});
    const order = await playDue(db, context, {now});
    check(`${prefix}.scheduled-order`, order.length === 1 && order[0].status === 'delivered');
    assert.deepEqual((await read('/v1/collections/commerce.orders/order.one')).record, world.timeline[0].payload.record);
    check(`${prefix}.delayed-post-absent`, (await read('/v1/collections/social.posts')).data.length === 0);
    advanceClock(db, 1999, {now});
    check(`${prefix}.delay-kept`, (await playDue(db, context, {now})).length === 0);
    advanceClock(db, 1, {now});
    const effects = await playDue(db, context, {now});
    check(`${prefix}.delayed-post`, effects[0]?.status === 'delivered');
    check(`${prefix}.comment`, effects.length === 2 && effects[1]?.status === 'delivered');
    const journal = await read('/v1/events');
    check(`${prefix}.exact-api-writes`, journal.data.length === 3);
    const events = eventsAfter(db, 0);
    const accepted = events.filter(event => event.source === 'domain');
    check(`${prefix}.accepted-events`, accepted.length === 3);
    check(`${prefix}.world-time`, accepted[0].occurred_at === '2031-01-01T00:00:01.000Z' && accepted.slice(1).every(event => event.occurred_at === '2031-01-01T00:00:03.000Z'));
    check(`${prefix}.caused-by`, accepted[1].caused_by === accepted[0].id && accepted[2].caused_by === accepted[1].id);
    check(`${prefix}.bounded-cycle`, events.filter(event => event.type === 'world.causal.effect.rejected.v1').length === 1);
    const commands = db.prepare('SELECT id,actor_id,status,event_id FROM commands ORDER BY rowid').all();
    check(`${prefix}.command-acceptance`, commands.length === 3 && commands.every(command => command.actor_id === 'person.one' && command.status === 'accepted' && accepted.some(event => event.id === command.event_id)));
    check(`${prefix}.drained`, pending(db).length === 0 && (await playDue(db, context, {now})).length === 0);
    report.cycles.push({events, commands});
    if (cycle === 0) {
      await instance.reset();
      check('reset.runtime-events-cleared', eventsAfter(db, 0).length === 0);
      check('reset.timeline-rearmed', pending(db).length === 1);
    }
  }
  console.log(JSON.stringify(report));
} finally { await instance.stop(); }
