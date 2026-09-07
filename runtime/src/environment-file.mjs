import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, ResolutionError } from './resolve.mjs';
import { assertValid, loadSchema } from './schema.mjs';

export const ENVIRONMENT_REQUEST_FILE = 'environment-request.json';

export function readEnvironmentFile(path) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
    assertValid(spec, loadSchema(join(import.meta.dirname, '../../schemas/environment.v1.schema.json')), 'Environment');
  } catch (error) {
    throw new ResolutionError('invalid_environment', `Cannot load environment ${path}: ${error.message}`);
  }
  if ((spec.target?.kind && spec.target.kind !== 'none') || spec.target?.command || spec.experience) {
    throw new ResolutionError('invalid_environment', 'CLI environments start providers only. Use target.kind "none" and worldfixture run to start the application.');
  }
  return spec;
}

export function configuredEnvironment(spec, world, identity) {
  const result = structuredClone(spec);
  result.world = { ...result.world, use: world };
  result.execution ??= { mode: 'selected-capabilities' };
  result.target = { kind: 'none', ...(identity ? { identity } : {}), ...result.target };
  return result;
}

// A repeated up must not claim a different capability or binding selection.
export function verifyEnvironmentRequest(stateDir, requested) {
  let previous;
  try { previous = JSON.parse(readFileSync(join(stateDir, ENVIRONMENT_REQUEST_FILE), 'utf8')); } catch {}
  if (previous === undefined || canonical(previous) !== canonical(requested)) {
    throw new ResolutionError('environment_selection_changed', 'The running instance uses a different environment. Run worldfixture down before starting this environment.');
  }
}
