import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureGeneratedSecrets } from "./generated-secrets.mjs";

export const CREDENTIALS_VERSION = "worldfixture.credentials/v1";
export const CREDENTIALS_FILE = "credentials.json";

export function credential(credentials, reference) {
  const value = credentials?.values?.[reference];
  if (typeof value !== "string" || !value) {
    throw new Error(`this run has no credential for ${reference}; restore its credentials or restart the instance`);
  }
  return value;
}

export function readRunCredentials(stateDir, world) {
  const path = join(stateDir, CREDENTIALS_FILE);
  let credentials;
  try { credentials = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`cannot read this run's credentials at ${path}; restore the file or restart the instance`); }
  if (credentials?.api_version !== CREDENTIALS_VERSION || !credentials.values
    || typeof credentials.values !== "object" || Array.isArray(credentials.values)
    || Object.values(credentials.values).some(value => typeof value !== "string" || !value)) {
    throw new Error(`invalid run credentials at ${path}; restore the file or restart the instance`);
  }
  if (world && (credentials.world?.id !== world.id || credentials.world?.version !== String(world.version))) {
    throw new Error("this run's credentials belong to a different world");
  }
  return credentials;
}

// The compiler and tests/parity are outside this credential scheme. Readable
// artifact keys retain identities and permissions. Only startup resolves them
// to project secrets, then publishes a fixed credential set for this run.
export async function prepareCredentials({ lock, artifactPath, stateDir, generatedSecretsPath }) {
  const references = new Map();
  const add = reference => references.set(reference, `world:${lock.world.id}:${reference}`);
  const overlayPath = join(artifactPath, "projections/emulator-overlay.json");
  if (existsSync(overlayPath)) {
    const overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
    for (const reference of Object.keys(overlay.tokens ?? {})) add(`token:${reference}`);
    if (overlay.twilio?.account) add("twilio:account:auth_token");
    for (const key of overlay.twilio?.api_keys ?? []) add(`twilio:api_key:${key.sid}`);
    for (const user of overlay.clerk?.users ?? []) {
      if (user.password) add(`clerk:password:${user.email_addresses?.[0] ?? user.username}`);
    }
  }
  const mailPath = join(artifactPath, "projections/mail.json");
  if (existsSync(mailPath)) {
    const mail = JSON.parse(readFileSync(mailPath, "utf8"));
    for (const user of mail.users ?? []) add(user.password_ref);
    add("mail-password:cyrus-admin");
  }
  // Preserve the Part A service keys across the upgrade.
  const sources = [...Object.values(lock.bindings ?? {}), ...lock.services.flatMap(service => service.environment ?? [])];
  for (const source of sources) {
    const key = source.from === "generated" ? source.key : source.password_from === "generated" ? source.password_key : null;
    if (key) references.set(key, key);
  }
  const stored = await ensureGeneratedSecrets(generatedSecretsPath, references.values());
  const credentials = {
    api_version: CREDENTIALS_VERSION,
    world: { id: lock.world.id, version: String(lock.world.version) },
    values: Object.fromEntries([...references].map(([reference, key]) => [reference, stored[key]])),
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, CREDENTIALS_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return credentials;
}
