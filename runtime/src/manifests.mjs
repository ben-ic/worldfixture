// Loading the service manifests, and the two facts about them the resolver needs
// that no single manifest states.
//
// A manifest describes one service. Two questions the resolver asks are about the
// SET of manifests: which service provides a capability, and which service serves
// a capability it does not own. Neither can be answered from one file, so both are
// computed here rather than assumed anywhere downstream.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILE = "service.json";
export const API_VERSION = "worldfixture.service/v1";

// The digest the lock pins. Taken over the bytes on disk, not over a re-serialized
// object, so a manifest edited in any way at all produces a different lock.
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadManifest(path) {
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes.toString("utf8"));

  if (manifest.api_version !== API_VERSION) {
    throw new Error(`${path}: api_version is ${manifest.api_version}, expected ${API_VERSION}`);
  }

  return { ...manifest, manifest_sha256: digest(bytes) };
}

// Every service directory that publishes a manifest. A directory without one is
// not a service yet and is skipped rather than guessed at.
export function loadManifests(root) {
  const services = [];

  for (const name of readdirSync(root).sort()) {
    const path = join(root, name, MANIFEST_FILE);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const manifest = loadManifest(path);
    if (manifest.name !== name) {
      throw new Error(`${path}: manifest names "${manifest.name}" but sits in "${name}"`);
    }
    services.push(manifest);
  }

  return services;
}

// profile -> [service names that claim it]. More than one is not resolved here:
// the resolver reports it, because choosing an implementation for the user is
// exactly what an environment specification is for.
export function providersOf(manifests) {
  const index = new Map();

  for (const manifest of manifests) {
    for (const entry of manifest.provides) {
      if (!index.has(entry.profile)) index.set(entry.profile, []);
      index.get(entry.profile).push(manifest.name);
    }
  }

  return index;
}

// profile -> [{service, port, reason}] for every surface a service serves and
// does not own.
//
// Extra routes for a capability owned by another service must be declared.
// Index those routes so the resolver can close their ports or reject a conflict.
export function disclaimersOf(manifests) {
  const index = new Map();

  for (const manifest of manifests) {
    for (const entry of manifest.disclaims ?? []) {
      if (!index.has(entry.profile)) index.set(entry.profile, []);
      index.get(entry.profile).push({
        service: manifest.name,
        port: entry.port,
        reason: entry.reason,
      });
    }
  }

  return index;
}

export function portsByName(manifest) {
  return new Map(manifest.runtime.ports.map((port) => [port.name, port]));
}

// The original draft allowed one readiness object; the revision allows a list.
// Both still validate, so every reader normalizes rather than assuming.
export function readinessChecks(manifest) {
  const declared = manifest.runtime.readiness;
  const checks = Array.isArray(declared) ? declared : [declared];
  return checks.map((check) => ({ kind: "protocol", ...check }));
}
