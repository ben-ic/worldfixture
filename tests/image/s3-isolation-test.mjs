// Exercise private SeaweedFS ports, Account Desk, and the real Workbench routes.
// --checkout tests changed image sources without rebuilding the combined image.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { parseArgs, promisify } from 'node:util';
import { createProviders, ACTIONS } from '../../examples/demo_app/src/providers/index.mjs';
import { createStore } from '../../examples/demo_app/src/db/store.mjs';
import { createApplication } from '../../examples/demo_app/src/server/app.mjs';
import { s3Fetch } from '../../runtime/src/s3-signing.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, checkout: { type: 'boolean' }, keep: { type: 'boolean' },
  mode: { type: 'string', default: 'direct' }, image: { type: 'string', default: 'ghcr.io/ben-ic/worldfixture:0.2.6' } } });
if (!values.run) console.log('Use --run --mode direct|image [--checkout] [--image name] [--keep].');
else {
  assert.ok(['direct', 'image'].includes(values.mode));
  const root = join(import.meta.dirname, '../..'), scratch = mkdtempSync(join(tmpdir(), 'wf-s3-isolation-'));
  const state = join(scratch, 'state'), bin = join(root, 'runtime/bin/worldfixture.mjs');
  const execute = promisify(execFile), name = `wf-s3-isolation-${randomUUID()}`;
  const docker = async args => (await execute('docker', args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const cli = async args => (await execute(process.execPath, [bin, ...args, '--state', state], {
    cwd: scratch, env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '0' }, timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const json = async (url, input) => {
    const headers = { 'content-type': 'application/json' };
    if (input !== undefined && url.startsWith(workbench)) {
      const session = await fetch(`${workbench}/api/session`);
      headers['x-worldfixture-generation'] = session.headers.get('x-worldfixture-generation') ?? (await session.json()).generation;
    }
    const response = await fetch(url, { ...(input === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(input) }), signal: AbortSignal.timeout(120000) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  let child, container, workbench, bindings, app, store, output = '';
  const environmentPath = join(scratch, 'environment.json');
  writeFileSync(environmentPath, JSON.stringify({ api_version: 'worldfixture.environment/v1', world: { use: 'business.saas-company:v3' }, requires: ['aws.s3.objects.v1'], bindings: Object.fromEntries(Object.entries({ S3_BASE_URL: 'base_url', S3_ACCESS_KEY_ID: 'access_key_id', S3_SECRET_ACCESS_KEY: 'secret_access_key', S3_REGION: 'region', S3_BUCKET: 'bucket' }).map(([key, value]) => [key, `aws.s3.objects.v1/${value}`])) }));
  const selected = ['--no-rebase', '--setup', '--no-sample-app', ...(values.mode === 'direct' ? ['--environment', environmentPath] : ['--only', 's3'])];
  const entrypoint = join(scratch, 'worldfixture-s3');
  copyFileSync(join(root, 'emulators/s3/worldfixture-entrypoint.sh'), entrypoint); chmodSync(entrypoint, 0o555);
  try {
    if (values.mode === 'direct') {
      child = spawn(process.execPath, [bin, 'up', '--direct', '--state', state, ...selected], {
        cwd: scratch, env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const deadline = Date.now() + 180000;
      while (!output.includes('Stop with Ctrl-C')) {
        assert.equal(child.exitCode, null, output); assert.ok(Date.now() < deadline, output);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      bindings = JSON.parse(await cli(['env', '--json']));
      workbench = JSON.parse(readFileSync(join(state, 'workbench.json'), 'utf8')).url;
      const addresses = JSON.parse(readFileSync(join(state, 'addresses.json'), 'utf8'));
      container = addresses['s3/filer'].container;
      assert.ok(container, 'private readiness must use container exec');
      await cli(['status']);
    } else {
      const args = ['run', '--detach', '--name', name, '-p', '127.0.0.1::4715', '-p', '127.0.0.1::61006'];
      if (values.checkout) for (const [source, target] of [
        ['runtime/src', '/opt/worldfixture/runtime/src'], ['emulators/s3/service.json', '/opt/worldfixture/emulators/s3/service.json'],
        [entrypoint, '/usr/local/bin/worldfixture-s3'],
      ]) args.push('--mount', `type=bind,source=${source === entrypoint ? source : join(root, source)},target=${target},readonly`);
      await docker([...args, values.image, ...selected]); container = name;
      const [inspection] = JSON.parse(await docker(['inspect', container]));
      const mappings = inspection.NetworkSettings.Ports;
      workbench = `http://127.0.0.1:${mappings['4715/tcp'][0].HostPort}`;
      const deadline = Date.now() + 180000;
      for (;;) {
        try { await docker(['exec', container, 'node', 'runtime/bin/worldfixture.mjs', 'status', '--state', '/state']); break; }
        catch {
          const [current] = JSON.parse(await docker(['inspect', container]));
          assert.equal(current.State.Running, true, await docker(['logs', container]));
          assert.ok(Date.now() < deadline, 'image readiness timed out'); await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      bindings = JSON.parse(await docker(['exec', container, 'node', 'runtime/bin/worldfixture.mjs', 'env', '--json', '--state', '/state']));
      bindings.S3_BASE_URL = `http://127.0.0.1:${mappings['61006/tcp'][0].HostPort}`;
    }
    const checkNetwork = async () => {
      const [inspection] = JSON.parse(await docker(['inspect', container]));
      if (values.mode === 'direct') {
        assert.equal(inspection.Config.User, `${process.getuid()}:${process.getgid()}`, 'S3 must read private artifacts as their host owner');
        const worldMount = inspection.Mounts.find(mount => mount.Destination === '/world');
        assert.equal(statSync(worldMount.Source).mode & 0o777, 0o700, 'the staged world must remain private');
      }
      const exposed = Object.entries(inspection.NetworkSettings.Ports).filter(([, entries]) => entries?.length);
      assert.ok(exposed.every(([port, entries]) => ['4715/tcp', '61006/tcp'].includes(port) && entries.every(entry => entry.HostIp === '127.0.0.1')));
      const rows = (await docker(['exec', container, 'cat', '/proc/net/tcp', '/proc/net/tcp6'])).trim().split('\n')
        .map(row => row.trim().split(/\s+/)).filter(fields => fields[3] === '0A')
        .map(fields => { const [address, port] = fields[1].split(':'); return { address, port: parseInt(port, 16) }; });
      const privatePorts = [61000, 61001, 61002, 61003, 61004, 61005, 61007];
      for (const port of privatePorts) {
        const listeners = rows.filter(row => row.port === port);
        assert.ok(listeners.length, `internal listener ${port} missing`);
        assert.ok(listeners.every(row => row.address === '0100007F'), `internal listener ${port} must be IPv4 loopback`);
      }
      const ip = Object.values(inspection.NetworkSettings.Networks)[0].IPAddress;
      // A separate container must reach S3 HTTP, but no private HTTP/gRPC port.
      const observed = JSON.parse(await docker(['run', '--rm', '--entrypoint', 'node', values.image, '--input-type=module', '-e', `
        import net from 'node:net';
        const ports=${JSON.stringify([...privatePorts, 61006])};
        const result=await Promise.all(ports.map(port=>new Promise(resolve=>{
          const socket=net.connect({host:${JSON.stringify(ip)},port});
          let done=false; const finish=ok=>{if(done)return;done=true;socket.destroy();resolve({port,ok});};
          socket.setTimeout(1500,()=>finish(false));socket.on('error',()=>finish(false));socket.on('connect',()=>finish(true));
        }))); console.log(JSON.stringify(result));
      `]));
      for (const row of observed) assert.equal(row.ok, row.port === 61006, `sibling access to ${row.port}`);
    };
    const refreshBindings = async () => {
      if (values.mode === 'direct') bindings = JSON.parse(await cli(['env', '--json']));
      else { const base = bindings.S3_BASE_URL; bindings = JSON.parse(await docker(['exec', container, 'node', 'runtime/bin/worldfixture.mjs', 'env', '--json', '--state', '/state'])); bindings.S3_BASE_URL = base; }
    };
    const exercise = async label => {
      await refreshBindings();
      await app?.close(); await store?.close();
      const env = { ...bindings, ACCOUNT_DESK_SQLITE_PATH: ':memory:' };
      store = await createStore(env);
      app = createApplication({ providers: createProviders(env), store, connector: {}, actions: ACTIONS, env, staticRoot: join(root, 'examples/demo_app/dist') });
      const origin = await app.listen(0), bucket = bindings.S3_BUCKET;
      const appKey = `isolation/${label}-app.txt`, benchKey = `isolation/${label}-workbench.txt`;
      const receipt = await json(`${origin}/api/actions`, { action: 's3.put', input: { bucket, key: appKey, text: 'Written by Account Desk' }, idempotencyKey: randomUUID() });
      assert.equal(receipt.status, 'passed', JSON.stringify(receipt));
      const overview = await json(`${workbench}/api/overview`);
      assert.ok(JSON.stringify(overview.providers.s3).includes(appKey), 'Workbench must list the app write');
      await json(`${workbench}/api/actions/s3`, { person_id: 'maya-chen', bucket, key: benchKey, text: 'Written by Workbench' });
      await app.refreshAll();
      const appState = await json(`${origin}/api/state`);
      assert.ok(JSON.stringify(appState.data.s3).includes(benchKey), 'Account Desk must list the Workbench write');
      for (const [key, text] of [[appKey, 'Written by Account Desk'], [benchKey, 'Written by Workbench']]) {
        const response = await s3Fetch(`${bindings.S3_BASE_URL}/${bucket}/${key}`, {}, bindings);
        assert.equal(response.status, 200); assert.equal(await response.text(), text);
      }
      console.log(`PASS ${values.mode} ${label}: Account Desk ${origin}; Workbench ${workbench}; writes, readback, and shared listings.`);
      return [appKey, benchKey];
    };
    await checkNetwork();
    const keys = await exercise('startup');
    await json(`${workbench}/api/reset`, {});
    for (const key of keys) assert.equal((await s3Fetch(`${bindings.S3_BASE_URL}/${bindings.S3_BUCKET}/${key}`, {}, bindings)).status, 404, 'reset removes test writes');
    await checkNetwork(); await exercise('reset');
    if (values.mode === 'direct') await cli(['switch', 'business.saas-company:v3', '--no-rebase']);
    else await docker(['exec', container, 'node', 'runtime/bin/worldfixture.mjs', 'switch', 'business.saas-company:v3', '--no-rebase', '--state', '/state']);
    if (values.mode === 'direct') container = JSON.parse(readFileSync(join(state, 'addresses.json'), 'utf8'))['s3/filer'].container;
    await checkNetwork(); await exercise('switch');
    console.log(`PASS ${values.mode}: seven private HTTP/gRPC listeners refuse sibling access; S3 HTTP forwarding works.`);
    if (values.keep) { console.log(`Review world stays open. Workbench: ${workbench}. Press Ctrl-C to clean up.`); await once(process, 'SIGINT'); }
  } finally {
    await app?.close(); await store?.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    if (values.mode === 'image') await docker(['rm', '--force', name]).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}
