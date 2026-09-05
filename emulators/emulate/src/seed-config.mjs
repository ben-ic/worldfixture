import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// The only world-artifact shape this composer knows how to read, and the one file it
// reads out of an artifact. Both are stated here rather than assembled at the call
// site so the manifest lookup key and the path on disk cannot drift apart.
const WORLD_API_VERSION = "worldfixture.world-artifact/v1";
const OVERLAY_FILE = "projections/emulator-overlay.json";

// What a sample seed carries that a world has to declare for itself. Anything
// here is a credential or an application registration, not world content.
const CREDENTIAL_KEYS = [
  "oauth_apps",
  "oauth_clients",
  "oauth_applications",
  "integrations",
  "tokens",
  "api_keys",
];

export function loadSeedConfig({
  seedPath = "seed.yaml",
  worldPath,
  sessionOverlay,
  credentialsPath,
  log = () => {},
} = {}) {
  let seed = readObject(seedPath, "YAML", (body) => parseYaml(body) ?? {});

  if (worldPath) {
    const { overlay, projection } = readVerifiedWorldOverlay(worldPath);
    seed = deepMerge(seed, overlay);
    // A selected world owns the complete local Notion fixture. Do not merge a
    // sample workspace into it or retain the sample when the projection is
    // absent. This keeps separate worlds from sharing identities or content.
    seed.notion = structuredClone(overlay.notion ?? {});
    seed.tokens = structuredClone(overlay.tokens ?? {});
    // A compiled world owns provider identities and resources. Do not retain
    // the sample OAuth applications from seed.yaml when the world did not
    // declare them. Their fixed localhost callback URLs make a target app with
    // a fallback port fail before consent. With no declared application, the
    // local provider accepts the client configuration supplied by the target
    // app while it still validates state, code, redirect URI and token use.
    // EVERY vendor, and every credential the sample seed carries.
    //
    // This named slack, github and google, and the reason it gives applies to
    // all of them. What the other five kept was not cosmetic: `seed.yaml` ships
    // `lin_test_admin`, a Linear token with read, write, issues:create,
    // comments:create and admin scope belonging to
    // `admin@sample.worldfixture.test` -- a person no world declares -- and it
    // authenticated in every compiled world. Okta, Clerk, Vercel, Apple and
    // Twilio each carried a sample client secret or API key the same way.
    //
    // `main.mjs` spends thirty lines on why an unknown bearer token must not
    // become somebody. These arrived through the vendor's own store instead of
    // the composer's token map and skipped that argument entirely.
    // Over what the SEED carries, not what the overlay declares. Iterating the
    // overlay meant a vendor the world says nothing about -- which is every
    // vendor whose credentials leaked -- was never visited at all, so the sample
    // stayed exactly where it did the most harm.
    for (const [provider, sampled] of Object.entries(seed)) {
      if (provider === "tokens" || !sampled || typeof sampled !== "object") continue;
      const declared = overlay[provider];
      for (const key of CREDENTIAL_KEYS) {
        if (!declared || !(key in declared)) delete sampled[key];
      }
    }
    log(`world projection applied from ${projection}`);
  }

  if (sessionOverlay) {
    seed = deepMerge(seed, parseOverlay(sessionOverlay));
    log("session seed overlay applied");
  }

  if (credentialsPath) {
    let credentials;
    try { credentials = JSON.parse(readFileSync(credentialsPath, "utf8")); }
    catch { throw new Error("cannot read this run's credentials; restore the file or restart the instance"); }
    if (credentials.api_version !== "worldfixture.credentials/v1") throw new Error("invalid run credential format");
    const value = reference => {
      const secret = credentials.values?.[reference];
      if (typeof secret !== "string" || !secret) throw new Error(`this run has no credential for ${reference}`);
      return secret;
    };
    // The verified artifact contains identity references and permissions. Only
    // this in-memory seed uses the secrets prepared by the runtime at startup.
    seed.tokens = Object.fromEntries(Object.entries(seed.tokens ?? {}).map(([reference, subject]) => [value(`token:${reference}`), subject]));
    if (seed.twilio?.account) seed.twilio.account.auth_token = value("twilio:account:auth_token");
    for (const key of seed.twilio?.api_keys ?? []) key.secret = value(`twilio:api_key:${key.sid}`);
    for (const user of seed.clerk?.users ?? []) {
      if (user.password) user.password = value(`clerk:password:${user.email_addresses?.[0] ?? user.username}`);
    }
    if (credentials.values?.["token:demo_token"]) seed.worldfixture_google_token = value("token:demo_token");
  }

  return seed;
}

// The world artifact's emulator overlay, checked against the artifact's own manifest
// before a byte of it reaches a listener.
//
// WHY VERIFY AT ALL. This file decides who every seeded identity is and which bearer
// token resolves them. A truncated copy, a half-written download or an edit made after
// the artifact was compiled all produce a JSON document that parses — and then a
// fixture that quietly disagrees with the world it claims to serve. The manifest
// already carries a sha256 and a size per file; the cost of using them is one hash.
//
// It is deliberately a hard failure. Booting on an overlay that does not match the
// manifest means serving the wrong people under the right names, which is exactly the
// kind of wrong that is only noticed in front of somebody.
function readVerifiedWorldOverlay(worldPath) {
  const manifestPath = join(worldPath, "manifest.json");
  const manifest = readObject(manifestPath, "JSON", JSON.parse);

  if (manifest.api_version !== WORLD_API_VERSION) {
    throw new Error(
      `world artifact ${manifestPath} declares api_version ${JSON.stringify(manifest.api_version)}, ` +
        `and this emulator reads only "${WORLD_API_VERSION}". Recompile the world with a ` +
        `matching compiler, or point WORLDFIXTURE_WORLD_PATH at an artifact that is.`,
    );
  }

  const expected = manifest.files?.[OVERLAY_FILE];
  if (!expected || typeof expected.sha256 !== "string" || typeof expected.size !== "number") {
    throw new Error(
      `world artifact ${manifestPath} lists no sha256 and size for ${OVERLAY_FILE}, so the ` +
        `overlay cannot be verified. This artifact was not compiled with an emulator projection.`,
    );
  }

  const projection = join(worldPath, OVERLAY_FILE);
  let bytes;
  try {
    bytes = readFileSync(projection);
  } catch (err) {
    throw new Error(`cannot read JSON seed ${projection}: ${err.message}`);
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");

  if (actualSha256 !== expected.sha256 || bytes.length !== expected.size) {
    throw new Error(
      `${OVERLAY_FILE} does not match ${manifestPath}: the manifest declares sha256 ` +
        `${expected.sha256} (${expected.size} bytes) and ${projection} is sha256 ` +
        `${actualSha256} (${bytes.length} bytes). The world artifact is corrupt or was ` +
        `edited after it was compiled — recompile it rather than starting on it.`,
    );
  }

  let overlay;
  try {
    overlay = JSON.parse(bytes.toString("utf-8"));
  } catch (err) {
    throw new Error(`cannot read JSON seed ${projection}: ${err.message}`);
  }
  if (!isPlainObject(overlay)) {
    throw new Error(`JSON seed ${projection} must contain an object`);
  }

  return { overlay, projection };
}

function readObject(path, format, decode) {
  let value;
  try {
    value = decode(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read ${format} seed ${path}: ${err.message}`);
  }
  if (!isPlainObject(value)) {
    throw new Error(`${format} seed ${path} must contain an object`);
  }
  return value;
}

function parseOverlay(raw) {
  let overlay;
  try {
    overlay = JSON.parse(raw);
  } catch (err) {
    throw new Error(`WORLDFIXTURE_SEED_OVERLAY is not valid JSON: ${err.message}`);
  }
  if (!isPlainObject(overlay)) {
    throw new Error("WORLDFIXTURE_SEED_OVERLAY must be an object");
  }
  return overlay;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;

  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}
