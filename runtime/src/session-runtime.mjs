import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBindings } from './bindings.mjs';
import { checkConnector, connectorWorld } from './connector.mjs';
import { connectorTarget } from './project.mjs';
import { serializeLock } from './resolve.mjs';
import { createSessionManager } from './session-manager.mjs';
import { listSwitchWorlds, prepareSwitchWorld } from './switch-world.mjs';
import { refreshHostGeneration } from './host-launcher.mjs';
import { writeSessionFile, writeSessionJson as writeJson } from './session-files.mjs';

export function configureApplicationBindings(instance, workbenchUrl) {
  const result = resolveBindings(instance.lock, {
    artifactPath: instance.artifactPath, credentials: instance.credentials,
    addressOf: (service, port) => instance.addressOf(service, port),
  });
  if (result.unresolved.length) throw new Error(result.unresolved.map(row => `${row.name}: ${row.reason}`).join('; '));
  instance.applicationBindings = Object.fromEntries(Object.entries(result.resolved).map(([key, row]) => [key, row.value]));
  instance.applicationBindings.WORKBENCH_URL = workbenchUrl;
  instance.applicationBindings.WORLDFIXTURE_TOKEN = instance.runtimeToken;
  return instance.applicationBindings;
}

export function attachManagedSession(instance, {
  sessionRoot, packageRoot, serviceRoot, startOptions, environmentOptions,
  initialSpec, initialSelection, noRebase, workbench, activateTimeline,
}) {
  const sourceRoots = [join(packageRoot, 'worlds')];
  const selectionOptions = { stateDir: sessionRoot, distRoot: join(packageRoot, 'dist'), sourceRoots, serviceRoot, environmentOptions };
  instance.environmentSpec = initialSpec;
  instance.selection = initialSelection;
  const initial = [{ artifactPath: instance.artifactPath, world: instance.lock.world }];
  if (initialSelection?.artifactPath) initial.push({ artifactPath: initialSelection.artifactPath, world: { id: initialSelection.id, version: initialSelection.version, artifact_sha256: initialSelection.digest } });
  let manager;
  manager = createSessionManager(instance, {
    sessionRoot, startOptions,
    prepareSelection: (input, { generation }) => prepareSwitchWorld({ noRebase, ...input }, { ...selectionOptions, generation }),
    activate: async current => {
      current.applicationConnector = null;
      configureApplicationBindings(current, workbench.url);
      await activateTimeline(current, { startAtMs: 0, repeat: false, setup: true });
    },
    unpublish: () => {
      for (const file of ['bindings.json', 'addresses.json', 'host-bindings.json', 'host-addresses.json']) rmSync(join(sessionRoot, file), { force: true });
      writeJson(join(sessionRoot, 'workbench.json'), { url: workbench.url, state: 'switching' });
    },
    publish: async (current, { generation, selection }) => {
      mkdirSync(current.stateDir, { recursive: true });
      configureApplicationBindings(current, workbench.url);
      const lockBytes = serializeLock(current.lock);
      writeSessionFile(join(current.stateDir, 'environment.lock.json'), lockBytes);
      const spec = current.environmentSpec;
      if (spec) writeJson(join(current.stateDir, 'environment.json'), spec);
      writeJson(join(current.stateDir, 'bindings.json'), current.applicationBindings);
      writeJson(join(current.stateDir, 'addresses.json'), current.addresses());
      // Compatibility files are published under the transition gate. Managed
      // readers use the active-generation pointer after the manager commits it.
      writeSessionFile(join(sessionRoot, 'environment.lock.json'), lockBytes);
      writeJson(join(sessionRoot, 'bindings.json'), current.applicationBindings);
      writeJson(join(sessionRoot, 'addresses.json'), current.addresses());
      writeJson(join(sessionRoot, 'workbench.json'), { url: workbench.url, state: 'ready', generation });
      refreshHostGeneration(sessionRoot, { generation, selection, bindings: current.applicationBindings, addresses: current.addresses() });
    },
    confirmConnection: async (current, input, { generation }) => {
      const world = JSON.parse(readFileSync(join(current.artifactPath, 'world.json'), 'utf8'));
      const active = current.lock.execution?.timeline?.active;
      const required = world.timeline.some(row => row.kind === 'application-event' && (!active || active.includes(row.id)))
        || (current.lock.rules ?? []).some(row => row.when === 'application.event.delivered.v1');
      if (input.withoutApplication === true) {
        if (input.applicationUrl) throw new Error('Choose an application URL or a run without an application.');
        if (required) throw new Error('This world requires an application connector. Configure its URL before starting delivery.');
        current.applicationConnector = null;
        writeJson(join(current.stateDir, 'application-connector.json'), { generation, world: current.lock.world, confirmed: true, withoutApplication: true });
        return { connected: false, confirmed: true };
      }
      if (typeof input.applicationUrl !== 'string' || !input.applicationUrl.trim()) throw new Error('Supply the application connector URL.');
      const target = connectorTarget({ application_url: input.applicationUrl }, { inContainer: process.env.WORLDFIXTURE_SINGLE_CONTAINER === '1' });
      const result = await checkConnector(target.transport_url, { world: connectorWorld(current.artifactPath), token: current.runtimeToken });
      if (!result.ready) throw new Error(`The application connector is not ready: ${result.checks.filter(row => !row.ok).map(row => `${row.name}: ${row.detail}`).join('; ')}`);
      current.applicationConnector = { baseUrl: target.transport_url, token: current.runtimeToken };
      writeJson(join(current.stateDir, 'application-connector.json'), { ...target, generation, world: current.lock.world, confirmed: true });
      return { connected: true, confirmed: true, url: target.url };
    },
    onChange: () => workbench.notify?.('generation-change'),
  });
  writeJson(join(sessionRoot, 'session-catalogue.json'), { api_version: 'worldfixture.session-catalogue/v1', initial });
  manager.catalogue = () => listSwitchWorlds(selectionOptions);
  const initialConnectorPath = join(instance.stateDir, 'application-connector.json');
  if (existsSync(initialConnectorPath)) {
    const target = JSON.parse(readFileSync(initialConnectorPath, 'utf8'));
    writeJson(initialConnectorPath, { ...target, generation: manager.generation, world: instance.lock.world, confirmed: true });
  }
  instance.sessionManager = manager;
  return manager;
}
