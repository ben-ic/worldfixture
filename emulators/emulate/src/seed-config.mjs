import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// The only world-artifact shape this composer knows how to read, and the one file it
// reads out of an artifact. Both are stated here rather than assembled at the call
// site so the manifest lookup key and the path on disk cannot drift apart.
const WORLD_API_VERSION = "worldfixture.world-artifact/v1";
const OVERLAY_FILE = "projections/emulator-overlay.json";

export function loadSeedConfig({
  seedPath = "seed.yaml",
  worldPath,
  sessionOverlay,
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
    for (const token of Object.keys(seed.tokens ?? {})) {
      if ((token === "notion_token" || token.startsWith("notion_token_")) && !(token in (overlay.tokens ?? {}))) {
        delete seed.tokens[token];
      }
    }
    // A compiled world owns provider identities and resources. Do not retain
    // the sample OAuth applications from seed.yaml when the world did not
    // declare them. Their fixed localhost callback URLs make a target app with
    // a fallback port fail before consent. With no declared application, the
    // local provider accepts the client configuration supplied by the target
    // app while it still validates state, code, redirect URI and token use.
    for (const provider of ["slack", "github", "google"]) {
      if (!overlay[provider]) continue;
      if (!("oauth_apps" in overlay[provider])) delete seed[provider]?.oauth_apps;
      if (!("oauth_clients" in overlay[provider])) delete seed[provider]?.oauth_clients;
    }
    log(`world projection applied from ${projection}`);
  }

  if (sessionOverlay) {
    seed = deepMerge(seed, parseOverlay(sessionOverlay));
    log("session seed overlay applied");
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
