// Creates its own short-lived projects. Never resets the user's demo project.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, symlink, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const image = process.env.ACCOUNT_DESK_TEST_IMAGE || 'worldfixture:account-desk';
const { stdout: imageId } = await exec('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
const exactImage = imageId.trim();
if (!/^sha256:[a-f0-9]{64}$/.test(exactImage)) throw new Error('The local test image must have an exact SHA-256 ID.');
const pkg = JSON.parse(await readFile(join(root, 'node_modules/worldfixture/package.json'), 'utf8'));
const workspace = await mkdtemp(join(tmpdir(), 'account-desk-database-matrix-'));
console.log(`Isolated database test projects: ${workspace}`);
console.log(`Installed WorldFixture ${pkg.version}; image ${exactImage}`);
const report = { testedAt: new Date().toISOString(), image: exactImage, cliVersion: pkg.version, workspace, profiles: [] };
const cleanEnvironment = { ...process.env };
for (const key of Object.keys(cleanEnvironment)) {
  if (/^(?:WORLDFIXTURE_|POSTGRES_|MYSQL_|ACCOUNT_DESK_DATABASE|ACCOUNT_DESK_STORAGE_)/.test(key)) delete cleanEnvironment[key];
}
for (const provider of ['postgres', 'mysql']) {
  const directory = join(workspace, provider);
  await mkdir(join(directory, '.worldfixture'), { recursive: true });
  await mkdir(join(directory, 'src/db'), { recursive: true });
  await mkdir(join(directory, 'tests'), { recursive: true });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await copyFile(join(root, 'src/db/store.mjs'), join(directory, 'src/db/store.mjs'));
  await copyFile(join(root, 'tests/storage-live.mjs'), join(directory, 'tests/storage-live.mjs'));
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: `account-desk-${provider}-test`, private: true, type: 'module' })}\n`);
  await writeFile(join(directory, '.worldfixture/project.json'), `${JSON.stringify({ api_version: 'worldfixture.project/v1', services: [provider], application_url: 'http://127.0.0.1:15175' })}\n`);
  const env = { ...cleanEnvironment, ACCOUNT_DESK_DATABASE: provider, ACCOUNT_DESK_STORAGE_TEST_ID: randomUUID() };
  const profile = { provider, project: directory, checks: [], cleanup: false };
  report.profiles.push(profile);
  let startAttempted = false;
  async function cli(args, extra = {}) {
    try {
      return await exec('npx', ['--no-install', 'worldfixture', ...args], { cwd: directory, env: { ...env, ...extra }, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      // Do not print generated binding values, credentials, or raw CLI output.
      throw new Error(`${provider}: npx worldfixture ${args[0]} failed (${error.code || 'unknown exit'}).`);
    }
  }
  try {
    console.log(`${provider}: start isolated world`);
    startAttempted = true;
    await cli(['up', '--image', exactImage, '--only', 'site']);
    profile.checks.push('Public npx start with installed CLI and exact local image');
    const before = await cli(['run', '--', 'node', 'tests/storage-live.mjs'], { ACCOUNT_DESK_STORAGE_PHASE: 'before-reset' });
    if (!before.stdout.includes('isolated record retained')) throw new Error(`${provider}: the before-reset test did not confirm persistence.`);
    profile.checks.push('Wrong password refused; create/read/update; transaction rollback; reconnect');
    console.log(`${provider}: database checks passed; reset only ${directory}`);
    await cli(['reset']);
    const after = await cli(['run', '--', 'node', 'tests/storage-live.mjs'], { ACCOUNT_DESK_STORAGE_PHASE: 'after-reset' });
    if (!after.stdout.includes('reset preservation')) throw new Error(`${provider}: reset preservation was not confirmed.`);
    profile.checks.push('World reset preserves app record; exact test namespace cleanup');
    profile.status = 'passed';
    console.log(`${provider}: reset preservation and cleanup passed`);
  } catch (error) {
    profile.status = 'failed';
    profile.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (startAttempted) {
      try { await cli(['down']); profile.cleanup = true; console.log(`${provider}: stopped only its isolated test instance`); }
      catch (error) { profile.cleanupError = error.message; process.exitCode = 1; console.error(`Cleanup failed. Inspect only the test project: ${directory}`); }
    }
    await writeFile(join(workspace, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
}
console.log(`Database evidence: ${join(workspace, 'report.json')}`);
