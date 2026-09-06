import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '@emulators/core';
import { slackPlugin, seedFromConfig } from '@emulators/slack';
import { seedSlackWorld } from './slack-world-seed.mjs';
import { seedSlackHistory } from './slack-history.mjs';

const config = { team: { name: 'Declared Team', domain: 'declared-team' }, users: [{ name: 'river', email: 'river@declared.test' }],
  channels: [{ name: 'empty', members: [], messages: [] }, { name: 'declared', members: ['river'], messages: [] }] };
function fixture(value = config) {
  const server = createServer(slackPlugin, { tokens: { current: { login: 'river', id: 1, scopes: ['team:read', 'users:read', 'channels:read'] } } });
  seedSlackWorld(seedFromConfig, server.store, server.baseUrl, value);
  seedSlackHistory(server.store, value);
  return server;
}
async function read(app, method, payload = {}) {
  const response = await app.request(`/api/${method}`, { method: 'POST', headers: { authorization: 'Bearer current', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const value = await response.json(); assert.equal(value.ok, true); return value;
}
test('normal Slack seed serves the declared team and no sample identities or channels', async () => {
  const { app } = fixture(), again = fixture();
  const team = (await read(app, 'team.info')).team;
  assert.equal(team.name, config.team.name); assert.equal(team.domain, config.team.domain); assert.notEqual(team.id, 'T000000001');
  assert.equal((await read(again.app, 'team.info')).team.id, team.id);
  const users = await read(app, 'users.list'); assert.deepEqual(users.members.map(row => row.name), ['river']);
  const channels = (await read(app, 'conversations.list')).channels;
  assert.deepEqual(channels.map(row => row.name).sort(), ['declared', 'empty']);
  const empty = channels.find(row => row.name === 'empty'); assert.deepEqual((await read(app, 'conversations.members', { channel: empty.id })).members, []);
  const populated = channels.find(row => row.name === 'declared'); assert.equal((await read(app, 'conversations.members', { channel: populated.id })).members.length, 1);
});
test('Slack refuses missing team declarations and unresolved declared memberships', () => {
  for (const value of [{}, { team: { name: 'Name' } }, { team: { name: 'Name', domain: 'test', id: 'invalid' } }]) assert.throws(() => fixture(value), /Slack/);
  assert.throws(() => fixture({ ...config, channels: [{ name: 'unknown', members: ['missing'] }] }), /unknown declared member/);
});

test('declared standalone bots are discoverable through users.list and bots.info without extra memberships', async () => {
  const value = { ...config, bots: [{ name: 'declared-helper' }] };
  const server = fixture(value), { app } = server;
  const users = (await read(app, 'users.list')).members;
  assert.deepEqual(users.filter(row => !row.is_bot).map(row => row.name), ['river']);
  const bots = users.filter(row => row.is_bot);
  assert.equal(bots.length, 1); assert.equal(bots[0].name, 'declared-helper');
  const bot = (await read(app, 'bots.info', { bot: bots[0].profile.bot_id })).bot;
  assert.equal(bot.name, 'declared-helper'); assert.equal(bot.deleted, false);
  const channels = (await read(app, 'conversations.list')).channels;
  for (const channel of channels) assert.ok(!(await read(app, 'conversations.members', { channel: channel.id })).members.includes(bots[0].id));
  seedSlackWorld(seedFromConfig, server.store, server.baseUrl, value);
  assert.equal((await read(app, 'users.list')).members.length, 2);
  assert.throws(() => fixture({ ...config, bots: [{ name: 'river' }] }), /conflicts with another user/);
});
