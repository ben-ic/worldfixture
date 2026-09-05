// A reference for the payload a connector actually receives.
//
// WHY THIS IS GENERATED. `connector-request.v1.schema.json` specifies the seed
// payload as `"packs": {"type": "object"}`, and that is the whole of it. Five
// people implemented a connector against this contract and every one of them
// named the same largest cost: to learn what a pack contains they stood up a
// throwaway HTTP server, pointed `connector seed` at it, and read the 3.8 MB
// body off disk. Three wrote the same server. One measured it at eight of their
// forty-five minutes -- more than writing the mapping.
//
// WHY IT IS NOT PROSE. A hand-written field list is wrong the first time a world
// changes, and wrong quietly. This reads the built artifact, so the document is
// a function of the thing it documents, and a test regenerates it and fails when
// the two disagree.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXAMPLE_LIMIT = 240;
const MAX_ITEMS = 3;

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array";
    return `array of ${describeValue(value[0])}`;
  }
  if (typeof value === "object") return "object";
  return typeof value;
}

// Long prose is trimmed so a record stays readable as an example. The trim is
// marked, so nobody reads a truncated body as the real field width.
function trimValue(value) {
  if (typeof value === "string" && value.length > EXAMPLE_LIMIT) {
    return `${value.slice(0, EXAMPLE_LIMIT)}… (trimmed for this document)`;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(trimValue);
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trimValue(entry)]));
  }
  return value;
}

function collectionsOf(packs) {
  const found = [];
  for (const [packName, pack] of Object.entries(packs)) {
    for (const [name, value] of Object.entries(pack)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      if (!value.every((entry) => entry && typeof entry === "object")) continue;
      found.push({ pack: packName, name, records: value, nested: false });
      const nested = new Map();
      for (const record of value) {
        for (const [field, inner] of Object.entries(record)) {
          if (!Array.isArray(inner) || inner.length === 0) continue;
          if (!inner.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) continue;
          if (!nested.has(field)) nested.set(field, []);
          nested.get(field).push(...inner);
        }
      }
      for (const [field, records] of nested) {
        found.push({ pack: packName, name: `${name}[].${field}`, records, nested: true, parent: name });
      }
    }
  }
  return found;
}

// Every field any record in the collection carries, with the types seen and
// whether every record had it. A field present on some records and not others is
// the thing a mapping gets wrong, so it is stated rather than implied.
function fieldsOf(records) {
  const fields = new Map();
  for (const record of records) {
    for (const [name, value] of Object.entries(record)) {
      if (!fields.has(name)) fields.set(name, { types: new Set(), present: 0 });
      const field = fields.get(name);
      field.types.add(describeValue(value));
      field.present += 1;
    }
  }
  return [...fields.entries()]
    .map(([name, field]) => ({
      name,
      types: [...field.types].sort().join(" or "),
      always: field.present === records.length,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// Two collections holding the same records under different names.
//
// The default world carries `mail` and `resolved_mail`, byte for byte the same
// 3,069 records, and together they are most of a 3.8 MB request. Two connector
// authors found that out by measuring their own traffic.
function duplicateNote(collections) {
  const byContent = new Map();
  for (const entry of collections) {
    if (entry.nested) continue;
    const key = JSON.stringify(entry.records.map((record) => record.id ?? null));
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(`${entry.pack}.${entry.name}`);
  }
  const shared = [...byContent.values()].filter((names) => names.length > 1);
  if (shared.length === 0) return [];
  return shared.map(
    (names) =>
      `- \`${names.join("` and `")}\` hold the same records. Read one of them; ` +
      "seeding both creates every record twice.",
  );
}

export function packsReference(artifactPath) {
  const manifest = JSON.parse(readFileSync(join(artifactPath, "manifest.json"), "utf8"));
  const packs = {};
  for (const name of manifest.packs ?? []) {
    packs[name] = JSON.parse(readFileSync(join(artifactPath, "packs", `${name}.json`), "utf8"));
  }
  const collections = collectionsOf(packs);
  const total = collections.filter((entry) => !entry.nested).reduce((sum, entry) => sum + entry.records.length, 0);

  const lines = [
    "# What a connector receives",
    "",
    "This is the `packs` object in a seed or plan request, described from the world",
    `it documents: \`${manifest.world_id}:${manifest.world_version}\`, artifact`,
    `\`${manifest.artifact_sha256.slice(0, 12)}…\`.`,
    "",
    "It is generated from the prepared artifact and checked by a test, so it cannot",
    "drift from what is actually sent. Run `npx worldfixture connector docs` to read the",
    "version installed alongside your build.",
    "",
    "## The shape",
    "",
    "```json",
    "{",
    '  "api_version": "worldfixture.connector-request/v1",',
    '  "request_id": "req_…",',
    '  "idempotency_key": "seed:…",        // seed only',
    '  "world": {"id": "…", "version": "…", "artifact_sha256": "…", "title": "…", "clock": {…}},',
    '  "options": {"mode": "apply" | "preview", "scale": {…}},',
    '  "packs": {' + Object.keys(packs).map((name) => `"${name}": {…}`).join(", ") + "}",
    "}",
    "```",
    "",
    "## Rules that hold across every pack",
    "",
    "- A record's `id` is a stable slug, not a number, and it is the identifier a",
    "  `worldfixture_ref` addresses: `person/maya-chen`, `channel/channel-soc2`.",
    "- A field ending `_id` names one record. A field ending `_ids` names several.",
    "  A list of ids is a membership list and may be trimmed by a scale slice; a",
    "  single id is a dependency and never dangles.",
    "- People are also addressable by `email`, `github_login` and `slack_id`, and",
    "  some collections use those rather than the person's `id`.",
    "- Collections arrive in a deterministic order, and messages within a channel",
    "  are ordered by `timestamp`.",
    "- A slice is referentially whole. It never contains a record that refers to a",
    "  record it does not contain, so a connector needs no special handling for one.",
    ...duplicateNote(collections),
    "",
    "## Collections",
    "",
    `${collections.filter((entry) => !entry.nested).length} top-level collections and ` +
      `${collections.filter((entry) => entry.nested).length} nested ones, ` +
      `${total.toLocaleString("en-US")} top-level records in the full world.`,
    "",
    "| Pack | Collection | Records |",
    "| --- | --- | --- |",
    ...collections.map((entry) => `| \`${entry.pack}\` | \`${entry.name}\` | ${entry.records.length.toLocaleString("en-US")} |`),
    "",
  ];

  for (const entry of collections) {
    lines.push(`### \`${entry.pack}.${entry.name}\``, "");
    if (entry.nested) {
      lines.push(`Nested inside each \`${entry.parent}\` record, not a collection of its own.`, "");
    }
    lines.push("| Field | Type | On every record |", "| --- | --- | --- |");
    for (const field of fieldsOf(entry.records)) {
      lines.push(`| \`${field.name}\` | ${field.types} | ${field.always ? "yes" : "no"} |`);
    }
    lines.push("", "```json", JSON.stringify(trimValue(entry.records[0]), null, 2), "```", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
