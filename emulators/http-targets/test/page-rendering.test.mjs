import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

async function startPageFixture(t, change = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "wf-http-pages-"));
  mkdirSync(join(root, "projections"));
  const projection = JSON.parse(readFileSync(new URL("./self-test.json", import.meta.url)));
  projection.pages = [
    {path: "/", title: "Body home", heading: "Home", body: "Home <script>alert(1)</script> & text"},
    {path: "/p3/kind", kind: "Bulletin expérimental", title: "Body page", heading: "Page", body: "Declared body <b>plain</b> & text"},
    {path: "/sections", title: "Sections", heading: "Sections", sections: [{heading: "Existing section", body: "Existing section content <b>plain</b>"}]},
    {path: "/both", title: "Both", body: "Top-level body", sections: [{heading: "Section", body: "Section content"}]},
    {path: "/empty", title: "No optional content"},
  ];
  change(projection);
  writeFileSync(join(root, "projections/http-targets.json"), JSON.stringify(projection));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
    env: {...process.env, WORLDFIXTURE_WORLD_PATH: root, WORLDFIXTURE_HTTP_TARGETS_LISTEN: `127.0.0.1:${port}`},
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", value => {stderr += value;});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }
    rmSync(root, {recursive: true, force: true});
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, stderr);
    try { if ((await fetch(`${origin}/readyz`)).ok) return {origin, child, stderr: () => stderr}; }
    catch { /* Wait for the isolated child listener. */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`HTTP fixture did not start: ${stderr}`);
}

test("body-only root and custom pages escape content and leave the server healthy", async t => {
  const {origin, child, stderr} = await startPageFixture(t);
  for (const [path, expected] of [["/", "Home &lt;script&gt;alert(1)&lt;/script&gt; &amp; text"], ["/p3/kind", "Declared body &lt;b&gt;plain&lt;/b&gt; &amp; text"]]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(expected));
    assert.ok(!html.includes("<script>"));
    assert.equal((await fetch(`${origin}/readyz`)).status, 200);
    assert.equal(child.exitCode, null, stderr());
  }
});

test("optional sections remain visible, can accompany body, and can be absent", async t => {
  const {origin, child, stderr} = await startPageFixture(t);
  const sections = await (await fetch(`${origin}/sections`)).text();
  assert.ok(sections.includes("<section><h2>Existing section</h2><p>Existing section content &lt;b&gt;plain&lt;/b&gt;</p></section>"));
  const both = await (await fetch(`${origin}/both`)).text();
  assert.ok(both.includes("<section><p>Top-level body</p></section>"));
  assert.ok(both.includes("<section><h2>Section</h2><p>Section content</p></section>"));
  assert.equal((await fetch(`${origin}/empty`)).status, 200);
  assert.equal((await fetch(`${origin}/readyz`)).status, 200);
  assert.equal(child.exitCode, null, stderr());
});

test("HTTP pages and authored probe bodies work without an API or organization section", async t => {
  const {origin} = await startPageFixture(t, projection => {
    delete projection.api;
    delete projection.organization;
    projection.feeds = [];
    projection.probes = [{path: '/check', name: 'Declared check', statuses: [200, 503], body: 'Authored body: café <plain>\nsecond line'}];
  });
  const page = await fetch(`${origin}/p3/kind`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Declared body'));
  for (const status of [200, 503, 200, 503]) {
    const response = await fetch(`${origin}/check`);
    assert.equal(response.status, status);
    assert.equal(await response.text(), `Declared check\nStatus: ${status === 200 ? 'operational' : 'unavailable'}\nAuthored body: café <plain>\nsecond line\n`);
  }
  assert.equal((await fetch(`${origin}/openapi.json`)).status, 404);
  assert.equal((await fetch(`${origin}/readyz`)).status, 200);
});
