// Run inside the product image with a verified artifact at /world and writable
// /state. The application below owns its SQLite data; provider state is read
// only through the public domain API. Runtime SQLite is inspected after exit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, watch, writeFileSync } from 'node:fs';

const report = { checks: [], cases: [] }, root = '/state', connectorUrl = 'http://connector.fixture:19322';
mkdirSync(root, { recursive: true });
const manifest = JSON.parse(readFileSync('/world/manifest.json', 'utf8'));
report.artifact_sha256 = manifest.artifact_sha256;
const check = (name, condition) => { assert.ok(condition, name); report.checks.push({ check: name, status: 'passed' }); };
const waitFor = async (read, message, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(message);
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const application = new DatabaseSync(`${root}/application.sqlite`);
application.exec('CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE accepted_events(mode TEXT,event_id TEXT,envelope TEXT); INSERT INTO notes VALUES(\'manual-app-row\',\'Keep application data\')');
let active;
async function domainRecords() {
  const credentials = JSON.parse(readFileSync(`${active.stateDir}/credentials.json`, 'utf8'));
  const response = await fetch('http://127.0.0.1:4717/v1/collections/social.posts', { headers: { authorization: `Bearer ${credentials.values['domain.token']}` } });
  assert.equal(response.status, 200); return response.json();
}
function domainProcesses() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
    try { return readlinkSync(`/proc/${pid}/cwd`).endsWith('/emulators/domain') && readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('server.mjs'); }
    catch { return false; }
  });
}
const server = createServer(async (request, response) => {
  const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  try {
    if (request.url === '/.well-known/worldfixture') return json(200, { api_version: 'worldfixture.connector/v1', application: { id: 'interruption-check', name: 'Interruption Check' }, capabilities: { event: true } });
    if (request.url !== '/__worldfixture/events' || request.method !== 'POST') return json(404, { error: 'Unknown test route' });
    if (request.headers.authorization !== `Bearer ${active.token}`) return json(401, { error: 'Incorrect application token' });
    let text = ''; for await (const chunk of request) text += chunk;
    const event = JSON.parse(text); active.requests.push(event);
    active.providerBeforeExit = await domainRecords();
    if (active.mode === 'interrupt') application.prepare('INSERT INTO accepted_events VALUES(?,?,?)').run(active.mode, event.event_id, JSON.stringify(event));
    active.entered.resolve();
    await active.release.promise;
    if (active.mode === 'failure') return json(503, { error: 'The test application refused this event' });
    return json(200, { api_version: 'worldfixture.connector-receipt/v1', status: 'applied', event_id: event.event_id, counts: { events: 1 }, references: [] });
  } catch (error) { active?.entered.resolve(); json(500, { error: error.message }); }
});
async function runCase(mode) {
  const stateDir = `${root}/${mode}`, cwd = `${root}/${mode}-project`;
  mkdirSync(stateDir, { recursive: true }); mkdirSync(cwd, { recursive: true });
  active = { mode, stateDir, token: randomBytes(24).toString('hex'), requests: [], entered: deferred(), release: deferred() };
  const observed = active, publicationEvents = []; let output = '', exitResult;
  const observer = watch(stateDir, (_event, filename) => { if (filename === 'bindings.json') publicationEvents.push(String(filename)); });
  const child = spawn(process.execPath, ['/opt/worldfixture/runtime/bin/worldfixture.mjs', 'up', '--world-path', '/world', '--state', stateDir,
    '--service-root', '/opt/worldfixture/emulators', '--only', 'domain', '--no-rebase', '--start-at', '3s', '--application-url', connectorUrl], {
    cwd, env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '1', WORLDFIXTURE_TOKEN: active.token,
      WORLDFIXTURE_PROJECT_CONFIG: JSON.stringify({ api_version: 'worldfixture.project/v1', application_url: connectorUrl, services: [] }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); }));
  const entry = { mode, application_requests: observed.requests }; report.cases.push(entry);
  try {
    await waitFor(() => { if (exitResult) throw new Error(`CLI exited before connector request: ${output}`); return observed.requests.length > 0; }, 'Initial connector event was not reached', 120000);
    await observed.entered.promise;
    check(`${mode}.first-domain-write-visible`, observed.providerBeforeExit?.data?.some(row => row.id === 'post.first'));
    check(`${mode}.next-domain-write-not-claimed`, !observed.providerBeforeExit.data.some(row => row.id === 'post.next'));
    check(`${mode}.no-ready-bindings-during-positioning`, !existsSync(`${stateDir}/bindings.json`));
    const processes = domainProcesses(); check(`${mode}.required-child-running`, processes.length === 1);
    if (mode === 'interrupt') {
      child.kill('SIGINT');
      await waitFor(() => output.includes('Stopping initial timeline delivery'), 'CLI did not acknowledge positioning interruption');
      check('interrupt.waits-for-current-acceptance', !exitResult && (await domainRecords()).data.some(row => row.id === 'post.first'));
    }
    observed.release.resolve();
    await waitFor(() => exitResult, 'CLI did not stop after the current delivery', 20000); await exited;
    check(`${mode}.exit-status`, mode === 'interrupt' ? exitResult.code === 130 : exitResult.code !== 0);
    check(`${mode}.no-ready-advertisement`, !output.includes('Stop with Ctrl-C') && publicationEvents.length === 0 && !existsSync(`${stateDir}/bindings.json`) && !existsSync(`${stateDir}/addresses.json`));
    check(`${mode}.all-provider-children-stopped`, domainProcesses().length === 0);
    const db = new DatabaseSync(`${stateDir}/state.sqlite`, { readOnly: true });
    try {
      entry.timeline = db.prepare('SELECT id,status,command_id,event_id,attempted_at,completed_at,error FROM scheduled_events ORDER BY due_at,id').all();
      entry.commands = db.prepare('SELECT id,status,event_id FROM commands ORDER BY submitted_at,id').all();
      entry.receipts = db.prepare('SELECT event_id,status,envelope FROM connector_receipts').all().map(row => ({ ...row, envelope: JSON.parse(row.envelope) }));
      entry.clock = db.prepare('SELECT * FROM clock').get();
      check(`${mode}.partial-outcomes`, JSON.stringify(entry.timeline.map(row => row.status)) === JSON.stringify(['delivered', mode === 'interrupt' ? 'delivered' : 'failed', 'pending']));
      check(`${mode}.only-two-commands`, entry.commands.length === 2 && entry.timeline[2].command_id === null);
      check(`${mode}.clock-stopped`, entry.clock.started_at === null);
      check(`${mode}.connector-receipt-preserved`, entry.receipts.length === 1 && entry.receipts[0].status === (mode === 'interrupt' ? 'accepted' : 'pending'));
      check(`${mode}.connector-identity-and-time`, entry.receipts[0].event_id === 'wf:test.clock-interruption:v1:arrival.application' && entry.receipts[0].envelope.occurred_at === '2031-01-01T00:00:01.000Z');
    } finally { db.close(); }
    check(`${mode}.application-data-preserved`, application.prepare("SELECT body FROM notes WHERE id='manual-app-row'").get().body === 'Keep application data');
    check(`${mode}.accepted-application-mutations`, application.prepare('SELECT COUNT(*) AS n FROM accepted_events WHERE mode=?').get(mode).n === (mode === 'interrupt' ? 1 : 0));
    entry.provider_before_exit = observed.providerBeforeExit; entry.exit = exitResult; entry.status = 'passed';
  } catch (error) { entry.status = 'failed'; entry.error = error.message; throw error; }
  finally {
    observed.release.resolve();
    if (!exitResult) { child.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]); }
    if (!exitResult) child.kill('SIGKILL');
    observer.close(); entry.output = output.replaceAll(observed.token, '[redacted]');
    writeFileSync(`${root}/${mode}.log`, entry.output);
  }
}
try {
  await new Promise(resolve => server.listen(19322, '127.0.0.1', resolve));
  await runCase('interrupt'); await runCase('failure'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  active?.release.resolve(); await new Promise(resolve => server.close(resolve)); application.close();
  writeFileSync(`${root}/report.json`, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
}
