import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const GENERATED_SECRETS_FILE = "generated-secrets.json";

// Only startup writes the project store. The directory lock serializes starts
// from different terminals; rename publishes the complete file atomically.
export async function ensureGeneratedSecrets(path, keys) {
  if (!path) throw new Error("startup has no project credential store");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`credential store is locked at ${lock}; check for another startup before removing a stale lock`);
      await delay(25);
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let values;
    try { values = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw new Error(`cannot read project credentials at ${path}; restore the file before startup`);
      values = {};
    }
    if (!values || typeof values !== "object" || Array.isArray(values)
      || Object.values(values).some(value => typeof value !== "string" || !value)) {
      throw new Error(`invalid project credentials at ${path}; restore the file before startup`);
    }
    for (const key of keys) {
      if (!Object.hasOwn(values, key)) values[key] = randomBytes(24).toString("hex");
    }
    writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return values;
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    rmdirSync(lock);
  }
}
