import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const GENERATED_SECRETS_FILE = "generated-secrets.json";

export function ensureGeneratedSecretStore(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, "{}\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return path;
}

// The file contains one stable value for each manifest key. It is outside the
// artifact and lock, so two builds stay equal and two projects do not share a
// credential.
export function readOrCreateGeneratedSecret(path, key) {
  if (!path) throw new Error(`generated secret ${key} has no project store`);
  ensureGeneratedSecretStore(path);
  const values = JSON.parse(readFileSync(path, "utf8"));
  if (typeof values[key] === "string" && values[key]) return values[key];

  values[key] = randomBytes(24).toString("hex");
  writeFileSync(path, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  return values[key];
}
