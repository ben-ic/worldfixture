import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTokenReference } from './bindings.mjs';

export function worldPathValue(world, path) {
  const canonical = path.replace(/\.v\d+$/, '').replace(/^identity\./, '');
  return canonical.split('.').reduce((value, key) => value?.[key], world);
}
export function capabilityWorld(manifest, capability) {
  return capability.world ?? manifest.world ?? {};
}
export function capabilityProjections(manifest, capabilities) {
  const rows = capabilities.flatMap(capability => {
    const world = capabilityWorld(manifest, capability);
    return world.projections ?? (world.projection ? [{ file: world.projection }] : []);
  });
  return [...new Map(rows.map(row => [`${row.file}:${row.subtree ?? ''}`, row])).values()];
}
export function capabilityWorldErrors(manifest, capability, { world, artifact, artifactPath, identity }) {
  const declaration = capabilityWorld(manifest, capability), errors = [];
  for (const path of declaration.requires ?? []) {
    if (worldPathValue(world, path) === undefined) errors.push(`missing world section or collection ${path}`);
  }
  for (const alternatives of declaration.any_requires ?? []) {
    if (!alternatives.some(path => worldPathValue(world, path) !== undefined)) errors.push(`missing one of world collections ${alternatives.join(', ')}`);
  }
  for (const requirement of declaration.identities ?? []) {
    const collection = worldPathValue(world, requirement.collection);
    if (!Array.isArray(collection)) { errors.push(`missing identity collection ${requirement.collection}`); continue; }
    const rows = requirement.scope === 'target' ? collection.filter(row => row.id === identity) : collection;
    if (requirement.scope === 'target' && rows.length !== 1) errors.push('selected capability needs an explicit world person');
    for (const row of rows) for (const field of requirement.fields) {
      if (typeof row[field] !== 'string' || !row[field]) errors.push(`person ${row.id ?? '(missing ID)'} needs ${field}`);
    }
  }
  for (const projection of capabilityProjections(manifest, [capability])) {
    if (!artifact.files?.[projection.file] && !['world.json', 'manifest.json'].includes(projection.file)) { errors.push(`missing artifact projection ${projection.file}`); continue; }
    if (projection.subtree) {
      try {
        const value = JSON.parse(readFileSync(join(artifactPath, projection.file), 'utf8'));
        const selected = projection.subtree.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((node, key) => node?.[key], value);
        if (selected === undefined || selected === null) errors.push(`missing declared projection subtree ${projection.file}${projection.subtree}`);
      } catch { errors.push(`cannot read declared projection ${projection.file}`); }
    }
  }
  return errors;
}

export function selectCompatibleCapabilities(spec, { manifests, artifactPath, explicitProfiles = [] }) {
  const world = JSON.parse(readFileSync(join(artifactPath, 'world.json'), 'utf8'));
  const artifact = JSON.parse(readFileSync(join(artifactPath, 'manifest.json'), 'utf8'));
  const identity = spec.target?.identity ?? world.people?.find(person => person.primary)?.id;
  const accepted = new Set();
  for (const profile of spec.requires) {
    const candidates = manifests.flatMap(manifest => manifest.provides.filter(capability => capability.profile === profile).map(capability => ({ manifest, capability })));
    const failures = candidates.map(({ manifest, capability }) => capabilityWorldErrors(manifest, capability, { world, artifact, artifactPath, identity }));
    if (failures.some(errors => errors.length === 0)) accepted.add(profile);
    else if (explicitProfiles.includes(profile)) throw new Error(`${world.id}:${world.version}: ${profile} is not compatible: ${failures.flat().join('; ') || 'no declared provider'}`);
  }
  const bindingDiagnostics = [];
  const bindings = Object.fromEntries(Object.entries(spec.bindings).filter(([name, ref]) => {
      const [profile, attribute] = ref.split('/');
      if (!accepted.has(profile)) return false;
      const binding = manifests.flatMap(manifest => manifest.provides).find(capability => capability.profile === profile)?.binds?.find(row => row.name === attribute);
      if (!identity && binding?.per_person) { bindingDiagnostics.push({ binding: name, status: 'not-selected', reason: 'No target identity or authored primary person is declared' }); return false; }
      if (binding?.from === 'projection' && binding.pointer === '/tokens') {
        let declared = false;
        try { declared = Boolean(resolveTokenReference(artifactPath, { profile, ...(binding.per_person ? { person: identity } : {}) }).reference); } catch {}
        if (!declared && binding.per_person) throw new Error(`${world.id}:${world.version}: ${name} requires a declared ${profile} credential for person ${identity}`);
        if (!declared) { bindingDiagnostics.push({ binding: name, status: 'not-selected', reason: 'No declared authentication token for this target and capability' }); return false; }
      }
      return true;
    }));
  return { ...spec, requires: spec.requires.filter(profile => accepted.has(profile)), bindings,
    execution: { ...spec.execution, binding_diagnostics: bindingDiagnostics },
    target: { ...spec.target, ...(identity ? { identity } : {}) } };
}
