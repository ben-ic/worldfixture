import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostOwnership } from './host-state-ownership.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'wf-host-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('direct mode and paths outside the state mount require no filesystem access', () => {
  assert.equal(createHostOwnership({ enabled: false })('/state/missing.json'), false);
  const share = createHostOwnership({ enabled: true, roots: ['/missing-state-mount'] });
  assert.equal(share('/missing-state-mount-neighbour/bindings.json'), false);
  assert.equal(share('/service/state.sqlite'), false);
});

test('metadata ownership preserves private directory and file modes', t => {
  const root = fixture(t), directory = join(root, 'generation'), path = join(directory, 'credentials.json');
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path, '{}', { mode: 0o600 });
  const share = createHostOwnership({ enabled: true, roots: [root] });
  assert.equal(share(path), true);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(path).uid, statSync(root).uid);
  assert.equal(statSync(path).gid, statSync(root).gid);
});

test('ownership refuses both linked files and linked ancestors', t => {
  const root = fixture(t), outside = fixture(t), path = join(outside, 'credentials.json');
  writeFileSync(path, '{}', { mode: 0o600 });
  const before = statSync(path);
  symlinkSync(path, join(root, 'linked-file'));
  symlinkSync(outside, join(root, 'linked-directory'));
  const share = createHostOwnership({ enabled: true, roots: [root] });
  assert.throws(() => share(join(root, 'linked-file')), /must not contain a symlink/);
  assert.throws(() => share(join(root, 'linked-directory/credentials.json')), /must not contain a symlink/);
  assert.equal(statSync(path).uid, before.uid);
  assert.equal(statSync(path).gid, before.gid);
  assert.equal(statSync(path).mode, before.mode);
});
