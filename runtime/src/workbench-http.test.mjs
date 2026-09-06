import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerOverview } from "./workbench.mjs";

async function readWebsite(t, configured) {
  const root = mkdtempSync(join(tmpdir(), "wf-http-preview-"));
  mkdirSync(join(root, "projections"));
  if (configured) writeFileSync(join(root, "projections/http-targets.json"), JSON.stringify({ api_version: "worldfixture.http-targets/v1", ...configured }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async url => { calls.push(url); return new Response("<style>body{color:red}</style><h1>Declared target content</h1><script>window.hidden = true;</script>"); };
  t.after(() => { globalThis.fetch = original; });
  const result = await providerOverview({ SITE_BASE_URL: "http://internal.test/" }, root, {}, { SITE_BASE_URL: "http://browser.test:1234" });
  return { website: result.website, calls };
}

test("HTTP preview reads an actual non-root page and exposes its browser URL", async t => {
  const { website, calls } = await readWebsite(t, { feeds: [{ path: "/feed.xml" }], pages: [{ path: "/p3/kind", kind: "Bulletin expérimental" }], metrics: [] });
  assert.deepEqual(calls, ["http://internal.test/p3/kind"]);
  assert.equal(website.status, "ready");
  assert.equal(website.preview, "Declared target content");
  assert.equal(website.previewPath, "/p3/kind");
  assert.equal(website.previewUrl, "http://browser.test:1234/p3/kind");
  assert.equal(website.targets.find(row => row.path === "/p3/kind").kind, "Bulletin expérimental");
  assert.ok(!website.targets.some(row => row.path === "/"));
});

test("HTTP listing retains the root when the world authors it", async t => {
  const { website, calls } = await readWebsite(t, { pages: [{ path: "/", title: "Authored home" }, { path: "/other" }], metrics: [] });
  assert.deepEqual(calls, ["http://internal.test/"]);
  assert.equal(website.previewPath, "/");
  assert.equal(website.targets.find(row => row.path === "/").name, "Authored home");
});

test("missing HTTP projection does not invent a root preview request", async t => {
  const { website, calls } = await readWebsite(t, null);
  assert.deepEqual(calls, []);
  assert.equal(website.status, "error");
  assert.equal(website.available, false);
  assert.equal(website.previewUrl, null);
  assert.equal(website.previewPath, null);
  assert.deepEqual(website.targets, []);
});
