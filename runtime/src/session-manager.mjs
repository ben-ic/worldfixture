import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { start as startInstance } from './supervisor.mjs';
import { forgetSlackCaches } from './slack.mjs';
import { writeSessionJson as atomicJson } from './session-files.mjs';

export class SessionError extends Error {
  constructor(code, message, status = 409, detail = {}) { super(message); this.name = 'SessionError'; this.code = code; this.status = status; this.detail = detail; }
}
const JOURNAL = 'session-transition.json', ACTIVE = 'active-generation.json';
const terminal = new Set(['complete', 'rolled-back', 'failed']);
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function assertSessionRecoverable(sessionRoot) {
  const path = join(sessionRoot, JOURNAL);
  const activePath = join(sessionRoot, ACTIVE);
  if (existsSync(activePath)) {
    let active; try { active = readJson(activePath); } catch { throw new SessionError('session_recovery_required', `Cannot read ${activePath}; inspect the session before startup`); }
    if (active.phase === 'switching') throw new SessionError('session_recovery_required', 'The active generation was not committed; inspect session-transition.json before startup', 409, { journal: path });
  }
  if (!existsSync(path)) return;
  let value;
  try { value = readJson(path); } catch { throw new SessionError('session_recovery_required', `Cannot read ${path}; inspect the interrupted session before starting providers`); }
  if (value.api_version !== 'worldfixture.session-transition/v1' || !terminal.has(value.phase) || value.recovery_required) {
    throw new SessionError('session_recovery_required', 'An interrupted world switch requires recovery before providers can start', 409,
      { journal: path, repair: `Stop the session, inspect ${path}, then remove only ${JOURNAL} and ${ACTIVE} and start the intended world explicitly. Preserve application database files.` });
  }
}
function retainedParts(instance, nextLock) {
  const names = new Set(instance.lock.services.filter(service => service.lifecycle?.reset === false).map(service => service.name));
  for (const name of names) {
    const old = instance.lock.services.find(service => service.name === name), next = nextLock.services.find(service => service.name === name);
    // The existing process owns its configuration, data directory and ports.
    const declared = value => { const copy = structuredClone(value); if (copy?.container) delete copy.container.name; return copy; };
    if (!next || !isDeepStrictEqual(declared(old), declared(next))) throw new SessionError('application_service_changed', `Switch must preserve the declared application service ${name}`);
  }
  const children = instance.children.filter(record => names.has(record.service));
  if (children.some(record => record.exited !== null)) throw new SessionError('application_service_stopped', 'A preserved application service is not running');
  const allocation = new Map([...instance.allocation].filter(([key]) => names.has(key.split('/')[0])));
  const credentials = {};
  for (const service of instance.lock.services.filter(service => names.has(service.name))) {
    for (const source of service.environment ?? []) {
      const key = source.from === 'generated' ? source.key : source.password_from === 'generated' ? source.password_key : null;
      if (key) {
        const value = instance.credentials?.values?.[key];
        if (!value) throw new SessionError('application_credential_missing', `Preserved application credential ${key} is unavailable`);
        credentials[key] = value;
      }
    }
  }
  return { names, children, allocation, credentials };
}
function copyReceipts(from, to) {
  const insert = to.prepare('INSERT INTO connector_receipts(event_id,target,envelope,payload_fingerprint,status,receipt) VALUES(?,?,?,?,?,?)');
  for (const row of from.prepare('SELECT * FROM connector_receipts').all()) insert.run(row.event_id, row.target, row.envelope, row.payload_fingerprint, row.status, row.receipt);
}

export function createSessionManager(initialInstance, {
  prepareSelection, activate, publish = async () => {}, unpublish = async () => {}, confirmConnection: confirm,
  startOptions = {}, onChange = () => {}, sessionRoot = initialInstance.stateDir, start = startInstance,
} = {}) {
  sessionRoot = resolve(sessionRoot); mkdirSync(sessionRoot, { recursive: true }); assertSessionRecoverable(sessionRoot);
  let instance = initialInstance, generation = initialInstance.generation ?? randomUUID(), phase = 'ready', transition = null;
  let reconnectRequired = false, switching = null, stopping = false;
  const mutations = new Set();
  instance.generation = generation;
  const worldOf = current => ({ id: current.lock.world.id, version: current.lock.world.version, artifact_sha256: current.lock.world.artifact_sha256 });
  const status = () => ({ phase, generation, world: worldOf(instance), transition, reconnect_required: reconnectRequired });
  const changed = () => { onChange(status()); };
  function manifest(current = instance, currentGeneration = generation, selection = current.selection, activePhase = phase === 'ready' ? 'ready' : phase === 'stopped' ? 'stopped' : 'switching') {
    const stateDir = resolve(current.stateDir);
    return { api_version: 'worldfixture.active-generation/v1', generation: currentGeneration, phase: activePhase, world: worldOf(current),
      artifactPath: resolve(current.artifactPath), stateDir, lockPath: join(stateDir, 'environment.lock.json'), credentialsPath: join(stateDir, 'credentials.json'),
      bindingsPath: join(stateDir, 'bindings.json'), addressesPath: join(stateDir, 'addresses.json'), selection: selection ?? null, reconnect_required: reconnectRequired };
  }
  function journal(stage, extra = {}) {
    transition = { ...transition, phase: stage, ...extra }; atomicJson(join(sessionRoot, JOURNAL), transition); changed();
  }
  function gate(expected, mutation) {
    if (stopping || phase === 'stopped') throw new SessionError('session_stopped', 'The session is stopped');
    if (phase !== 'ready') throw new SessionError('session_transition', 'A world transition is in progress');
    if ((mutation && typeof expected !== 'string') || (expected !== undefined && expected !== generation)) throw new SessionError('stale_generation', 'Select the current world generation before this action', 409, { generation });
  }
  function withGeneration(expected, work, { mutation = false } = {}) {
    gate(expected, mutation);
    const acceptedGeneration = generation, acceptedInstance = instance;
    const stale = () => generation !== acceptedGeneration || phase !== 'ready';
    const staleError = () => new SessionError('stale_generation', 'The world changed while this request was running', 409, { generation });
    const result = Promise.resolve().then(() => work(acceptedInstance, { generation: acceptedGeneration })).then(value => {
      if (stale()) throw staleError();
      return value;
    }, error => { if (stale()) throw staleError(); throw error; });
    if (mutation) { mutations.add(result); result.finally(() => mutations.delete(result)).catch(() => {}); }
    return result;
  }
  async function commit(current, nextGeneration, selection, stage) {
    current.generation = nextGeneration; current.selection = selection; current.sessionManager = manager;
    await activate(current, { generation: nextGeneration, setup: true, reconnectRequired: true });
    await publish(current, { generation: nextGeneration, selection });
    reconnectRequired = true;
    // Commit the journal first. Until the pointer is ready, readers still see
    // switching; interrupted commits are rejected by assertSessionRecoverable.
    transition = { ...transition, phase: stage, recovery_required: false, active_generation: nextGeneration };
    atomicJson(join(sessionRoot, JOURNAL), transition);
    atomicJson(join(sessionRoot, ACTIVE), manifest(current, nextGeneration, selection, 'ready'));
    instance = current; generation = nextGeneration; phase = 'ready'; changed();
  }
  function optionsFor(candidate, id, retained, old) {
    const fixedPorts = startOptions.fixedPorts ? { ...startOptions.fixedPorts } : undefined;
    // Process mode can reuse compatible provider ports after the old children stop.
    const preferred = fixedPorts ?? {};
    for (const service of candidate.lock.services) for (const port of service.ports) {
      const key = `${service.name}/${port.name}`, previous = old.allocation.get(key);
      if (previous && previous.protocol === port.protocol && previous.published === port.published) preferred[key] = previous.number;
    }
    // allocate requires every key when fixedPorts exists. For new process ports,
    // zero means ask the kernel; image mappings remain fixed from startOptions.
    if (!fixedPorts) for (const service of candidate.lock.services) for (const port of service.ports) preferred[`${service.name}/${port.name}`] ??= 0;
    return { ...startOptions, artifactPath: candidate.artifactPath, stateDir: candidate.stateDir ?? join(sessionRoot, 'generations', id, 'runtime'),
      generation: id, preservedChildren: retained.children, preservedAllocation: retained.allocation, preservedCredentials: retained.credentials,
      fixedPorts: preferred, runtimeToken: randomUUID(), manageSignals: false, onSpawned: undefined };
  }
  async function performSwitch(input, nextGeneration, old, oldGeneration) {
    let candidate, retained, touched = false, next;
    const oldSelection = old.selection;
    try {
      candidate = await prepareSelection(input, { generation: nextGeneration });
      if (!candidate?.lock || !candidate.artifactPath || !candidate.world) throw new SessionError('invalid_switch_candidate', 'Switch preparation did not return a verified world', 400);
      retained = retainedParts(old, candidate.lock);
      journal('quiescing', { next_world: candidate.lock.world });
      // Stop current claims first, then wait for other already accepted writes.
      touched = true;
      await old.timelineControl?.stop();
      await Promise.allSettled([...mutations]);
      await unpublish();
      await old.stopChildren({ services: old.children.filter(record => !retained.names.has(record.service)).map(record => record.service) });
      forgetSlackCaches(); journal('starting');
      next = await start(candidate.lock, optionsFor(candidate, nextGeneration, retained, old));
      copyReceipts(old.state, next.state);
      next.environmentSpec = candidate.spec;
      journal('publishing'); await commit(next, nextGeneration, candidate.selection, 'complete');
      old.state.close();
      return status();
    } catch (error) {
      if (!touched) {
        phase = 'ready'; atomicJson(join(sessionRoot, ACTIVE), manifest(old, oldGeneration, oldSelection, 'ready'));
        journal('rolled-back', { recovery_required: false, error: error.message, providers_changed: false });
        throw error;
      }
      if (next) await next.stop({ preserveServices: [...retained.names] }).catch(() => {});
      await old.stopChildren({ services: old.children.filter(record => !retained.names.has(record.service)).map(record => record.service) });
      const rollbackGeneration = randomUUID();
      journal('rolling-back', { rollback_generation: rollbackGeneration, error: error.message });
      let restored;
      try {
        const fallback = { lock: old.lock, artifactPath: old.artifactPath, stateDir: join(sessionRoot, 'generations', rollbackGeneration, 'runtime'), selection: oldSelection };
        restored = await start(fallback.lock, optionsFor(fallback, rollbackGeneration, retained, old));
        copyReceipts(old.state, restored.state);
        restored.environmentSpec = old.environmentSpec;
        await commit(restored, rollbackGeneration, oldSelection, 'rolled-back');
        old.state.close();
      } catch (recoveryError) {
        if (restored) await restored.stop({ preserveServices: [...retained.names] }).catch(() => {});
        phase = 'stopped'; reconnectRequired = true;
        atomicJson(join(sessionRoot, ACTIVE), manifest(old, oldGeneration, oldSelection, 'stopped'));
        journal('failed', { recovery_required: true, error: error.message, recovery_error: recoveryError.message });
        throw new SessionError('switch_recovery_required', 'The switch and baseline recovery failed; providers remain stopped', 409, { ...status(), repair: 'Inspect session-transition.json before starting another world. Application services and data were preserved.' });
      }
      throw new SessionError('switch_failed_rolled_back', 'The switch failed. The previous world baseline was restored in setup mode; manual provider changes were discarded', 409,
        { ...status(), cause: error.message, rollback_baseline_restored: true, manual_provider_changes_lost: true });
    }
  }
  const manager = {
    get instance() { return instance; }, get generation() { return generation; }, status, withGeneration,
    async publishInitial() { await publish(instance, { generation, selection: instance.selection }); atomicJson(join(sessionRoot, ACTIVE), manifest()); return status(); },
    switchWorld(input, expectedGeneration) {
      gate(expectedGeneration, true);
      const nextGeneration = randomUUID(), old = instance, oldGeneration = generation;
      phase = 'switching';
      transition = { api_version: 'worldfixture.session-transition/v1', id: randomUUID(), from_generation: oldGeneration, to_generation: nextGeneration, phase: 'preparing', recovery_required: true };
      atomicJson(join(sessionRoot, ACTIVE), manifest(old, oldGeneration, old.selection, 'switching')); journal('preparing');
      switching = performSwitch(input, nextGeneration, old, oldGeneration);
      switching.finally(() => { switching = null; }).catch(() => {});
      return switching;
    },
    clockCommand(command, expectedGeneration) {
      return withGeneration(expectedGeneration, current => {
        if (reconnectRequired && ['start', 'resume', 'advance'].includes(command?.action)) throw new SessionError('application_reconnect_required', 'Confirm the current application mapping before timeline delivery');
        return current.timelineControl.command(command?.action === 'reset' && reconnectRequired ? { ...command, preserveSetup: true } : command);
      }, { mutation: true });
    },
    confirmConnection(input, expectedGeneration) {
      return withGeneration(expectedGeneration, async (current, accepted) => {
        if (typeof confirm !== 'function') throw new SessionError('application_mapping_unavailable', 'Application mapping confirmation is not configured');
        await confirm(current, input, { generation: accepted.generation });
        if (generation !== accepted.generation || phase !== 'ready') throw new SessionError('stale_generation', 'The world changed before application confirmation completed', 409, { generation });
        reconnectRequired = false; atomicJson(join(sessionRoot, ACTIVE), manifest()); changed(); return status();
      }, { mutation: true });
    },
    async stop() {
      if (phase === 'stopped' && !instance.state.isOpen) return;
      stopping = true;
      await switching?.catch(() => {});
      await instance.timelineControl?.stop(); await Promise.allSettled([...mutations]); await instance.stop(); phase = 'stopped';
      atomicJson(join(sessionRoot, ACTIVE), manifest()); changed();
    },
  };
  instance.sessionManager = manager;
  return manager;
}
