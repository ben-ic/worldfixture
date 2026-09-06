import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONNECTOR_DOCS, connectorDocumentation, connectorPrompt, connectorWorld, planConnector, seedConnector } from "./connector.mjs";
import { packsReference } from "./packs-doc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const worlds = readdirSync(join(ROOT, "dist")).map(name => join(ROOT, "dist", name))
  .filter(path => existsSync(join(path, "manifest.json")));
const runCli = (args, cwd = ROOT) => execFileSync(process.execPath, [join(ROOT, "runtime/bin/worldfixture.mjs"), "connector", ...args],
  { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });

for (const artifactPath of worlds) {
  test(`docs and prompt describe the actual plan and seed payload: ${artifactPath}`, async t => {
    for (const scale of ["full", "smoke"]) {
      const options = { artifactPath, scale };
      const source = connectorWorld(artifactPath, options);
      const received = [];
      const original = globalThis.fetch;
      t.after(() => { globalThis.fetch = original; });
      globalThis.fetch = async (url, init) => {
        if (new URL(url).pathname === "/.well-known/worldfixture") return Response.json({
          api_version: "worldfixture.connector/v1", application: { id: "test-app", name: "Test App" },
          capabilities: { plan: true, seed: true }, accepts: Object.keys(source.packs),
        });
        received.push(JSON.parse(init.body));
        return Response.json({});
      };
      await planConnector("http://connector.test", options);
      await seedConnector("http://connector.test", options);
      globalThis.fetch = original;
      assert.equal(received.length, 2);
      const reference = packsReference(source);
      if (scale === "full") assert.equal(packsReference(artifactPath), reference,
        "the established artifact-path input describes the same complete connector payload");
      const document = connectorDocumentation(options);
      assert.ok(document.includes(reference.trim()));
      assert.ok(connectorPrompt("http://connector.test", options).includes(reference));
      for (const payload of received) {
        assert.deepEqual(payload.world, source.world);
        assert.deepEqual(payload.packs, source.packs);
        assert.equal(packsReference({ world: payload.world, packs: payload.packs, scale: source.scale }), reference);
      }
      for (const [pack, fields] of Object.entries(source.packs)) {
        for (const [name, value] of Object.entries(fields)) {
          assert.ok(reference.includes(`\`${pack}.${name}\``), `${pack}.${name} is documented`);
          if (Array.isArray(value) && value.every(row => row && typeof row === "object" && !Array.isArray(row))) {
            assert.ok(reference.includes(`| \`${pack}\` | \`${name}\` | ${value.length.toLocaleString("en-US")} |`));
          }
        }
      }
      assert.ok(runCli(["docs", "--world-path", artifactPath, "--scale", scale]).includes(reference.trim()));
    }
  });
}

test("empty collections, optional fields and non-record values remain visible", () => {
  const source = { world: { id: "alien", version: "v1", artifact_sha256: "a".repeat(64) }, packs: {
    commerce: { products: [], orders: [{ id: "one", currency: "JPY", optional: null }, { id: "two", currency: "EUR" }] },
    social: { posts: [], reviews: [] }, software: { operator_teams: ["custom"], operator_limit: null },
  } };
  const text = packsReference(source);
  assert.match(text, /### `commerce\.products`\n\nDeclared empty array/);
  assert.match(text, /### `social\.posts`/);
  assert.match(text, /### `social\.reviews`/);
  assert.match(text, /\| `optional` \| null \| no \|/);
  assert.match(text, /### `software\.operator_limit`\n\nType: null/);
  assert.doesNotMatch(text, /hold the same records/);
  assert.doesNotMatch(text, /maya-chen|github_login|business\.saas-company/);
});

test("duplicate content requires matching fields as well as IDs", () => {
  const world = { id: "alien", version: "v1", artifact_sha256: "b".repeat(64) };
  const a = [{ id: "same", value: "A" }], b = [{ id: "same", value: "B" }];
  assert.doesNotMatch(packsReference({ world, packs: { one: { a, b } } }), /hold the same records/);
  assert.match(packsReference({ world, packs: { one: { a, b: [{ value: "A", id: "same" }] } } }), /hold the same records/);
});

test("CLI docs use the running artifact and explicit selection overrides it", t => {
  const scratch = mkdtempSync(join(tmpdir(), "wf-docs-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const state = join(scratch, "state");
  mkdirSync(state);
  const retail = join(ROOT, "dist/consumer.retail-brand.v1");
  cpSync(retail, join(state, "world"), { recursive: true });
  const expected = packsReference(connectorWorld(retail));
  assert.ok(runCli(["docs", "--state", state], scratch).includes(expected.trim()));
  assert.ok(runCli(["prompt", "http://localhost:3000", "--state", state], scratch).includes(expected.trim()));
  const selected = join(ROOT, "dist/business.saas-company.v2");
  const reference = packsReference(connectorWorld(selected));
  assert.ok(runCli(["docs", "--state", state, "--world", "business.saas-company:v2"], scratch).includes(reference.trim()));
  const project = join(scratch, ".worldfixture");
  mkdirSync(project);
  writeFileSync(join(project, "project.json"), JSON.stringify({ api_version: "worldfixture.project/v1", application_url: "http://localhost:3000", services: [], world: "consumer.retail-brand:v1" }));
  assert.ok(runCli(["docs"], scratch).includes(expected.trim()));
});

test("installed static documentation keeps the protocol and explains world selection", () => {
  for (const path of CONNECTOR_DOCS) assert.equal(existsSync(path), true, path);
  const staticDocs = connectorDocumentation();
  assert.ok(staticDocs.includes(readFileSync(join(ROOT, "docs/connectors/protocol-v1.md"), "utf8").trim()));
  assert.match(staticDocs, /--world consumer\.retail-brand:v1/);
});
