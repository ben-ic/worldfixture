// Baseline evidence helpers. A pack is input, never proof of a live API.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const result = (check, passed, detail = {}) => ({ check, status: passed ? "passed" : "failed", ...detail });

export function discoverArtifacts(distRoot) {
  const paths = [];
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true });
    // Include malformed manifests: loadArtifact must report their failure.
    if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) paths.push(resolve(directory));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  }
  visit(resolve(distRoot));
  return paths.sort();
}

export function loadArtifact(path) {
  path = resolve(path);
  const manifest = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8"));
  if (manifest.api_version !== "worldfixture.world-artifact/v1" || !manifest.files ||
      !manifest.world_id || !manifest.world_version) throw new Error(`Invalid world artifact manifest: ${path}`);
  const checks = [], documents = {};
  // Use the runtime verifier's byte length and SHA-256 contract without importing
  // supervisor.mjs, which also imports the optional native SQLite dependency.
  for (const [file, expected] of Object.entries(manifest.files)) {
    const target = resolve(path, file);
    if (relative(path, target).startsWith(`..${sep}`) || target === path || relative(path, target) === "..") {
      checks.push(result(`artifact.file:${file}`, false, { detail: "Manifest path leaves artifact directory." }));
      continue;
    }
    try {
      const bytes = readFileSync(target);
      const actual = { sha256: digest(bytes), size: bytes.length };
      checks.push(result(`artifact.file:${file}`, actual.sha256 === expected.sha256 && actual.size === expected.size, { expected, actual }));
      if (file.endsWith(".json")) documents[file] = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      checks.push(result(`artifact.read:${file}`, false, { detail: error.message }));
    }
  }
  const actualDigest = digest(`${JSON.stringify(canonical(manifest.files))}\n`);
  checks.push(result("artifact.digest", actualDigest === manifest.artifact_sha256, { expected: manifest.artifact_sha256, actual: actualDigest }));
  const world = documents["world.json"];
  checks.push(result("artifact.world-identity", !!world && world.id === manifest.world_id && world.version === manifest.world_version,
    { expected: { id: manifest.world_id, version: manifest.world_version }, actual: { id: world?.id, version: world?.version } }));
  const packs = {}, projections = {};
  for (const [file, document] of Object.entries(documents)) {
    if (file.startsWith("packs/")) packs[basename(file, ".json")] = document;
    if (file.startsWith("projections/")) projections[basename(file, ".json")] = document;
  }
  checks.push(compareIdentities({ check: "artifact.declared-packs", expected: manifest.packs ?? [], actual: Object.keys(packs) }));
  return { path, identity: { id: manifest.world_id, version: manifest.world_version, digest: manifest.artifact_sha256 },
    manifest, world, packs, projections, timeline: documents["timeline.json"], checks };
}

export function snapshotArtifact(sourcePath, outputPath) {
  const source = loadArtifact(sourcePath);
  if (source.checks.some(check => check.status === "failed")) throw new Error("Source artifact failed integrity checks before snapshot");
  mkdirSync(outputPath, { recursive: false });
  for (const file of [...Object.keys(source.manifest.files), "manifest.json"]) {
    const target = resolve(outputPath, file);
    const relativePath = relative(resolve(outputPath), target);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) throw new Error("Artifact snapshot path leaves its directory");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source.path, file), target);
  }
  const snapshot = loadArtifact(outputPath);
  if (snapshot.identity.digest !== source.identity.digest || snapshot.checks.some(check => check.status === "failed")) {
    throw new Error("Artifact changed during snapshot; refusing to test mixed input files");
  }
  return snapshot;
}

export function canonicalCollectionPath(path) {
  return path.replace(/^identity\./, "").replace(/^finance\.(bills|invoices|ledger_entries|payments|refunds)(?=\.|\[|$)/, "finance.resolved.$1");
}

// These are reviewed initial contracts, not a declaration that each probe exists.
// Missing consumers and missing live evidence remain strict failures.
const mappings = new Map();
function data(paths, provider, projection, apiReader, identity = "id") {
  for (const path of paths.split(" ")) mappings.set(path, { kind: "data", compilerUse: "compiler/worldfixture_compiler/compiler.py",
    provider, projection, apiReader, identity });
}
function config(paths, consumer) {
  for (const path of paths.split(" ")) mappings.set(path, { kind: "configuration", compilerUse: "compiler/worldfixture_compiler/compiler.py", consumer });
}
data("people", "slack", "slack.users", "users.list", "slack_id");
data("organizations", "github", "github.orgs", "GET /orgs/:org", "slug");
data("communication.channels", "slack", "slack.channels", "conversations.list", "name");
data("communication.channels[].messages", "slack", "slack.channels[].messages", "conversations.history", "text+author_id+timestamp");
data("communication.mail communication.resolved_mail", "google", "google.messages", "GET /gmail/v1/users/:user/messages", "id per mailbox");
for (const path of ["communication.mail", "communication.resolved_mail"]) {
  mappings.get(path).alternateProviders = ["mail"];
}
data("communication.mailboxes", "google", "google.users", "GET /oauth2/v2/userinfo", "owner_id");
data("communication.mailboxes[].labels", "google", "google.labels", "GET /gmail/v1/users/:user/labels", "owner_id + label name");
data("communication.calendars", "google", "google.calendars", "GET /calendar/v3/users/me/calendarList");
data("communication.calendar_events", "google", "google.calendar_events", "GET /calendar/v3/calendars/:id/events");
data("communication.documents", "notion", "notion.pages", "POST /v1/search", "world id mapped by compiler");
data("communication.bots", "slack", "slack.bots", "bots.info", "name");
data("software.repositories", "github", "github.repos", "GET /orgs/:org/repos", "name");
for (const provider of ["apple", "clerk", "okta", "google", "microsoft", "github", "slack", "linear", "vercel"]) {
  const collection = `software.oauth_clients.${provider}`;
  data(collection, provider, `emulator-overlay.${provider}`, "Declared-client authorize/callback/token plus source user identity; each exact redirect and grant policy", "client_id");
  mappings.get(collection).compilerUse = "compiler/worldfixture_compiler/oauth.py";
  mappings.get(collection).unservedFields = ["id"];
  for (const field of ["redirect_uris", "scopes", "user_scopes", "grant_types", "response_types"]) {
    const path = `${collection}[].${field}`;
    mappings.set(path, { ...mappings.get(collection), unservedFields: [], evidenceCollection: path, parent: collection, identity: "client_id plus exact declared policy value" });
  }
}

data("software.operator_teams software.operator_ids", "aws", "aws.iam.users", "POST /iam/ ListUsers", "source team/ID union and nullable limit mapped to IAM user_name");
data("software.repositories[].issues", "github", "github.repos[].issues", "GET /repos/:owner/:repo/issues", "number per repository");
data("work.tasks", "linear", "linear.issues", "GraphQL issues", "identifier");
data("work.projects", "notion", "notion.pages", "GET /v1/pages/:id and block children", "source project ID mapped to page ID");
mappings.get("work.projects").unservedFieldsByProvider = { notion: ["start_on", "customer_id"] };
data("commerce.products", "stripe", "stripe.products and prices", "GET /v1/products and /v1/prices", "source product ID mapped to Stripe ID");
data("finance.customers", "stripe", "stripe.customers", "GET /v1/customers", "metadata world identity");
data("finance.resolved.invoices finance.anchor_invoices", "stripe", "stripe.invoices", "GET /v1/invoices", "metadata world identity");
data("finance.resolved.payments", "stripe", "stripe.transactions.payments", "GET /v1/payment_intents; GET /v1/charges; GET /v1/invoice_payments", "metadata.worldfixture_payment_id and explicit invoice/order links");
data("finance.resolved.refunds", "stripe", "stripe.transactions.refunds", "GET /v1/refunds", "metadata.worldfixture_refund_id and payment link");
data("site.pages", "http", "http-targets.pages", "GET each declared page", "path");
data("site.feed.items", "http", "http-targets.feeds", "GET each feed", "id");
data("site.metrics", "http", "http-targets.metrics", "GET /metrics", "name");
data("site.probes", "http", "http-targets.probes", "GET each probe", "path");
// Full domain records require measured API evidence. A projection or pack on
// disk cannot satisfy these contracts.
for (const path of ["commerce.orders", "commerce.orders[].items", "finance.resolved.bills", "finance.resolved.ledger_entries", "finance.suppliers",
  "social.comments", "social.posts", "social.posts[].product_ids", "social.posts[].tags", "social.reviews", "support.cases", "work.time_entries", "work.projects[].member_ids"]) {
  data(path, "domain", "domain.collections", "GET /v1/collections/:collection and /:id", "canonical source ID and full nested record values");
}
for (const path of ["people", "organizations", "work.projects", "work.tasks", "commerce.products", "finance.customers",
  "finance.resolved.invoices", "finance.anchor_invoices", "finance.resolved.payments", "finance.resolved.refunds"]) {
  mappings.get(path).alternateProviders = [...mappings.get(path).alternateProviders ?? [], "domain"];
}
config("categories", "runtime/src/connector.mjs: seed world metadata");
config("clock.rebase.relative_paths", "compiler/worldfixture_compiler/compiler.py: rebase_world timestamp rebasing");
config("agentic.capabilities agentic.constraints agentic.goals agentic.goals[].success_evidence agentic.grounding model_facts stories stories[].entity_refs", "agent/model projections: agent context; no provider data claim");
config("agentic.causal_rules agentic.causal_rules[].emits agentic.causal_rules[].requires agentic.causal_rules[].emit", "runtime/src/execution-preflight.mjs and rules.mjs: versioned executable rules; explicitly descriptive rules are reported separately");
config("timeline timeline[].payload.labels", "runtime/src/scheduler.mjs and arrivals.mjs: scheduled delivery; execution checked separately");
config("software.database.collections", "mongoatlas projection: declared collection names; live data checked separately");
config("site.probes[].statuses", "http-targets projection: probe response configuration");
// The alien generator records its vocabulary for fixture contract tests. This
// exact metadata array has no provider API contract. Other fixture arrays still
// need their own reviewed mappings, just like every other unknown collection.
mappings.set("fixture.markers", {
  kind: "configuration",
  producer: "tests/fixtures/alien-world.py: generate_world",
  consumer: "tests/contracts/test_coupling_fixture.py: test_different_seeds_change_owned_content and test_generated_vocabulary_does_not_reuse_shipped_owned_identities",
});
// A reviewed nested field needs the same live reader as its parent. Unknown
// arrays do not inherit this treatment and therefore cannot silently pass.
for (const [path, parent] of [
  ["communication.channels[].member_ids", "communication.channels"],
  ["communication.calendar_events[].attendees", "communication.calendar_events"],
  ["communication.mail[].labels", "communication.mail"], ["communication.mail[].to_ids", "communication.mail"],
  ["communication.resolved_mail[].labels", "communication.resolved_mail"], ["communication.resolved_mail[].to_ids", "communication.resolved_mail"],
  ["software.repositories[].member_ids", "software.repositories"], ["software.repositories[].topics", "software.repositories"],
  ["software.repositories[].issues[].labels", "software.repositories[].issues"], ["work.tasks[].labels", "work.tasks"],
  ["site.pages[].sections", "site.pages"], ["site.pages[].request_variants", "site.pages"],
]) mappings.set(path, { ...mappings.get(parent), evidenceCollection: path, identity: "parent identity plus field values", parent });

export function inventoryCollections(value) {
  const found = new Map();
  function walk(node, path, parentIdentity) {
    if (Array.isArray(node)) {
      const canonicalPath = canonicalCollectionPath(path);
      if (!found.has(path)) found.set(path, { path, canonicalPath, count: 0, identities: [], records: [], occurrences: 0,
        kind: mappings.get(canonicalPath)?.kind ?? "unmapped", mapping: mappings.get(canonicalPath) ?? null });
      const entry = found.get(path);
      entry.count += node.length;
      entry.occurrences += 1;
      node.forEach((record, index) => {
        const id = record && typeof record === "object" ? record.id ?? record.path ?? record.name ?? record.number : record;
        entry.identities.push({ parent: parentIdentity ?? null, id: id ?? null, index });
        entry.records.push(record);
        walk(record, `${path}[]`, id ?? parentIdentity);
      });
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) walk(child, path ? `${path}.${key}` : key, parentIdentity);
    }
  }
  walk(value, "", null);
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function collectionCoverage(inventory, { evidence = [], readersAttempted = true } = {}) {
  return inventory.map((row) => {
    const check = `collection.coverage:${row.path}`;
    if (!row.mapping) return result(check, false, { finding: 24, failure_kind: "reader_gap", expected: "Explicit consumer and complete API evidence", actual: "Unmapped collection", detail: `${row.count} declared records; empty collections also require a mapping.` });
    if (row.kind === "configuration") return result(check, true, { expected: "Named configuration consumer", actual: row.mapping.consumer, detail: "Configuration inventory only; this is not live API or execution evidence." });
    if (row.mapping.productGap) return result(check, false, { finding: 24, failure_kind: "product_gap", expected: "Complete record API consumer", actual: "Pack export only", detail: row.mapping.productGap });
    const providers = [row.mapping.provider, ...row.mapping.alternateProviders ?? []];
    const attempted = evidence.filter((item) => canonicalCollectionPath(item.collection ?? "") === (row.mapping.evidenceCollection ?? row.canonicalPath) && providers.includes(item.provider));
    const matches = attempted.filter(item => typeof item.path === "string" && item.path.length > 0);
    const unservedFor = provider => [...row.mapping.unservedFields ?? [], ...row.mapping.unservedFieldsByProvider?.[provider] ?? []]
      .filter(field => row.records.some(record => record && Object.hasOwn(record, field)));
    const unservedFields = unservedFor(row.mapping.provider);
    const passed = providers.some((provider) => {
      const reads = attempted.filter((item) => item.provider === provider);
      return !unservedFor(provider).length && matches.some(item => item.provider === provider) && reads.every((item) => item.status === "passed");
    });
    return result(check, passed, { finding: 24, ...(!passed ? { failure_kind: !readersAttempted ? "boot_blocked" : !attempted.length ? "reader_gap" : unservedFields.length ? "product_gap" : "api_failure" } : {}), expected: { count: row.count, provider: row.mapping.provider, reader: row.mapping.apiReader, identity: row.mapping.identity },
      actual: matches, detail: passed ? "Complete live reader evidence supplied by caller." : unservedFields.length ? `The current primary projection/API omits source fields: ${unservedFields.join(", ")}. A complete alternate API reader is required.`
        : "No successful complete live API evidence for this collection." });
  });
}

export function compareIdentities({ check, expected, actual, expectedId = (row) => row?.id ?? row, actualId = expectedId, finding }) {
  const normalize = (rows, reader) => rows.map((row) => {
    const id = reader(row);
    return id === undefined || id === null ? null : typeof id === "object" ? JSON.stringify(canonical(id)) : String(id);
  });
  const wanted = normalize(expected, expectedId), served = normalize(actual, actualId);
  const counts = (ids) => ids.reduce((map, id) => map.set(id, (map.get(id) ?? 0) + 1), new Map());
  const left = counts(wanted), right = counts(served);
  const missing = [], unexpected = [];
  for (const [id, count] of left) if (count > (right.get(id) ?? 0)) missing.push({ id, count: count - (right.get(id) ?? 0) });
  for (const [id, count] of right) if (count > (left.get(id) ?? 0)) unexpected.push({ id, count: count - (left.get(id) ?? 0) });
  const invalid = wanted.includes(null) || served.includes(null);
  return result(check, !invalid && !missing.length && !unexpected.length, { ...(finding === undefined ? {} : { finding }),
    expected: wanted, actual: served, detail: { missing, unexpected, invalidIdentity: invalid } });
}

function stringValues(value, output = []) {
  if (typeof value === "string") output.push(value.toLowerCase());
  else if (value && typeof value === "object") for (const child of Object.values(value)) stringValues(child, output);
  return output;
}

function ownedVocabulary(world) {
  const tokens = new Set();
  const add = (value) => { if (typeof value === "string" && value.length >= 4) tokens.add(value.toLowerCase()); };
  // Restrict candidates to authored identities and resource names. Do not scan
  // prose for arbitrary words or treat API field names as world vocabulary.
  for (const person of world?.people ?? []) for (const key of ["id", "email", "name", "github_login", "slack_id"]) add(person[key]);
  for (const org of world?.organizations ?? []) for (const key of ["id", "domain", "name", "slug"]) add(org[key]);
  for (const repo of world?.software?.repositories ?? []) for (const key of ["name", "full_name"]) add(repo[key]);
  for (const product of world?.commerce?.products ?? []) add(product.name);
  function markers(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(marker|isolation_marker|generated_marker)$/.test(key)) add(child);
      markers(child);
    }
  }
  markers(world);
  return tokens;
}

export function exclusiveVocabulary(artifacts) {
  const entries = artifacts.map((artifact) => ({ key: `${artifact.identity?.id ?? artifact.world.id}:${artifact.identity?.version ?? artifact.world.version}`,
    tokens: ownedVocabulary(artifact.world), values: stringValues(artifact.world) }));
  return new Map(entries.map((active) => [active.key, [...new Set(entries.filter((other) => other !== active)
    .flatMap((other) => [...other.tokens]))].filter((token) => !active.values.some((value) => value.includes(token))).sort()]));
}

export function checkVocabularyIsolation({ check = "world.vocabulary-isolation", responses, foreignVocabulary = [], finding }) {
  const values = stringValues(responses);
  // A foreign repository name must not match the suffix of an owned bucket.
  // IDs include hyphens: relay-exports is not northstar-relay-exports.
  const hits = foreignVocabulary.filter((token) => {
    const escaped = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, "i");
    return values.some((value) => pattern.test(value));
  });
  return result(check, hits.length === 0, { ...(finding === undefined ? {} : { finding }), expected: [], actual: hits,
    detail: "Checks only supplied API responses and authored foreign identity/resource tokens; this is not proof for all possible API requests." });
}
