import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { discoverLocalVendors } from "./registry.mjs";

// A `src/vendors/` directory somewhere temporary, so a test can create the stray
// directories the real tree must never contain.
function vendorRoot(dirs) {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-vendors-"));

  for (const [name, index] of Object.entries(dirs)) {
    mkdirSync(join(root, name), { recursive: true });
    if (index !== null) writeFileSync(join(root, name, "index.mjs"), index);
  }

  return pathToFileURL(`${root}/`);
}

const WORKING_VENDOR = `export const plugin = { name: "acme", register() {} };\n`;

// Closes: one stray subdirectory under `src/vendors/` took down all thirteen
// provider APIs at boot. `discoverLocalVendors` imported `<dir>/index.mjs` for
// every subdirectory with no guard, so `mkdir src/vendors/stray` ended the
// process with a bare ERR_MODULE_NOT_FOUND before a single listener bound.
test("a directory with no index.mjs is skipped, not fatal", async () => {
  const dir = vendorRoot({ acme: WORKING_VENDOR, "acme.orig": null });

  const found = await discoverLocalVendors(dir);

  assert.deepEqual(Object.keys(found), ["acme"]);
  rmSync(new URL(dir), { recursive: true, force: true });
});

// The skip must be announced. A half-finished vendor that is silently ignored is
// how one gets forgotten with its port already assigned.
test("skipping a directory names it", async () => {
  const dir = vendorRoot({ "acme.orig": null });
  const said = [];
  const warn = console.warn;
  console.warn = (line) => said.push(line);

  try {
    await discoverLocalVendors(dir);
  } finally {
    console.warn = warn;
  }

  assert.equal(said.length, 1);
  assert.match(said[0], /acme\.orig/);
  rmSync(new URL(dir), { recursive: true, force: true });
});

// A directory that HAS an index.mjs is a vendor, and a broken one stays fatal:
// skipping it would leave a vendor with a port assigned and nothing behind it.
// What the error must not do any more is fail to say which directory it was.
test("a vendor whose index.mjs throws is fatal and names the directory", async () => {
  const dir = vendorRoot({ acme: WORKING_VENDOR, broken: `throw new Error("half-finished");\n` });

  await assert.rejects(discoverLocalVendors(dir), (err) => {
    assert.match(err.message, /src\/vendors\/broken\/index\.mjs failed to load/);
    assert.match(err.message, /half-finished/);
    assert.equal(err.cause?.message, "half-finished");
    return true;
  });
  rmSync(new URL(dir), { recursive: true, force: true });
});

test("a vendor exporting no plugin is fatal and names the directory", async () => {
  const dir = vendorRoot({ empty: `export const nothing = 1;\n` });

  await assert.rejects(discoverLocalVendors(dir), /src\/vendors\/empty exports no plugin/);
  rmSync(new URL(dir), { recursive: true, force: true });
});

test("a vendor directory that does not exist discovers nothing", async () => {
  assert.deepEqual(await discoverLocalVendors(pathToFileURL(`${tmpdir()}/worldfixture-absent-vendors/`)), {});
});
