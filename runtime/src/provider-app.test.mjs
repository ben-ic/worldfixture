import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadManifests } from './manifests.mjs';
import { resolveEnvironment } from './resolve.mjs';
import { start } from './supervisor.mjs';
import { attachTimelineControl } from './timeline-control.mjs';

const ROOT = join(import.meta.dirname, '../..');

// The application keeps its original bindings across provider reset. It imports
// no WorldFixture modules and accesses provider state only through HTTP.
const APP = `
process.on('message', async ({provider, path, method = 'GET', body}) => {
  try {
    const base = process.env[provider + '_BASE_URL'];
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin) throw new Error('Foreign provider origin');
    const response = await fetch(url, { method, signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Bearer ' + process.env[provider + '_TOKEN'], 'content-type': 'application/json',
        ...(provider === 'NOTION' ? {'Notion-Version': '2026-03-11'} : {}) },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
    const text = await response.text();
    process.send({pid: process.pid, status: response.status, link: response.headers.get('link'),
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text});
  } catch (error) { process.send({error: error.message}); }
});
`;

test('a live HTTP application reads pages, runs provider workflows, and survives timeline reset', { timeout: 120000 }, async t => {
  const artifactPath = join(ROOT, 'dist/business.saas-company.v3');
  const world = JSON.parse(readFileSync(join(artifactPath, 'world.json'), 'utf8'));
  const person = world.people.find(row => row.primary);
  const profiles = { GITHUB: 'github.repositories.v1', SLACK: 'slack.messaging.v1', NOTION: 'notion.pages-read.v1' };
  const lock = resolveEnvironment({
    api_version: 'worldfixture.environment/v1', world: { use: `${world.id}:${world.version}` },
    requires: [...Object.values(profiles), 'github.issues.v1', 'notion.blocks-read.v1'],
    execution: { mode: 'selected-capabilities' },
    bindings: Object.fromEntries(Object.entries(profiles).flatMap(([name, profile]) => [
      [`${name}_BASE_URL`, `${profile}/base_url`], [`${name}_TOKEN`, `${profile}/token`],
    ])),
    target: { kind: 'none', identity: person.id },
  }, { manifests: loadManifests(join(ROOT, 'emulators')), artifactPath });
  const stateDir = mkdtempSync(join(tmpdir(), 'worldfixture-provider-app-'));
  let instance, app;
  t.after(async () => {
    if (app && app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit'); app.kill('SIGKILL'); await exited;
    }
    await instance?.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });
  instance = await start(lock, { artifactPath, serviceRoot: join(ROOT, 'emulators'), stateDir,
    runner: 'process', manageSignals: false, readyTimeoutMs: 30000 });
  const bindings = instance.bindings();
  assert.deepEqual(lock.services.find(row => row.name === 'emulate').ports.map(row => row.name).sort(), ['github', 'notion', 'slack']);
  const control = attachTimelineControl(instance, world, { bindings, credentials: instance.credentials, rules: [], tickMs: 3600000 });
  await control.initialize({ setup: true });
  app = spawn(process.execPath, ['--input-type=module', '-e', APP], { env: { ...process.env, ...bindings }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  async function call(provider, path, method = 'GET', body, status = 200) {
    const message = once(app, 'message', { signal: AbortSignal.timeout(15000) });
    app.send({ provider, path, method, body });
    const [result] = await message;
    assert.equal(result.error, undefined);
    assert.equal(result.pid, app.pid, 'The same application process must serve every request');
    assert.equal(result.status, status, `${provider} ${method} ${path}`);
    if (provider === 'SLACK') assert.equal(result.body.ok, true);
    return result;
  }
  async function cursorPages(provider, path, field, input, size = 2) {
    const rows = [], cursors = new Set();
    let cursor;
    for (;;) {
      const params = provider === 'NOTION'
        ? { page_size: size, ...(cursor ? { start_cursor: cursor } : {}) }
        : { limit: size, ...(cursor ? { cursor } : {}) };
      const { body } = await call(provider, path, 'POST', { ...input, ...params });
      assert.ok(Array.isArray(body[field])); rows.push(...body[field]);
      const next = provider === 'NOTION' ? body.next_cursor : body.response_metadata?.next_cursor;
      if (!next) { assert.notEqual(body.has_more, true); return rows; }
      assert.ok(!cursors.has(next), 'Cursor must progress'); cursors.add(next); cursor = next;
      assert.ok(cursors.size < 1000);
    }
  }
  const repositories = [], links = new Set();
  let path = `/orgs/${encodeURIComponent(person.organization_id)}/repos?per_page=2`;
  while (path) {
    assert.ok(!links.has(path)); links.add(path);
    const response = await call('GITHUB', path); repositories.push(...response.body);
    path = response.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  assert.ok(links.size > 1, 'GitHub discovery must cross a page boundary');
  assert.equal(new Set(repositories.map(row => row.id)).size, repositories.length);
  const allRepositories = await call('GITHUB', `/orgs/${encodeURIComponent(person.organization_id)}/repos?per_page=100`);
  assert.ok(!allRepositories.link?.includes('rel="next"'));
  assert.deepEqual(repositories.map(row => row.id), allRepositories.body.map(row => row.id));
  const channels = await cursorPages('SLACK', '/api/conversations.list', 'channels', { types: 'public_channel', exclude_archived: true });
  assert.ok(channels.length > 2);
  assert.equal(new Set(channels.map(row => row.id)).size, channels.length);
  const allChannels = (await call('SLACK', '/api/conversations.list', 'POST', { types: 'public_channel', exclude_archived: true, limit: 100 })).body;
  assert.ok(!allChannels.response_metadata?.next_cursor);
  assert.deepEqual(channels.map(row => row.id), allChannels.channels.map(row => row.id));
  const channel = channels.find(row => row.is_member && !row.is_archived && !row.is_private);
  assert.ok(channel);
  const pages = await cursorPages('NOTION', '/v1/search', 'results', { filter: { property: 'object', value: 'page' } });
  assert.ok(pages.length > 2);
  assert.equal(new Set(pages.map(row => row.id)).size, pages.length);
  const allPages = (await call('NOTION', '/v1/search', 'POST', { filter: { property: 'object', value: 'page' }, page_size: 100 })).body;
  assert.equal(allPages.has_more, false);
  assert.deepEqual(pages.map(row => row.id), allPages.results.map(row => row.id));
  for (const page of pages) {
    const url = new URL(page.url);
    assert.equal(url.protocol, 'http:');
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.equal(url.port, new URL(bindings.NOTION_BASE_URL).port);
  }
  const page = pages[0];
  const originalPage = (await call('NOTION', `/v1/pages/${page.id}`)).body;
  assert.equal(originalPage.url, page.url);
  const hosted = await fetch(page.url, { signal: AbortSignal.timeout(10000) });
  assert.equal(hosted.status, 200);
  assert.match(await hosted.text(), /<!doctype html>/i);
  const blocks = []; let blockCursor;
  const blockCursors = new Set();
  do {
    const query = new URLSearchParams({ page_size: '1', ...(blockCursor ? { start_cursor: blockCursor } : {}) });
    const { body } = await call('NOTION', `/v1/blocks/${page.id}/children?${query}`);
    blocks.push(...body.results); blockCursor = body.next_cursor;
    if (body.has_more) assert.ok(blockCursor);
    if (blockCursor) { assert.ok(!blockCursors.has(blockCursor)); blockCursors.add(blockCursor); }
  } while (blockCursor);
  assert.ok(blockCursors.size > 0, 'Block reads must cross a page boundary');
  const allBlocks = (await call('NOTION', `/v1/blocks/${page.id}/children?page_size=100`)).body;
  assert.equal(allBlocks.has_more, false);
  assert.deepEqual(blocks.map(row => row.id), allBlocks.results.map(row => row.id));
  const text = blocks.flatMap(block => block[block.type]?.rich_text ?? []).map(part => part.plain_text ?? part.text?.content ?? '').join('\n');
  assert.ok(text.length > 0);
  const repo = repositories[0].full_name;
  const issues = (await call('GITHUB', `/repos/${repo}/issues?state=open&per_page=100`)).body;
  const posted = (await call('SLACK', '/api/chat.postMessage', 'POST', { channel: channel.id, text: `Integration check: ${repo} has ${issues.length} open issues on this page.` })).body;
  const messages = await cursorPages('SLACK', '/api/conversations.history', 'messages', { channel: channel.id }, 100);
  assert.ok(messages.some(row => row.ts === posted.ts && row.text === posted.message.text));
  const created = (await call('GITHUB', `/repos/${repo}/issues`, 'POST', { title: 'Integration check: Notion page', body: `${page.id}\n${text}` }, 201)).body;
  assert.equal((await call('GITHUB', `/repos/${repo}/issues/${created.number}`)).body.body, created.body);

  const arrival = world.timeline.find(row => row.kind === 'chat-message' && lock.execution.timeline.active.includes(row.id));
  assert.ok(arrival);
  const sourceChannel = world.communication.channels.find(row => row.id === arrival.payload.channel_id);
  const arrivalChannel = channels.find(row => row.name === sourceChannel.name);
  assert.ok(arrivalChannel?.is_member);
  const arrivalMessages = () => cursorPages('SLACK', '/api/conversations.history', 'messages', { channel: arrivalChannel.id }, 100);
  assert.equal((await arrivalMessages()).filter(row => row.text === arrival.payload.text).length, 0);
  await control.command({ action: 'start', duration: `${arrival.after_seconds}s` });
  await control.command({ action: 'pause' });
  assert.equal((await arrivalMessages()).filter(row => row.text === arrival.payload.text).length, 1);
  await instance.reset();
  assert.equal(app.exitCode, null);
  await call('GITHUB', `/repos/${repo}/issues/${created.number}`, 'GET', undefined, 404);
  assert.equal((await cursorPages('SLACK', '/api/conversations.history', 'messages', { channel: channel.id }, 100)).some(row => row.ts === posted.ts), false);
  assert.equal((await arrivalMessages()).filter(row => row.text === arrival.payload.text).length, 0);
  assert.deepEqual((await call('NOTION', `/v1/pages/${page.id}`)).body, originalPage);
});
