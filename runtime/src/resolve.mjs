// The environment resolver: one environment specification plus the available
// service manifests and one world artifact, in; one immutable environment lock,
// out.
//
// WHAT THE LOCK IS FOR. It pins the exact service implementation behind each
// capability, so that an existing lock never follows a newer world or service
// release. Everything here therefore resolves to a name
// and a digest, never to a number: ports are allocated per run by the CLI, so the
// same specification, artifact and manifests produce byte-identical lock bytes.
// `resolveEnvironment` is a pure function of its inputs and reads no clock.
//
// THE TWO OWNERSHIP RULES IT HAS TO GET RIGHT, both found while extracting the
// first services out of the original platform, and both of which a resolver
// keyed on capability names alone gets wrong:
//
//   * S3 HAS EXACTLY ONE OWNER. SeaweedFS is the S3 implementation. The
//     composer's AWS vendor also serves a live, writable `/s3/` -- measured, not
//     assumed -- so withholding its projection was never enough. The composer
//     declares that surface under `disclaims`, and `closeDisclaimedSurfaces`
//     below shuts the port rather than trusting the omission. When the port
//     cannot be shut because something else selected needs it, that is a real
//     conflict and resolution fails by name.
//
//   * CYRUS AND GMAIL ARE NOT RIVALS. They carry the same person's mail on
//     purpose: one is the world's own mailbox over IMAP, the other is the
//     integration surface an application is built against. They are separate
//     capabilities that share source records, so nothing here groups profiles
//     into families or allows one implementation per family. A rule of that
//     shape would refuse a legitimate pairing -- and, worse, would let a real
//     conflict through whenever two rivals happened to sit in different
//     families.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { disclaimersOf, portsByName, projectionsOf, providersOf, readinessChecks } from "./manifests.mjs";

export const API_VERSION = "worldfixture.environment/v1";
export const LOCK_API_VERSION = "worldfixture.environment-lock/v1";

export class ResolutionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "ResolutionError";
    this.code = code;
    this.detail = detail;
  }
}

// Canonical JSON, matching the compiler's: sorted keys, no incidental whitespace.
// The lock is digested and compared, so its bytes have to be a function of its
// content and nothing else.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const body = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

// ---- the world -----------------------------------------------------------

function resolveWorld(spec, artifactPath) {
  const manifest = JSON.parse(readFileSync(join(artifactPath, "manifest.json"), "utf8"));
  const world = JSON.parse(readFileSync(join(artifactPath, "world.json"), "utf8"));

  const asked = spec.world.use;
  // `world.version` already carries its own `v`; the schema pattern is `^v[0-9]+$`.
  const actual = `${world.id}:${world.version}`;

  if (asked !== actual) {
    throw new ResolutionError(
      "world_mismatch",
      `the environment asks for ${asked} and the artifact at ${artifactPath} is ${actual}`,
      { asked, actual },
    );
  }

  return { manifest, world };
}

// ---- capabilities --------------------------------------------------------

function selectImplementations(spec, manifests) {
  const providers = providersOf(manifests);
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const chosen = new Map();

  const required = [...spec.requires];
  for (let index = 0; index < required.length; index += 1) {
    const profile = required[index];
    if (chosen.has(profile)) continue;
    const candidates = providers.get(profile) ?? [];

    if (candidates.length === 0) {
      throw new ResolutionError(
        "capability_not_available",
        `no available service provides ${profile}`,
        { profile },
      );
    }

    let name = candidates[0];

    if (candidates.length > 1) {
      // Two services claiming one profile is the conflict the design forbids.
      // The resolver does not pick; an environment says which, or it fails.
      const preferred = spec.prefer?.[profile];
      if (!preferred) {
        throw new ResolutionError(
          "capability_ambiguous",
          `${profile} is provided by ${candidates.join(" and ")}; name one under prefer`,
          { profile, candidates },
        );
      }
      if (!candidates.includes(preferred)) {
        throw new ResolutionError(
          "capability_not_available",
          `prefer names ${preferred} for ${profile}, which provides ${candidates.join(" and ")} do not include`,
          { profile, preferred, candidates },
        );
      }
      name = preferred;
    }

    const manifest = byName.get(name);
    const entry = manifest.provides.find((p) => p.profile === profile);

    if (!entry.port) {
      throw new ResolutionError(
        "capability_not_bindable",
        `${name} provides ${profile} without naming a port, so it cannot be turned into a binding`,
        { profile, service: name },
      );
    }

    chosen.set(profile, { service: name, port: entry.port, entry, manifest });
    for (const dependency of entry.requires ?? []) {
      if (!required.includes(dependency.profile)) required.push(dependency.profile);
    }
  }

  return chosen;
}

function dependencyEnvironment(record, chosen) {
  const environment = [];
  const names = new Set();
  for (const profile of [...record.profiles].sort()) {
    const selection = chosen.get(profile);
    for (const dependency of selection.entry.requires ?? []) {
      const target = chosen.get(dependency.profile);
      if (!target) {
        throw new ResolutionError("dependency_not_available", `${profile} requires ${dependency.profile}`, {
          profile, dependency: dependency.profile,
        });
      }
      const bind = (target.entry.binds ?? []).find((entry) => entry.name === dependency.bind);
      if (!bind || !["port.url", "port.host_port"].includes(bind.from)) {
        throw new ResolutionError(
          "dependency_not_bindable",
          `${profile} requires ${dependency.profile}/${dependency.bind}, which is not a port binding`,
          { profile, dependency: dependency.profile, bind: dependency.bind },
        );
      }
      if (names.has(dependency.environment)) continue;
      names.add(dependency.environment);
      environment.push({
        name: dependency.environment,
        from: `capability.${bind.from}`,
        profile: dependency.profile,
        attribute: dependency.bind,
        service: target.service,
        port: target.port,
        required: true,
      });
    }
  }
  return environment;
}

// ---- ports ---------------------------------------------------------------

// Which ports a run opens for one service.
//
// A non-optional port is opened whether or not an application calls it: SeaweedFS
// will not start without its master and volume ports. An optional port is opened
// only when something needs it, which is what makes the composer pay for the
// vendors a run actually uses instead of all fourteen.
function portsToOpen(manifest, selectedPorts) {
  const declared = portsByName(manifest);
  const wanted = new Set();

  for (const port of manifest.runtime.ports) {
    if (!port.optional) wanted.add(port.name);
  }
  for (const name of selectedPorts) wanted.add(name);

  // A seed gate is service-wide: it answers "did the world finish loading", so it
  // is kept whichever capabilities were selected. A protocol check is about one
  // surface and is kept only when that surface is open.
  const checks = readinessChecks(manifest).filter(
    (check) => check.kind === "seed_gate" || wanted.has(check.port),
  );
  for (const check of checks) wanted.add(check.port);

  for (const name of wanted) {
    if (!declared.has(name)) {
      throw new ResolutionError(
        "port_not_declared",
        `${manifest.name} references a port "${name}" that runtime.ports does not declare`,
        { service: manifest.name, port: name },
      );
    }
  }

  return { wanted, checks };
}

// ---- the S3 rule ---------------------------------------------------------

// Shut every port that serves a surface its own service disclaims and another
// selected service owns.
//
// Being explicit about what this does and does not prove: it keeps the second
// implementation off the network for this run. It does not remove the routes,
// and a service that serves an unclaimed surface without disclaiming it is still
// invisible here -- `provides` is a declaration, and so is `disclaims`.
function closeDisclaimedSurfaces(selected, manifests, ownedProfiles) {
  const disclaimers = disclaimersOf(manifests);
  const closed = [];

  for (const [profile, entries] of [...disclaimers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const owner = ownedProfiles.get(profile);
    if (!owner) continue;

    for (const entry of entries) {
      const service = selected.get(entry.service);
      if (!service) continue;

      const declared = portsByName(service.manifest).get(entry.port);

      if (!declared.optional) {
        throw new ResolutionError(
          "capability_conflict",
          `${entry.service} serves ${profile}, which ${owner} owns, on a port it cannot start without`,
          { profile, owner, disclaimed_by: entry.service, port: entry.port },
        );
      }

      // The port may be open because another capability needs it. Two owners of
      // one provider's mutable state is what the design forbids, so this fails
      // rather than choosing which caller to disappoint.
      const alsoNeeded = [...service.profilePorts]
        .filter(([, port]) => port === entry.port)
        .map(([selectedProfile]) => selectedProfile);

      if (alsoNeeded.length > 0) {
        throw new ResolutionError(
          "capability_conflict",
          `${entry.service} serves ${profile}, which ${owner} owns, on the same port as ` +
            `${alsoNeeded.join(", ")}; select one implementation or drop the other capability`,
          { profile, owner, disclaimed_by: entry.service, port: entry.port, blocked_by: alsoNeeded },
        );
      }

      // The port is shut whether it was going to open or not. Recording it
      // either way is the point: a port that stays closed leaves no trace in the
      // running system, so the lock is the only place the reason survives.
      service.ports.delete(entry.port);
      closed.push({
        profile,
        owner,
        disclaimed_by: entry.service,
        port: entry.port,
        action: "port_closed",
        reason: entry.reason,
      });
    }
  }

  return closed;
}

// ---- bindings ------------------------------------------------------------

function resolveBindings(spec, chosen) {
  const bindings = {};

  for (const name of Object.keys(spec.bindings ?? {}).sort()) {
    const [profile, attribute] = spec.bindings[name].split("/");
    const selection = chosen.get(profile);

    if (!selection) {
      throw new ResolutionError(
        "binding_not_required",
        `${name} binds ${profile}, which this environment does not require`,
        { binding: name, profile },
      );
    }

    const bind = (selection.entry.binds ?? []).find((b) => b.name === attribute);

    if (!bind) {
      throw new ResolutionError(
        "binding_not_declared",
        `${selection.service} does not declare a "${attribute}" attribute on ${profile}`,
        { binding: name, profile, attribute },
      );
    }

    // A per-person credential belonging to nobody is how every token in this
    // world once resolved to the default admin. There is no anonymous default.
    if (bind.per_person && !spec.target?.identity) {
      throw new ResolutionError(
        "identity_required",
        `${name} binds ${profile}/${attribute}, which resolves per person; set target.identity`,
        { binding: name, profile, attribute },
      );
    }

    bindings[name] = {
      service: selection.service,
      profile,
      attribute,
      from: bind.from,
      port: selection.port,
      pointer: bind.pointer,
      file: bind.file,
      value: bind.value,
      scheme: bind.scheme,
      username: bind.username,
      password: bind.password,
      database: bind.database,
      person: bind.per_person ? spec.target.identity : undefined,
    };
  }

  return bindings;
}

// ---- resolution ----------------------------------------------------------

export function resolveEnvironment(spec, { manifests, artifactPath }) {
  if (spec.api_version !== API_VERSION) {
    throw new ResolutionError(
      "unknown_api_version",
      `environment api_version is ${spec.api_version}, expected ${API_VERSION}`,
      { api_version: spec.api_version },
    );
  }

  const { manifest: artifact, world } = resolveWorld(spec, artifactPath);
  artifact.files = artifact.files ?? {};
  const chosen = selectImplementations(spec, manifests);

  // Which service owns each profile any selected service could serve. Used only
  // to decide whether a disclaimed surface has a real owner in this run.
  const ownedProfiles = new Map();
  for (const { service, entry } of chosen.values()) ownedProfiles.set(entry.profile, service);

  const selected = new Map();
  for (const { service, port, profile, manifest } of [...chosen].map(([profile, v]) => ({ ...v, profile }))) {
    if (!selected.has(service)) {
      selected.set(service, { manifest, profiles: new Set(), profilePorts: new Map(), ports: new Set() });
    }
    const record = selected.get(service);
    record.profiles.add(profile);
    record.profilePorts.set(profile, port);
  }

  for (const record of selected.values()) {
    const { wanted, checks } = portsToOpen(record.manifest, new Set(record.profilePorts.values()));
    record.ports = wanted;
    record.checks = checks;
  }

  const closedConflicts = closeDisclaimedSurfaces(selected, manifests, ownedProfiles);

  // Every open, published port has to be provable. A run that cannot prove a
  // surface is answering has no business reporting itself ready, and this is
  // where that becomes a refusal instead of a later guess at a log line.
  for (const [name, record] of selected) {
    const proven = new Set(
      record.checks.filter((check) => check.kind === "protocol" && record.ports.has(check.port)).map((c) => c.port),
    );
    const declared = portsByName(record.manifest);

    for (const port of [...record.ports].sort()) {
      if (!declared.get(port).published) continue;
      if (proven.has(port)) continue;
      throw new ResolutionError(
        "capability_not_provable",
        `${name} would publish port "${port}" with no protocol readiness check, so readiness could not be aggregated on it`,
        { service: name, port },
      );
    }
  }

  return buildLock(spec, { artifact, world, chosen, selected, closedConflicts, artifactPath });
}

function buildLock(spec, { artifact, world, chosen, selected, closedConflicts, artifactPath }) {
  const projections = {};

  for (const [name, record] of [...selected].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const entry of projectionsOf(record.manifest)) {
      const file = entry.file;
      const digest = artifact.files?.[file];

      // world.json and manifest.json are the artifact's own spine and are not
      // listed among its files; everything else must be.
      if (!digest && !["world.json", "manifest.json"].includes(file)) {
        throw new ResolutionError(
          "projection_not_in_artifact",
          `${name} reads ${file}, which the artifact manifest does not list`,
          { service: name, file },
        );
      }

      if (!projections[file]) {
        // `manifest.json` cannot carry its own digest, so it is hashed from
        // disk. Everything else must be a digest the artifact already declares,
        // or the lock would pin a number nothing else agrees with.
        const bytes = digest ? null : readFileSync(join(artifactPath, file));
        projections[file] = {
          sha256: digest?.sha256 ?? sha256(bytes),
          size: digest?.size ?? bytes.length,
          read_by: [],
          verified_by: [],
        };
      }
      projections[file].read_by.push(name);
      if (entry.verified) projections[file].verified_by.push(name);
    }
  }

  for (const value of Object.values(projections)) {
    value.read_by.sort();
    value.verified_by.sort();
  }

  const services = [...selected]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, record]) => {
      const declared = portsByName(record.manifest);
      return {
        name,
        version: record.manifest.version,
        manifest_sha256: record.manifest.manifest_sha256,
        image: record.manifest.runtime.image,
        command: record.manifest.runtime.command,
        container: record.manifest.runtime.container,
        profiles: [...record.profiles].sort(),
        ports: [...record.ports]
          .sort()
          .map((port) => ({ ...declared.get(port), published: Boolean(declared.get(port).published) })),
        readiness: record.checks
          .filter((check) => record.ports.has(check.port))
          .sort((a, b) => (a.port < b.port ? -1 : 1)),
        environment: [
          ...(record.manifest.runtime.environment ?? []),
          ...dependencyEnvironment(record, chosen),
        ],
        projections: projectionsOf(record.manifest),
        lifecycle: record.manifest.lifecycle ?? {},
      };
    });

  const capabilities = {};
  for (const profile of [...chosen.keys()].sort()) {
    const { service, port } = chosen.get(profile);
    capabilities[profile] = { service, port };
  }

  const lock = {
    api_version: LOCK_API_VERSION,
    environment_sha256: sha256(canonical(spec)),
    world: {
      id: world.id,
      version: String(world.version),
      profile: world.profile,
      artifact_sha256: artifact.artifact_sha256,
      content_sha256: artifact.content_sha256,
      projections,
    },
    services,
    capabilities,
    bindings: resolveBindings(spec, chosen),
    // The world's own rules and the run's, pinned together. A run applies
    // exactly these; a rule added later is a new lock.
    rules: [...(world.agentic?.causal_rules ?? []), ...(spec.rules ?? [])],
    closed_conflicts: closedConflicts,
    target: spec.target ?? { kind: "none" },
  };

  return prune(lock);
}

// A lock is compared, digested and written, so the object in memory has to be
// the object on disk. JSON has no `undefined`, and an optional field left unset
// would otherwise be present in one and absent in the other.
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, prune(entry)]),
    );
  }
  return value;
}

// The bytes a lock is written and compared as.
export function serializeLock(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`;
}
