import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeFile, activeStateDir, readActiveGeneration, writeSessionJson } from './session-files.mjs';
import { hostBindings, hostAddresses } from './host-launcher.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-session-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(path, value) { writeFileSync(path, JSON.stringify(value)); }

test('session writes keep private permissions and retain the prior value on serialization failure', t => {
  const root = fixture(t), path = join(root, 'active.json');
  writeSessionJson(path, { generation: 'accepted' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const invalid = {}; invalid.self = invalid;
  assert.throws(() => writeSessionJson(path, invalid));
  assert.deepEqual(JSON.parse(readFileSync(path)), { generation: 'accepted' });
  const directory = join(root, 'blocked.json'); mkdirSync(directory);
  assert.throws(() => writeSessionJson(directory, { generation: 'candidate' }));
  assert.deepEqual(readdirSync(root).sort(), ['active.json', 'blocked.json']);
});

test('active paths follow a new generation and reject the transition instead of old ready files', t => {
  const root = fixture(t);
  assert.equal(activeStateDir(root), root);
  write(join(root, 'bindings.json'), { SLACK_TOKEN: 'old-root-token' });
  const active = { api_version: 'worldfixture.active-generation/v1', generation: 'generation-b', phase: 'ready',
    artifactPath: join(root, 'generations/b/world'), stateDir: join(root, 'generations/b/runtime') };
  write(join(root, 'active-generation.json'), active);
  assert.equal(activeFile(root, 'bindingsPath', 'bindings.json'), join(active.stateDir, 'bindings.json'));
  assert.equal(readActiveGeneration(root).generation, 'generation-b');
  write(join(root, 'active-generation.json'), { ...active, phase: 'switching' });
  assert.throws(() => activeStateDir(root), /not ready/);
  assert.equal(readActiveGeneration(root, { allowTransition: true }).generation, 'generation-b');
});

test('host bindings use the committed generation and existing host ports after a picker switch', t => {
  const root = fixture(t), runtime = join(root, 'generations/b/runtime'); mkdirSync(runtime, { recursive: true });
  const ports = [{ containerPort: 4703, hostPort: 35401, name: 'slack' }];
  write(join(root, 'instance.json'), { ports });
  write(join(root, 'host-bindings.json'), { SLACK_TOKEN: 'stale-token' });
  write(join(runtime, 'bindings.json'), { SLACK_BASE_URL: 'http://127.0.0.1:4703', SLACK_TOKEN: 'new-generation-token' });
  write(join(runtime, 'addresses.json'), { 'emulate/slack': { host: '127.0.0.1', port: 4703 } });
  const active = { api_version: 'worldfixture.active-generation/v1', generation: 'b', phase: 'ready',
    artifactPath: '/state/generations/b/world', stateDir: '/state/generations/b/runtime' };
  write(join(root, 'active-generation.json'), active);
  assert.deepEqual(hostBindings(root), { SLACK_BASE_URL: 'http://127.0.0.1:35401', SLACK_TOKEN: 'new-generation-token' });
  assert.deepEqual(hostAddresses(root), { 'emulate/slack': { host: '127.0.0.1', port: 35401 } });
  write(join(root, 'active-generation.json'), { ...active, phase: 'switching' });
  assert.equal(hostBindings(root), null); assert.equal(hostAddresses(root), null);
});
