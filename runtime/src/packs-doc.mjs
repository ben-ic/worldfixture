// A reference for the payload a connector actually receives.
//
// Read the same world and scale slice as connector plan/seed. No catalogue
// entry or example payload is a substitute for the selected artifact.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./resolve.mjs";

const EXAMPLE_LIMIT = 240;
const MAX_ITEMS = 3;

function describeValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array";
    return `array of ${[...new Set(value.map(describeValue))].sort().join(" or ")}`;
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
      if (!Array.isArray(value)) continue;
      if (!value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))) continue;
      found.push({ pack: packName, name, records: value, nested: false });
      const nested = new Map();
      for (const record of value) {
        for (const [field, inner] of Object.entries(record)) {
          if (!Array.isArray(inner)) continue;
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

// Claim duplicate content only when every field matches, not just the IDs.
function duplicateNote(collections) {
  const byContent = new Map();
  for (const entry of collections) {
    if (entry.nested || entry.records.length === 0) continue;
    const key = canonical(entry.records);
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

export function packsReference(source) {
  // Keep the artifact-path form for callers that need a full reference.
  if (typeof source === "string") {
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    const packs = Object.fromEntries((manifest.packs ?? []).map(name =>
      [name, JSON.parse(readFileSync(join(source, "packs", `${name}.json`), "utf8"))]));
    source = { world: { id: manifest.world_id, version: manifest.world_version,
      artifact_sha256: manifest.artifact_sha256 }, packs };
  }
  const { world, packs, scale } = source;
  const collections = collectionsOf(packs);
  const total = collections.filter((entry) => !entry.nested).reduce((sum, entry) => sum + entry.records.length, 0);

  const lines = [
    "# What a connector receives",
    "",
    "This is the `packs` object in a seed or plan request, described from the world",
    `it documents: \`${world.id}:${world.version}\`, artifact`,
    `\`${world.artifact_sha256}\`.`,
    "",
    "This reference uses the selected artifact and the same scale rules as connector plan and seed.",
    `Scale: \`${scale?.preset ?? "full"}\`; limits: \`${JSON.stringify(scale?.limits ?? {})}\`.`,
    "Empty arrays are shown. Their element fields cannot be inferred from this payload.",
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
    "## Reading this payload",
    "",
    "- Use each record's complete `id` when mapping it to an application record.",
    "- Fields ending `_id` or `_ids` describe record references or membership.",
    "- Provider identities and optional fields exist only where this payload includes them.",
    "- The field tables show observed types and whether each field is present on every record.",
    ...duplicateNote(collections),
    "",
    "## Collections",
    "",
    `${collections.filter((entry) => !entry.nested).length} top-level collections and ` +
      `${collections.filter((entry) => entry.nested).length} nested ones, ` +
      `${total.toLocaleString("en-US")} top-level records in this payload.`,
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
    if (entry.records.length === 0) {
      lines.push("Declared empty array. No record fields are available.", "", "```json", "[]", "```", "");
      continue;
    }
    lines.push("| Field | Type | On every record |", "| --- | --- | --- |");
    for (const field of fieldsOf(entry.records)) {
      lines.push(`| \`${field.name}\` | ${field.types} | ${field.always ? "yes" : "no"} |`);
    }
    lines.push("", "```json", JSON.stringify(trimValue(entry.records[0]), null, 2), "```", "");
  }

  const values = Object.entries(packs).flatMap(([pack, fields]) => Object.entries(fields)
    .filter(([name]) => !collections.some(entry => entry.pack === pack && entry.name === name))
    .map(([name, value]) => ({ name: `${pack}.${name}`, value })));
  if (values.length) {
    lines.push("## Other pack values", "");
    for (const { name, value } of values) {
      lines.push(`### \`${name}\``, "", `Type: ${describeValue(value)}.`, "", "```json",
        JSON.stringify(trimValue(value), null, 2), "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
