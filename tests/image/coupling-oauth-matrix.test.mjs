import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { prepareOAuthVariant, runOAuthMatrix } from './coupling-oauth-matrix.mjs';
import { defaultEnvironment } from '../../runtime/src/environments.mjs';
import { loadManifests } from '../../runtime/src/manifests.mjs';
import { resolveEnvironment } from '../../runtime/src/resolve.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

test('frozen OAuth source variants are reproducible, preserve source data, and cannot overwrite evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'oauth-matrix-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = resolve('worlds/business.saas-company.v2/world.json');
  const original = readFileSync(sourcePath);
  const one = await prepareOAuthVariant({ sourcePath, outputPath: join(root, 'first') });
  const two = await prepareOAuthVariant({ sourcePath, outputPath: join(root, 'second') });
  assert.equal(one.artifact.identity.digest, two.artifact.identity.digest);
  assert.notEqual(one.evidence.baseline_identity.digest, one.artifact.identity.digest);
  assert.deepEqual(readFileSync(sourcePath), original);
  assert.equal(one.evidence.original_entry_sha256, sha(readFileSync(one.evidence.original_entry_path)));
  assert.equal(one.evidence.preserved_source_fields, true);
  assert.equal(Object.keys(one.artifact.world.software.oauth_clients).length, 9);
  assert.ok(one.artifact.checks.every(row => row.status === 'passed'));
  await assert.rejects(prepareOAuthVariant({ sourcePath, outputPath: join(root, 'first') }), /already exists/);
});

test('prepare-only records absence of live proof and retains the original report', async t => {
  const root = mkdtempSync(join(tmpdir(), 'oauth-matrix-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = { sourcePaths: [resolve('worlds/consumer.retail-brand.v1/world.json')], reportPath: root, prepareOnly: true };
  const report = await runOAuthMatrix(args);
  assert.equal(report.status, 'prepared');
  assert.equal(report.cases[0].responses.length, 0);
  assert.equal(report.cases[0].coverage.length, 0);
  assert.match(report.cases[0].scope, /no live API proof/);
  const artifactPath = join(root, 'world-0/artifact');
  const world = JSON.parse(readFileSync(join(artifactPath, 'world.json')));
  assert.equal(world.software.repositories, undefined);
  const manifests = loadManifests(resolve('emulators'));
  const environment = defaultEnvironment(`${world.id}:${world.version}`, {
    artifactPath, manifests, includeProviders: true, includeS3: true,
    oauthClients: world.software.oauth_clients,
  });
  const lock = resolveEnvironment(environment, { artifactPath, manifests });
  assert.ok(lock.capabilities['github.oauth.v1']);
  assert.equal(lock.capabilities['github.repositories.v1'], undefined);
  assert.equal(environment.bindings.GITHUB_BASE_URL, 'github.oauth.v1/base_url');
  assert.equal(environment.bindings.GITHUB_TOKEN, 'github.oauth.v1/token');
  assert.equal(environment.bindings.GITHUB_CLIENT_ID, 'github.oauth.v1/client_id');
  assert.equal(environment.bindings.GITHUB_CLIENT_SECRET, 'github.oauth.v1/client_secret');
  const before = readFileSync(join(root, 'report.json'));
  await assert.rejects(runOAuthMatrix(args), /overwrite/);
  assert.deepEqual(readFileSync(join(root, 'report.json')), before);
});
