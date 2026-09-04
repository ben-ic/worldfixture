import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONNECTOR_DOCS } from "./connector.mjs";
import { packsReference } from "./packs-doc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = join(ROOT, "dist/business.saas-company.v3");
const DOCUMENT = join(ROOT, "docs/connectors/packs.md");

// The bug this closes: `connector-request.v1.schema.json` specifies the seed
// payload as `"packs": {"type": "object"}` and no document named a pack, a
// collection or a field. Five people implemented a connector against this
// contract; every one named the same largest cost, and three of them wrote the
// same throwaway HTTP server to capture a request and read the payload off disk.
//
// A hand-written field list would be wrong the first time a world changed, and
// wrong quietly. This asserts the committed document is what the artifact
// produces, so it fails on the change rather than after somebody trusts it.
test("the packs reference is what the built artifact produces", { skip: !existsSync(ARTIFACT) }, () => {
  assert.equal(
    readFileSync(DOCUMENT, "utf8"),
    packsReference(ARTIFACT),
    "docs/connectors/packs.md is stale; regenerate it from the built world",
  );
});

test("the packs reference is installed with the other connector documents", () => {
  assert.equal(CONNECTOR_DOCS.some((path) => path.endsWith("packs.md")), true);
  for (const path of CONNECTOR_DOCS) assert.equal(existsSync(path), true, path);
});

test("the reference describes fields and their reliability, not just names", { skip: !existsSync(ARTIFACT) }, () => {
  const text = packsReference(ARTIFACT);

  // The identifiers a connector maps on.
  assert.match(text, /### `identity\.people`/);
  assert.match(text, /\| `github_login` \| string \| yes \|/);
  // `primary` is on one person, and a mapping that assumed otherwise would be
  // wrong for 160 of 161 records.
  assert.match(text, /\| `primary` \| boolean \| no \|/);
  // A nested list is named as nested rather than looking like its own collection.
  assert.match(text, /`channels\[\]\.messages`/);
  assert.match(text, /Nested inside each `channels` record/);
  // The duplicate pair that doubled two connectors' request bodies.
  assert.match(text, /`communication\.mail` and `communication\.resolved_mail` hold the same records/);
  // A real record, not a shape sketch.
  assert.match(text, /"id": "maya-chen"/);
});
