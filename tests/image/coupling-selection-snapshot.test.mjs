import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SELECTION_PATHS, snapshot } from './coupling-selection-snapshot.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-selection-snapshot-'));
  t.after(() => {
    const privateDirectory = join(root, 'state/domain');
    if (existsSync(privateDirectory)) chmodSync(privateDirectory, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('selection evidence excludes private provider trees but detects selected changes', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'state/domain'), { recursive: true });
  writeFileSync(join(root, 'state/domain/private.json'), 'provider data');
  chmodSync(join(root, 'state/domain'), 0o000);
  for (const name of ['project', 'state/input-world', 'selected-build']) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'world.json'), 'original');
  }
  writeFileSync(join(root, 'state/instance.json'), '{}');
  const before = snapshot(root, SELECTION_PATHS);
  assert.deepEqual(Object.keys(before).sort(), [
    'project/world.json', 'selected-build/world.json', 'state/input-world/world.json', 'state/instance.json',
  ]);
  writeFileSync(join(root, 'project/world.json'), 'changed');
  const after = snapshot(root, SELECTION_PATHS);
  assert.notEqual(before['project/world.json'].sha256, after['project/world.json'].sha256);
  assert.deepEqual(before['state/instance.json'], after['state/instance.json']);
});

test('negative selection evidence still detects new files and directories', t => {
  const root = fixture(t), before = snapshot(root);
  mkdirSync(join(root, 'state'));
  writeFileSync(join(root, 'state/unexpected.json'), '{}');
  const after = snapshot(root);
  assert.notDeepEqual(after, before);
  assert.equal(after.state.directory, true);
  assert.ok(after['state/unexpected.json'].sha256);
});
