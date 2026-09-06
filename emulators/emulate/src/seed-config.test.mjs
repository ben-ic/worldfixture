import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSeedConfig } from "./seed-config.mjs";

// A world artifact on disk: the overlay, plus the manifest entry that vouches for it.
// `manifest` lets a test declare a manifest that DISAGREES with the bytes it wrote,
// which is the whole thing being tested.
function writeWorld(root, overlay, { manifest: manifestOverrides = {} } = {}) {
  const world = join(root, "world");
  mkdirSync(join(world, "projections"), { recursive: true });

  const body = JSON.stringify(overlay);
  writeFileSync(join(world, "projections", "emulator-overlay.json"), body);

  const manifest = {
    api_version: "worldfixture.world-artifact/v1",
    files: {
      "projections/emulator-overlay.json": {
        sha256: createHash("sha256").update(body).digest("hex"),
        size: Buffer.byteLength(body),
      },
    },
    ...manifestOverrides,
  };
  writeFileSync(join(world, "manifest.json"), JSON.stringify(manifest));

  return world;
}

function seedRoot() {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-world-"));
  writeFileSync(join(root, "seed.yaml"), "google:\n  messages:\n    - id: baked\n");
  return root;
}

test("the exported standalone YAML loader preserves explicit config without a world identity", () => {
  const root = seedRoot();
  try {
    const seed = loadSeedConfig({
      seedPath: join(root, "seed.yaml"),
      sessionOverlay: JSON.stringify({ google: { users: [{ email: "declared@example.test" }] } }),
    });
    assert.deepEqual(seed.google, {
      messages: [{ id: "baked" }], users: [{ email: "declared@example.test" }],
    });
    assert.equal(seed.worldfixture_world, undefined);
    assert.deepEqual(seed.worldfixture_providers, []);
    assert.equal(seed.tokens, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verified world replaces content and the session overlay adds its OAuth client", () => {
  const root = seedRoot();
  const world = writeWorld(root, {
    google: { messages: [{ id: "world" }] },
    tokens: { demo: { login: "maya" } },
  });

  const seed = loadSeedConfig({
    seedPath: join(root, "seed.yaml"),
    worldPath: world,
    sessionOverlay: JSON.stringify({ google: { oauth_clients: [{ client_id: "session" }] } }),
  });

  assert.deepEqual(seed.google.messages, [{ id: "world" }]);
  assert.deepEqual(seed.google.oauth_clients, [{ client_id: "session" }]);
  assert.equal(seed.tokens.demo.login, "maya");
});

test("a world does not inherit fixed callback URLs from sample OAuth applications", () => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-world-"));
  writeFileSync(join(root, "seed.yaml"), [
    "slack:", "  oauth_apps:", "    - client_id: sample-slack",
    "github:", "  oauth_apps:", "    - client_id: sample-github",
    "google:", "  oauth_clients:", "    - client_id: sample-google", "",
  ].join("\n"));
  const world = writeWorld(root, { slack: { users: [] }, github: { users: [] }, google: { users: [] } });

  const seed = loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: world });

  assert.equal(seed.slack.oauth_apps, undefined);
  assert.equal(seed.github.oauth_apps, undefined);
  assert.equal(seed.google.oauth_clients, undefined);
});

test("each world owns its complete Notion fixture", () => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-world-"));
  writeFileSync(join(root, "seed.yaml"), [
    "tokens:", "  notion_token:", "    login: sample@example.test",
    "  notion_token_sample-person:", "    login: sample-person@example.test",
    "notion:", "  workspace:", "    name: Sample", "    sample_only: true",
    "  pages:", "    - id: sample-page", "      title: Sample page", "",
  ].join("\n"));
  const projected = writeWorld(root, {
    tokens: { notion_token: { login: "person@second-world.test", scopes: ["read:content"] } },
    notion: { workspace: { id: "second", name: "Second world" }, users: [], pages: [] },
  });
  const seed = loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: projected });
  assert.deepEqual(seed.notion, { workspace: { id: "second", name: "Second world" }, users: [], pages: [] });
  assert.equal(seed.tokens.notion_token.login, "person@second-world.test");
  assert.equal(seed.tokens["notion_token_sample-person"], undefined);

  const noNotionRoot = mkdtempSync(join(tmpdir(), "worldfixture-world-"));
  writeFileSync(join(noNotionRoot, "seed.yaml"), readFileSync(join(root, "seed.yaml")));
  const withoutProjection = writeWorld(noNotionRoot, { tokens: { another_token: { login: "other" } } });
  const empty = loadSeedConfig({ seedPath: join(noNotionRoot, "seed.yaml"), worldPath: withoutProjection });
  assert.equal(empty.notion, undefined);
  assert.equal(empty.tokens.notion_token, undefined);
  assert.equal(empty.tokens["notion_token_sample-person"], undefined);
});

test("a declared world path fails when its projection is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-world-"));
  writeFileSync(join(root, "seed.yaml"), "google: {}\n");

  assert.throws(
    () => loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: join(root, "missing") }),
    /cannot read JSON seed/,
  );
});

test("a world whose overlay bytes disagree with its manifest digest is refused", () => {
  const root = seedRoot();
  const world = writeWorld(root, { tokens: { demo: { login: "maya" } } });

  // Same length, different bytes: only the digest catches this one.
  const tampered = JSON.stringify({ tokens: { demo: { login: "evil" } } });
  writeFileSync(join(world, "projections", "emulator-overlay.json"), tampered);

  assert.throws(
    () => loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: world }),
    (err) => {
      assert.match(err.message, /projections\/emulator-overlay\.json does not match/);
      assert.match(err.message, /manifest\.json/);
      // Both digests are named, so the message says WHICH side is wrong.
      assert.match(err.message, /the manifest declares sha256 [0-9a-f]{64}/);
      assert.match(err.message, new RegExp(`is sha256 ${createHash("sha256").update(tampered).digest("hex")}`));
      return true;
    },
  );
});

test("a world whose overlay size disagrees with its manifest is refused", () => {
  const root = seedRoot();
  const world = writeWorld(root, { tokens: { demo: { login: "maya" } } });

  // Keep the real digest, lie only about the size.
  const manifestPath = join(world, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.files["projections/emulator-overlay.json"].size += 1;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  assert.throws(
    () => loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: world }),
    /does not match .*manifest\.json/s,
  );
});

test("a world artifact of an unknown api_version is refused by name", () => {
  const root = seedRoot();
  const world = writeWorld(
    root,
    { tokens: { demo: { login: "maya" } } },
    { manifest: { api_version: "worldfixture.world-artifact/v2" } },
  );

  assert.throws(
    () => loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: world }),
    (err) => {
      assert.match(err.message, /declares api_version "worldfixture\.world-artifact\/v2"/);
      assert.match(err.message, /reads only "worldfixture\.world-artifact\/v1"/);
      return true;
    },
  );
});

test("a manifest that never lists the overlay is refused rather than trusted", () => {
  const root = seedRoot();
  const world = writeWorld(root, { tokens: { demo: { login: "maya" } } }, { manifest: { files: {} } });

  assert.throws(
    () => loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: world }),
    /lists no sha256 and size for projections\/emulator-overlay\.json/,
  );
});

test("a world with a manifest but no overlay file on disk names the missing file", () => {
  const root = seedRoot();
  const world = writeWorld(root, { tokens: { demo: { login: "maya" } } });
  rmSync(join(world, "projections", "emulator-overlay.json"));

  assert.throws(
    () => loadSeedConfig({ seedPath: join(root, "seed.yaml"), worldPath: world }),
    /cannot read JSON seed .*projections\/emulator-overlay\.json/,
  );
});
