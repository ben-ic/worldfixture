// Supplemental P2 proof: source-authored Gmail arrivals and duplicate Linear titles.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { discoverArtifacts, loadArtifact } from './coupling-artifacts.mjs';
import { probeGoogleWorld } from './coupling-google-probes.mjs';
import { probeLinearWorld } from './coupling-probes.mjs';
import { workbenchRequestReader } from './clock-world-test.mjs';
import { containerArguments, docker, mappedBindings, pauseRunClock, readRunBindings, readRunCredentialSet,
  redact, removeOwnedContainer, waitForReady } from './coupling-runner.mjs';

const { values } = parseArgs({ options: { image: { type: 'string' }, report: { type: 'string' } } });
if (!values.image || !values.report) throw new Error('Use --image IMAGE --report NEW_DIRECTORY');
const root = resolve(values.report), repo = resolve('.');
if (existsSync(root)) throw new Error('Refusing to overwrite an existing proof directory');
mkdirSync(root, { recursive: true, mode: 0o700 });
const execute = promisify(execFile), read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const secrets = [], owner = randomUUID(), name = `wf-arrivals-${owner}`;
const report = { scope: 'Copied v2 source with explicit nonprimary Gmail recipients and duplicate-title Linear tasks; normal scheduler and reset, public API reads. Shipped sources remain unchanged.',
  started_at: new Date().toISOString(), checks: [], responses: [] };
const save = () => write(join(root, 'report.json'), redact(report, secrets));
const check = (name, action) => {
  try { action(); report.checks.push({ check: name, status: 'passed' }); }
  catch (error) { report.checks.push({ check: name, status: 'failed', detail: error.message }); }
};
const shippedSources = [];
const sourceBytes = (directory, provenance) => Object.fromEntries(Object.keys(provenance).sort().map(path => {
  const bytes = readFileSync(join(directory, path));
  return [path, { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }];
}));
let artifact, bindings, credentials, attemptedBoot = false;
try {
  const [image] = JSON.parse((await docker(['image', 'inspect', values.image])).stdout);
  report.image = { requested: values.image, id: image.Id };
  for (const path of discoverArtifacts(join(repo, 'dist'))) {
    const input = loadArtifact(path), directory = join(repo, 'worlds', `${input.identity.id}.${input.identity.version}`);
    const before = sourceBytes(directory, input.manifest.source_files);
    assert.deepEqual(before, input.manifest.source_files, 'Shipped sources must match approved artifact provenance before the test');
    shippedSources.push({ directory, identity: input.identity, before });
  }
  report.shipped_sources = shippedSources;
  const sourcePath = join(root, 'source');
  cpSync(join(repo, 'worlds/business.saas-company.v2'), sourcePath, { recursive: true });
  const compile = async output => execute(process.env.PYTHON ?? 'python3', ['-m', 'worldfixture_compiler', 'build', join(sourcePath, 'world.json'), '--output', output],
    { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, 'compiler') }, maxBuffer: 4 * 1024 * 1024 });
  await compile(join(root, 'baseline-artifact'));
  const baseline = loadArtifact(join(root, 'baseline-artifact'));
  assert.ok(baseline.checks.every(row => row.status === 'passed'));
  const source = baseline.world;
  const recipients = source.people.filter(person => !person.primary && source.communication.mailboxes.some(row => row.owner_id === person.id)).slice(0, 2);
  assert.equal(recipients.length, 2);
  const marker = createHash('sha256').update(owner).digest('hex').slice(0, 12);
  const arrivals = recipients.map((person, index) => ({ id: `arrival-gmail-${marker}-${index}`, after_seconds: 3 + index * 2, kind: 'incoming-email',
    payload: { via: 'gmail', from_id: source.people.find(person => person.primary).id, to_id: person.id,
      subject: `Authored arrival ${marker} ${index}`, snippet: `Message for ${person.name}.`, body_text: `Message for ${person.name}.\nReference ${marker}-${index}.`,
      labels: ['INBOX', 'UNREAD', `Arrival ${marker} ${index}`] } }));
  const tasks = [0, 1].map(index => ({ ...source.work.tasks[0], id: `task-arrival-${marker}-${index}`, title: `Shared task title ${marker}` }));
  const mailboxesPath = join(sourcePath, 'packs/google-mailboxes.json'), mailboxes = read(mailboxesPath);
  for (const arrival of arrivals) mailboxes.contributes.communication.mailboxes.find(row => row.owner_id === arrival.payload.to_id).labels.push(arrival.payload.labels[2]);
  write(mailboxesPath, mailboxes);
  const manifestPath = join(sourcePath, 'world.json'), manifest = read(manifestPath);
  manifest.fragments.push('packs/coupling-arrivals.json');
  write(manifestPath, manifest);
  write(join(sourcePath, 'packs/coupling-arrivals.json'), { api_version: 'worldfixture.world-fragment/v1', id: 'pack.coupling-arrivals', contributes: { timeline: arrivals, work: { tasks } } });
  await compile(join(root, 'artifact'));
  await compile(join(root, 'artifact-repeat'));
  artifact = loadArtifact(join(root, 'artifact'));
  assert.ok(artifact.checks.every(row => row.status === 'passed'));
  assert.deepEqual(artifact.identity, loadArtifact(join(root, 'artifact-repeat')).identity);
  assert.equal(artifact.identity.id, baseline.identity.id); assert.equal(artifact.identity.version, baseline.identity.version);
  assert.notEqual(artifact.identity.digest, baseline.identity.digest);
  report.source = { baseline: baseline.identity, variant: artifact.identity, arrivals, tasks: tasks.map(row => ({ id: row.id, title: row.title })), recipient_ids: recipients.map(row => row.id) };
  const reversed = structuredClone(artifact.world);
  assert.deepEqual(reversed.timeline.filter(row => arrivals.some(event => event.id === row.id)), arrivals);
  assert.deepEqual(reversed.work.tasks.filter(row => tasks.some(task => task.id === row.id)), tasks);
  reversed.timeline = reversed.timeline.filter(row => !arrivals.some(event => event.id === row.id));
  reversed.work.tasks = reversed.work.tasks.filter(row => !tasks.some(task => task.id === row.id));
  for (const arrival of arrivals) {
    const mailbox = reversed.communication.mailboxes.find(row => row.owner_id === arrival.payload.to_id);
    const label = arrival.payload.labels[2];
    assert.equal(mailbox.labels.filter(name => name === label).length, 1);
    mailbox.labels = mailbox.labels.filter(name => name !== label);
  }
  assert.deepEqual(reversed, baseline.world, 'Only two declared arrivals, tasks and custom labels may change source content');
  report.checks.push({ check: 'source.only-declared-variant-changes', status: 'passed' });
  report.checks.push({ check: 'source.variant-identity-and-deterministic-build', status: 'passed' }); save();
  attemptedBoot = true;
  await docker([...containerArguments({ image: image.Id, artifactPath: artifact.path, name, owner, exposedPorts: Object.keys(image.Config.ExposedPorts ?? {}) }), '--only', 'providers']);
  await waitForReady(name);
  const [inspection] = JSON.parse((await docker(['inspect', name])).stdout);
  assert.equal(inspection.Config.Image, image.Id);
  const refresh = async () => {
    credentials = await readRunCredentialSet(name); secrets.push(...Object.values(credentials.values));
    bindings = mappedBindings(await readRunBindings(name), inspection.NetworkSettings.Ports);
  };
  await refresh();
  const workbench = await workbenchRequestReader(bindings.WORKBENCH_URL, report.responses, { timeoutMs: 180000 });
  const request = async (base, path, init = {}) => {
    const response = await fetch(`${base.replace(/\/$/, '')}${path}`, { ...init, signal: AbortSignal.timeout(path === '/api/reset' ? 180000 : 30000) });
    const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = raw; }
    report.responses.push({ base: new URL(base).pathname || '/', path, status: response.status, body });
    assert.equal(response.status, 200, `${path} rejected: ${response.status}`); return body;
  };
  const eventRows = async () => {
    const rows = []; let cursor = 0;
    for (let page = 0; page < 100; page++) {
      const body = await request(bindings.WORKBENCH_URL, `/api/inspect/events?after=${cursor}`);
      assert.ok(Array.isArray(body.events)); rows.push(...body.events);
      if (body.events.length < 100) return rows;
      const next = body.events.at(-1).seq; assert.ok(next > cursor); cursor = next;
    }
    throw new Error('Event pagination exceeded its bound');
  };
  const delivered = async phase => {
    const deadline = Date.now() + 60000; let events;
    for (;;) {
      events = await eventRows();
      const failed = events.filter(row => /arrival\.(failed|skipped)/.test(row.type) && arrivals.some(event => event.id === row.provider_evidence?.arrival));
      assert.equal(failed.length, 0, JSON.stringify(failed));
      const receipts = events.filter(row => row.type === 'mail.message.received.v1' && arrivals.some(event => event.id === row.provider_evidence?.arrival));
      if (receipts.length === arrivals.length) break;
      assert.ok(Date.now() < deadline, 'Authored Gmail arrivals were not delivered through the scheduler');
      await new Promise(done => setTimeout(done, 500));
    }
    const clock = await pauseRunClock(name);
    const receipts = events.filter(row => arrivals.some(event => event.id === row.provider_evidence?.arrival));
    report.delivery_phases ??= [];
    const priorEvents = new Set(report.delivery_phases.flatMap(row => row.receipts.map(event => event.id)));
    check(`${phase}.gmail.fresh-delivery-events`, () => assert.ok(receipts.every(row => !priorEvents.has(row.id))));
    report.delivery_phases.push({ phase, clock, receipts });
    for (const arrival of arrivals) {
      const matching = receipts.filter(row => row.provider_evidence.arrival === arrival.id);
      assert.equal(matching.length, 1);
      const receipt = matching[0], person = artifact.world.people.find(row => row.id === arrival.payload.to_id);
      check(`${phase}.gmail.source-routing.${arrival.id}`, () => {
        assert.equal(receipt.source, 'google'); assert.equal(receipt.actor_id, person.id);
        assert.equal(receipt.provider_evidence.to, person.email); assert.equal(receipt.provider_evidence.subject, arrival.payload.subject);
        assert.equal(typeof receipt.provider_evidence.message_id, 'string');
      });
      const token = credentials.values[`token:google_token_${person.id}`]; assert.ok(token);
      const body = await request(bindings.GOOGLE_BASE_URL, `/gmail/v1/users/${encodeURIComponent(person.email)}/messages/${encodeURIComponent(receipt.provider_evidence.message_id)}?format=full`, { headers: { authorization: `Bearer ${token}` } });
      check(`${phase}.gmail.required-presence.${arrival.id}`, () => assert.equal(body.id, receipt.provider_evidence.message_id));
    }
    // This reader checks every source mailbox with its own verified token.
    // Exact source-ID inventories reject any misplaced copy, including a copy
    // with another generated provider ID. It also checks full body and labels.
    for (const proof of [await probeGoogleWorld({ artifact, bindings, credentials, elapsedMs: clock.elapsed_ms, arrivalReceipts: receipts }), await probeLinearWorld({ artifact, bindings })]) {
      report.checks.push(...proof.checks.map(row => ({ ...row, check: `${phase}.${row.check}` }))); report.responses.push(...proof.responses);
    }
    const receipt = await request(bindings.LINEAR_BASE_URL, '/_worldfixture/seed-receipt', { headers: { authorization: `Bearer ${bindings.LINEAR_TOKEN}` } });
    check(`${phase}.linear.distinct-source-provider-ids`, () => {
      const found = receipt.issues.filter(row => tasks.some(task => task.id === row.source_task_id));
      assert.equal(found.length, 2); assert.equal(new Set(found.map(row => row.provider_issue_id)).size, 2);
    });
    save(); return receipt;
  };
  const before = await delivered('before-reset');
  const reset = await workbench('/api/reset', { method: 'POST', body: {} });
  assert.equal(reset.ok, true, 'Normal reset must report success');
  await waitForReady(name); await refresh();
  const restoredClock = await workbench('/api/clock');
  check('reset.clock-remains-paused', () => assert.equal(restoredClock.clock.running, false));
  await workbench('/api/clock', { method: 'POST', body: { action: 'advance', duration: `${Math.max(...arrivals.map(row => row.after_seconds))}s` } });
  const after = await delivered('after-reset');
  check('linear.reset-retains-exact-source-provider-map', () => assert.deepEqual(after, before));
} catch (error) { report.checks.push({ check: 'live-arrival-lifecycle', status: 'failed', detail: error.stack ?? error.message }); }
finally {
  try { const logs = await docker(['logs', '--tail', '250', name]); writeFileSync(join(root, 'container.log'), redact(logs.stdout + logs.stderr, secrets), { mode: 0o600 }); } catch { /* Failure can precede container creation. */ }
  try { if (attemptedBoot) await removeOwnedContainer(name, owner); } catch (error) { report.checks.push({ check: 'cleanup', status: 'failed', detail: error.message }); }
  for (const input of shippedSources) {
    check(`source.shipped-bytes-unchanged.${input.identity.id}.${input.identity.version}`, () => {
      input.after = sourceBytes(input.directory, input.before); assert.deepEqual(input.after, input.before);
    });
  }
  report.finished_at = new Date().toISOString(); report.failed = report.checks.filter(row => row.status === 'failed').length;
  report.status = report.failed ? 'failed' : 'passed'; save(); console.log(JSON.stringify({ status: report.status, checks: report.checks.length, failed: report.failed, report: join(root, 'report.json') }));
  process.exitCode = report.failed ? 1 : 0;
}
