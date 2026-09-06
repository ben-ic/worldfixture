// Explicit source variants exercise OAuth without adding applications to shipped
// worlds. Each image run uses the normal compiler, startup, and reset route.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { loadArtifact, collectionCoverage, inventoryCollections } from './coupling-artifacts.mjs';
import { probeDeclaredOAuthWorld, testOAuthDeclarations } from './coupling-oauth-probes.mjs';
import { workbenchRequestReader } from './clock-world-test.mjs';
import { containerArguments, credentialValues, docker, mappedBindings, pauseRunClock, readRunBindings, readRunCredentialSet, redact, removeOwnedContainer, waitForReady } from './coupling-runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), execute = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const failed = (check, error) => ({ check, status: 'failed', detail: error.message ?? String(error) });
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

export async function prepareOAuthVariant({ sourcePath, outputPath, python = process.env.PYTHON ?? 'python3', signal }) {
  const source = resolve(sourcePath), output = resolve(outputPath);
  if (existsSync(output)) throw new Error(`OAuth output already exists: ${output}`);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const captured = join(output, 'source');
  cpSync(dirname(source), captured, { recursive: true, dereference: false });
  const entryPath = join(captured, basename(source));
  const before = readFileSync(entryPath);
  writeFileSync(join(output, 'original-source-entry.json'), before, { mode: 0o600 });
  const command = ['-m', 'worldfixture_compiler', 'build', entryPath];
  const options = { cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, 'compiler') }, maxBuffer: 4 * 1024 * 1024, signal };
  const baselinePath = join(output, 'baseline-artifact');
  await execute(python, [...command, '--output', baselinePath], options);
  const baseline = loadArtifact(baselinePath);
  if (baseline.checks.some(row => row.status === 'failed')) throw new Error('Baseline artifact integrity failed');
  if (Object.hasOwn(baseline.world.software ?? {}, 'oauth_clients')) throw new Error('This test source extension requires a source with no existing software.oauth_clients declaration');
  const declarations = testOAuthDeclarations(baseline.world);
  const entry = JSON.parse(before);
  const fragmentPath = 'packs/coupling-oauth-applications.json';
  if (existsSync(join(captured, fragmentPath))) throw new Error('The captured source already contains the test OAuth fragment');
  mkdirSync(join(captured, 'packs'), { recursive: true });
  const fragment = { api_version: 'worldfixture.world-fragment/v1', id: 'pack.coupling-oauth-applications', contributes: { software: { oauth_clients: declarations } } };
  json(join(captured, fragmentPath), fragment);
  entry.fragments = [...entry.fragments ?? [], fragmentPath];
  json(entryPath, entry);
  const artifactPath = join(output, 'artifact');
  await execute(python, [...command, '--output', artifactPath], options);
  const artifact = loadArtifact(artifactPath);
  if (artifact.checks.some(row => row.status === 'failed')) throw new Error('OAuth variant artifact integrity failed');
  const unchanged = structuredClone(artifact.world);
  delete unchanged.software.oauth_clients;
  if (JSON.stringify(unchanged) !== JSON.stringify(baseline.world)) throw new Error('OAuth source extension changed unrelated compiled source fields');
  if (artifact.identity.digest === baseline.identity.digest) throw new Error('OAuth variant must have its own artifact digest');
  const evidence = { source_path: source, captured_source_path: entryPath,
    original_entry_path: join(output, 'original-source-entry.json'), original_entry_sha256: sha(before), variant_entry_sha256: sha(readFileSync(entryPath)),
    baseline_identity: baseline.identity, variant_identity: artifact.identity,
    baseline_manifest: baseline.manifest, variant_manifest: artifact.manifest,
    source_change: { field: 'software.oauth_clients', fragment_path: fragmentPath, fragment_sha256: sha(readFileSync(join(captured, fragmentPath))), declarations },
    preserved_source_fields: true, scope: 'Explicit test applications exist only in this frozen source variant. No shipped default is changed.' };
  json(join(output, 'source-evidence.json'), evidence);
  return { artifact, evidence };
}

export async function runOAuthMatrix({ sourcePaths, image, reportPath, python, prepareOnly = false, readyTimeoutMs = 180000, signal }) {
  if (!sourcePaths?.length) throw new Error('At least one explicit --source world.json is required');
  const directory = resolve(reportPath);
  if (existsSync(join(directory, 'report.json'))) throw new Error('Refusing to overwrite an existing OAuth report');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const report = { api_version: 'worldfixture.oauth-matrix/v1', started_at: new Date().toISOString(), image, cases: [], checks: [],
    scope: 'Explicit frozen source variants; nine declared test applications. Public OAuth clients, source primary user identity, exact redirects, generated credentials, and normal reset. Shipped source identity coverage is unchanged.' };
  const save = () => json(join(directory, 'report.json'), report);
  const owner = randomBytes(12).toString('hex');
  let imageId, exposedPorts;
  try {
    if (!prepareOnly) {
      if (!image) throw new Error('--image is required for a live OAuth matrix');
      const [inspection] = JSON.parse((await docker(['image', 'inspect', image])).stdout);
      imageId = inspection.Id; exposedPorts = Object.keys(inspection.Config.ExposedPorts ?? {});
      report.image_id = imageId;
    }
    for (const [index, sourcePath] of sourcePaths.entries()) {
      signal?.throwIfAborted();
      const item = { source_path: resolve(sourcePath), checks: [], responses: [], coverage: [] };
      report.cases.push(item);
      const name = `wf-oauth-${owner}-${index}`;
      let secrets = [];
      try {
        const { artifact, evidence } = await prepareOAuthVariant({ sourcePath, outputPath: join(directory, `world-${index}`), python, signal });
        item.source_evidence = evidence; item.identity = artifact.identity;
        item.checks.push({ check: 'oauth.source-variant-integrity', status: 'passed' });
        if (prepareOnly) { item.scope = 'Prepared and verified source variant only; no live API proof'; continue; }
        console.log(`${artifact.identity.id}:${artifact.identity.version}: starting explicit OAuth source variant`);
        await docker(containerArguments({ image: imageId, artifactPath: artifact.path, name, owner, exposedPorts }), { timeout: 60000, signal });
        await waitForReady(name, { timeoutMs: readyTimeoutMs, signal });
        item.checks.push({ check: 'oauth.world-boot', status: 'passed' });
        await pauseRunClock(name);
        const [inspection] = JSON.parse((await docker(['inspect', name])).stdout);
        const bindings = mappedBindings(await readRunBindings(name), inspection.NetworkSettings.Ports);
        const credentials = await readRunCredentialSet(name);
        const workbench = await workbenchRequestReader(bindings.WORKBENCH_URL, item.responses, { signal, timeoutMs: 180000 });
        secrets = [...credentialValues(bindings), ...Object.values(credentials.values)];
        const lock = JSON.parse((await docker(['exec', name, 'node', '-e', "process.stdout.write(require('node:fs').readFileSync('/state/environment.lock.json','utf8'))"])).stdout);
        if (lock.world.id !== artifact.identity.id || lock.world.version !== artifact.identity.version || lock.world.artifact_sha256 !== artifact.identity.digest) throw new Error('Live world identity/digest differs from the frozen OAuth artifact');
        item.checks.push({ check: 'oauth.live-artifact-identity', status: 'passed', actual: lock.world });
        const result = await probeDeclaredOAuthWorld({ artifact, bindings, credentials, signal, resetImpl: async () => {
          if (!bindings.WORKBENCH_URL) throw new Error('No public Workbench reset binding');
          const body = await workbench('/api/reset', { method: 'POST', body: {} });
          if (body.ok !== true) throw new Error('Normal reset did not report success');
          await pauseRunClock(name);
        } });
        item.checks.push(...result.checks); item.responses.push(...result.responses); item.coverage.push(...result.coverage);
        item.checks.push(...collectionCoverage(inventoryCollections({ software: { oauth_clients: artifact.world.software.oauth_clients } }), { evidence: result.coverage }));
      } catch (error) { item.checks.push(failed('oauth.case', error)); }
      finally {
        if (!prepareOnly) {
          try { const logs = await docker(['logs', '--tail', '250', name]); writeFileSync(join(directory, `world-${index}.log`), redact(logs.stdout + logs.stderr, secrets), { mode: 0o600 }); } catch { /* The failure may precede container creation. */ }
          try { await removeOwnedContainer(name, owner); } catch (error) { item.checks.push(failed('oauth.cleanup', error)); }
        }
        Object.assign(item, redact(item, secrets));
        item.failed_checks = item.checks.filter(row => row.status === 'failed').length;
        save();
        console.log(`${basename(dirname(sourcePath))}: ${item.failed_checks} failed OAuth checks`);
      }
    }
  } catch (error) { report.checks.push(failed('oauth.matrix', error)); }
  finally {
    report.finished_at = new Date().toISOString();
    report.failed_checks = [...report.checks, ...report.cases.flatMap(row => row.checks)].filter(row => row.status === 'failed').length;
    report.status = report.failed_checks ? 'failed' : prepareOnly ? 'prepared' : 'passed';
    save();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string', multiple: true }, image: { type: 'string' }, report: { type: 'string', default: join(ROOT, '.worldfixture/oauth', new Date().toISOString().replaceAll(':', '-')) }, python: { type: 'string' }, 'prepare-only': { type: 'boolean', default: false }, 'ready-timeout-ms': { type: 'string', default: '180000' } } });
  const timeout = Number(values['ready-timeout-ms']);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('--ready-timeout-ms must be positive');
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`OAuth matrix interrupted by ${signal}`)));
  const report = await runOAuthMatrix({ sourcePaths: values.source, image: values.image, reportPath: values.report, python: values.python, prepareOnly: values['prepare-only'], readyTimeoutMs: timeout, signal: abort.signal });
  console.log(`OAuth matrix ${report.status}: ${report.failed_checks} failed checks. Report: ${join(resolve(values.report), 'report.json')}`);
  process.exitCode = report.status === 'failed' ? 1 : 0;
}
