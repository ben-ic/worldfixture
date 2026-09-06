import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadManifests } from './manifests.mjs';
import { resolveEnvironment } from './resolve.mjs';
import { start } from './supervisor.mjs';
import { createSessionManager } from './session-manager.mjs';
import { attachTimelineControl } from './timeline-control.mjs';

const ROOT = join(import.meta.dirname, '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function artifact(root, name) {
  const artifactPath = join(root, name); mkdirSync(join(artifactPath, 'projections'), { recursive: true });
  const actor = { id: `${name}.person`, name }, post = { id: `${name}.post`, author_id: actor.id, title: name, body: `Only ${name}` };
  const world = { id: `test.${name}`, version: 'v1', clock: { anchor: '2031-01-01T00:00:00Z' }, people: [actor], social: { posts: [post] },
    timeline: [{ id: 'future.post', kind: 'domain-operation', after_seconds: 10, payload: { api_version: 'worldfixture.runtime-operation/v1', type: 'social.post.publish.v1', actor_id: actor.id,
      record: { id: `${name}.future`, author_id: actor.id, title: 'Future', body: 'Not delivered during setup' } } }] };
  const projection = { api_version: 'worldfixture.domain/v1', world: { id: world.id, version: world.version }, collections: { 'identity.people': [actor], 'social.posts': [post] } }, files = {};
  for (const [file, value] of [['world.json', world], ['projections/domain.json', projection]]) {
    const bytes = JSON.stringify(value); writeFileSync(join(artifactPath, file), bytes); files[file] = { sha256: sha(bytes), size: Buffer.byteLength(bytes) };
  }
  writeFileSync(join(artifactPath, 'manifest.json'), JSON.stringify({ api_version: 'worldfixture.world-artifact/v1', world_id: world.id, world_version: world.version, files, artifact_sha256: sha(`${JSON.stringify(canonical(files))}\n`) }));
  const lock = resolveEnvironment({ api_version: 'worldfixture.environment/v1', world: { use: `${world.id}:v1` }, requires: ['domain.collections.v1'], execution: { mode: 'selected-capabilities' }, bindings: {} }, { artifactPath, manifests: loadManifests(join(ROOT, 'emulators')) });
  lock.services.push({ name: 'appdb', version: '1', command: [process.execPath, 'server.mjs'], profiles: [], projections: [],
    lifecycle: { reset: false }, ports: [{ name: 'http', protocol: 'http', env: 'APP_LISTEN', env_format: 'host_port', published: false }],
    readiness: [{ port: 'http', protocol: 'http', path: '/readyz', kind: 'protocol', expect: 'ready' }],
    environment: [{ name: 'APP_STATE', from: 'runtime.state', required: true }, { name: 'APP_PASSWORD', from: 'generated', key: 'appdb.password', required: true }] });
  return { lock, world, artifactPath, selection: { id: world.id, version: world.version } };
}

test('real provider switches preserve a live application SQLite process and reject old provider tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-session-live-')), serviceRoot = join(root, 'services');
  const legacyState = `/tmp/worldfixture-p6-legacy-${randomUUID()}`;
  mkdirSync(join(serviceRoot, 'appdb'), { recursive: true }); symlinkSync(join(ROOT, 'emulators/domain'), join(serviceRoot, 'domain'));
  writeFileSync(join(serviceRoot, 'appdb/server.mjs'), `import { createServer } from 'node:http'; import { DatabaseSync } from 'node:sqlite'; import { join } from 'node:path';
const db = new DatabaseSync(join(process.env.APP_STATE,'application.sqlite')); db.exec('CREATE TABLE IF NOT EXISTS notes(body TEXT)');
const server=createServer(async(req,res)=>{ if(req.url==='/readyz'){res.end('ready');return;} if(req.headers.authorization!=='Bearer '+process.env.APP_PASSWORD){res.writeHead(401);res.end();return;}
if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;db.prepare('INSERT INTO notes VALUES(?)').run(body);}
res.setHeader('content-type','application/json');res.end(JSON.stringify({pid:process.pid,notes:db.prepare('SELECT body FROM notes').all()}));});
const [host,port]=process.env.APP_LISTEN.split(':');server.listen(Number(port),host);process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));`);
  const candidates = Object.fromEntries(['a', 'b', 'alien'].map(name => [name, artifact(root, name)]));
  // Mail and S3 keep an absolute owned directory and skip baseline seeding when
  // its marker exists. Reproduce that service contract in this process namespace.
  mkdirSync(join(serviceRoot, 'legacy'), { recursive: true });
  writeFileSync(join(serviceRoot, 'legacy/server.mjs'), `import {createServer} from 'node:http';import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
mkdirSync(process.env.SEED_STATE,{recursive:true});const file=join(process.env.SEED_STATE,'seeded-world.json');if(!existsSync(file))writeFileSync(file,readFileSync(join(process.env.WORLD_PATH,'world.json')));
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(readFileSync(file));});const[host,port]=process.env.LISTEN.split(':');server.listen(Number(port),host);process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  for (const candidate of Object.values(candidates)) candidate.lock.services.push({ name: 'legacy', version: '1', command: [process.execPath, 'server.mjs'], profiles: [], projections: [],
    lifecycle: { reset: true, state: { clear_paths: [legacyState], snapshot_paths: [legacyState] } },
    ports: [{ name: 'http', protocol: 'http', env: 'LISTEN', env_format: 'host_port', published: false }],
    readiness: [{ port: 'http', protocol: 'http', path: '/', kind: 'protocol', expect: 'test.' }],
    environment: [{ name: 'SEED_STATE', from: 'constant', value: legacyState }, { name: 'WORLD_PATH', from: 'world.path' }] });
  const startOptions = { serviceRoot, runner: 'process', readyTimeoutMs: 10_000, generatedSecretsPath: join(root, 'secrets.json'), manageSignals: false };
  let manager, initial;
  try {
    initial = await start(candidates.a.lock, { ...startOptions, artifactPath: candidates.a.artifactPath, stateDir: join(root, 'initial'), generation: 'initial-a' });
    const activate = async current => {
      const world = candidates[Object.keys(candidates).find(name => candidates[name].world.id === current.lock.world.id)].world;
      const address = current.addressOf('domain', 'http');
      const bindings = { DOMAIN_BASE_URL: `http://${address.host}:${address.port}`, DOMAIN_TOKEN: current.credentials.values['domain.token'] };
      await attachTimelineControl(current, world, { bindings, rules: [] }).initialize({ setup: true });
    };
    await activate(initial);
    manager = createSessionManager(initial, { sessionRoot: root, startOptions, activate, confirmConnection: async () => {},
      prepareSelection: async (input, { generation }) => {
        const candidate = structuredClone(candidates[input.world]); candidate.stateDir = join(root, 'generations', generation, 'runtime');
        if (input.fail) candidate.lock.services.find(service => service.name === 'domain').command = [process.execPath, '-e', 'process.exit(9)'];
        return candidate;
      } });
    await manager.publishInitial();
    const appAddress = initial.addressOf('appdb', 'http'), appUrl = `http://${appAddress.host}:${appAddress.port}`;
    const appHeaders = { authorization: `Bearer ${initial.credentials.values['appdb.password']}` };
    const appBefore = await (await fetch(appUrl, { method: 'POST', headers: appHeaders, body: 'Application row must survive' })).json();
    const domainPort = initial.addressOf('domain', 'http').port;
    let oldToken = initial.credentials.values['domain.token'];
    for (const name of ['b', 'alien', 'a']) {
      await manager.switchWorld({ world: name }, manager.generation);
      const current = manager.instance, token = current.credentials.values['domain.token'];
      assert.equal(current.addressOf('domain', 'http').port, domainPort); assert.notEqual(token, oldToken);
      const url = `http://127.0.0.1:${domainPort}/v1/collections/social.posts`;
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${oldToken}` } })).status, 401);
      const records = await (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.deepEqual(records.data, candidates[name].world.social.posts);
      const legacy = current.addressOf('legacy', 'http');
      assert.deepEqual(await (await fetch(`http://${legacy.host}:${legacy.port}`)).json(), candidates[name].world, 'Fresh generation must replace absolute-path seed markers and baseline bytes');
      assert.equal(manager.instance.timelineControl.status().mode, 'setup');
      await manager.clockCommand({ action: 'reset' }, manager.generation);
      assert.equal(manager.instance.timelineControl.status().mode, 'setup');
      assert.deepEqual(await (await fetch(appUrl, { headers: appHeaders })).json(), appBefore);
      oldToken = token;
    }
    const generation = manager.generation;
    await assert.rejects(manager.switchWorld({ world: 'b', fail: true }, generation), error => error.code === 'switch_failed_rolled_back');
    assert.equal(manager.instance.lock.world.id, candidates.a.world.id); assert.notEqual(manager.generation, generation);
    assert.deepEqual(await (await fetch(appUrl, { headers: appHeaders })).json(), appBefore);
    assert.equal((await fetch(`http://127.0.0.1:${domainPort}/v1/collections/social.posts`, { headers: { authorization: `Bearer ${oldToken}` } })).status, 401);
    rmSync(join(manager.instance.stateDir, 'baselines/domain'), { recursive: true, force: true });
    await assert.rejects(manager.clockCommand({ action: 'reset' }, manager.generation), error => error.code === 'timeline_reset_failed');
    assert.equal(manager.instance.timelineControl.status().mode, 'failed');
    assert.deepEqual(await (await fetch(appUrl, { headers: appHeaders })).json(), appBefore);
  } finally { if (manager) await manager.stop(); else await initial?.stop(); rmSync(root, { recursive: true, force: true }); rmSync(legacyState, { recursive: true, force: true }); }
});
