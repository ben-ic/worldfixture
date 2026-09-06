import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '@emulators/core';
import { githubPlugin, seedFromConfig } from '@emulators/github';
import { extendGitHubWorldApi } from './github-world-api.mjs';
import { seedGitHubIssues } from './github-issues.mjs';

const config = { users: [{ login: 'river', name: 'River' }, { login: 'lake', name: 'Lake' }],
  orgs: [{ login: 'first', name: 'First', description: 'First declared organization' }, { login: 'second', name: 'Second', description: 'External declared organization' }],
  repos: [
    { owner: 'first', name: 'shared', auto_init: false, collaborators: [{ username: 'river', permission: 'push' }], issues: [{ number: 1, title: 'Same title', author: 'river', assignees: ['lake'], labels: ['needs-review', 'priority-high'] }] },
    { owner: 'first', name: 'other', auto_init: false, collaborators: [], issues: [] },
    { owner: 'second', name: 'shared', auto_init: false, collaborators: [{ username: 'lake', permission: 'pull' }], issues: [{ number: 1, title: 'Same title', author: 'lake', labels: ['external'] }] },
  ] };
function fixture(value = config) {
  const server = createServer(extendGitHubWorldApi(githubPlugin), { tokens: { current: { login: 'river', id: 1, scopes: ['repo', 'read:org'] } } });
  seedFromConfig(server.store, server.baseUrl, value); seedGitHubIssues(server.store, value); return server;
}
const read = (app, path) => app.request(path, { headers: { authorization: 'Bearer current' } });
test('normal GitHub seed serves each declared organization, repository, label, assignee, and collaborator', async () => {
  const { app } = fixture();
  const org = await read(app, '/orgs/second'); assert.equal(org.status, 200); assert.equal((await org.json()).description, 'External declared organization');
  const page = await read(app, '/orgs/first/repos?per_page=1'); assert.equal(page.status, 200); assert.match(page.headers.get('link'), /page=2.*rel="next"/);
  const first = await page.json(), second = await (await read(app, '/orgs/first/repos?per_page=1&page=2')).json();
  assert.deepEqual([...first, ...second].map(row => row.full_name).sort(), ['first/other', 'first/shared']);
  assert.equal(first[0].owner.type, 'Organization');
  const issue = await (await read(app, '/repos/first/shared/issues/1')).json();
  assert.deepEqual(issue.labels.map(row => row.name), ['needs-review', 'priority-high']); assert.deepEqual(issue.assignees.map(row => row.login), ['lake']);
  const other = await (await read(app, '/repos/second/shared/issues/1')).json(); assert.deepEqual(other.labels.map(row => row.name), ['external']); assert.equal(other.user.login, 'lake');
  assert.deepEqual((await (await read(app, '/repos/first/shared/collaborators')).json()).map(row => row.login), ['river']);
  assert.deepEqual(await (await read(app, '/repos/first/other/collaborators')).json(), []);
  assert.equal((await read(app, '/orgs/unknown/repos')).status, 404); assert.equal((await read(app, '/orgs/first/repos?page=0')).status, 400);
});
test('GitHub organization list uses native private-repository authorization', async () => {
  const { app } = fixture({ ...config, repos: [{ owner: 'first', name: 'private', private: true, auto_init: false }] });
  const response = await app.request('/orgs/first/repos'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), []);
});
test('GitHub seed refuses unresolved collaborators and duplicate source issue numbers', () => {
  assert.throws(() => fixture({ ...config, repos: [{ ...config.repos[0], collaborators: [{ username: 'missing', permission: 'push' }] }] }), /unknown collaborator/);
  assert.throws(() => fixture({ ...config, repos: [{ ...config.repos[0], issues: [config.repos[0].issues[0], config.repos[0].issues[0]] }] }), /declared more than once/);
});
