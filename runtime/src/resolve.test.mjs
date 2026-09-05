// The resolver's contract, and the two capability-ownership rules it exists to
// enforce.
//
// These run against the real service manifests and the real built artifact, not
// fixtures, because the rules being tested are about how four particular
// services actually overlap. A fixture would pass whatever the services did.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { loadManifests } from "./manifests.mjs";
import { defaultEnvironment } from "./environments.mjs";
import { resolveBindings } from "./bindings.mjs";
import { prepareCredentials } from "./credentials.mjs";
import { canonical, resolveEnvironment, serializeLock } from "./resolve.mjs";
import { validate } from "./schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT = join(ROOT, "dist/business.saas-company.v2");
const MANIFESTS = loadManifests(join(ROOT, "emulators"));
const GENERATED_SECRETS = join(mkdtempSync(join(tmpdir(), "worldfixture-secrets-")), "generated-secrets.json");
const CREDENTIALS = await prepareCredentials({
  lock: resolveEnvironment(defaultEnvironment("business.saas-company:v2", { includeS3: true, includeProviders: true, includePostgres: true, includeMySQL: true }), { manifests: MANIFESTS, artifactPath: ARTIFACT }),
  artifactPath: ARTIFACT, stateDir: dirname(GENERATED_SECRETS), generatedSecretsPath: GENERATED_SECRETS,
});

const schema = (name) => JSON.parse(readFileSync(join(ROOT, "schemas", `${name}.schema.json`), "utf8"));

function environment(requires, extra = {}) {
  return {
    api_version: "worldfixture.environment/v1",
    world: { use: "business.saas-company:v2" },
    requires,
    ...extra,
  };
}

function resolve(spec) {
  return resolveEnvironment(spec, { manifests: MANIFESTS, artifactPath: ARTIFACT });
}

function refuses(spec) {
  try {
    resolve(spec);
  } catch (error) {
    if (error.name !== "ResolutionError") throw error;
    return error;
  }
  assert.fail("expected the resolver to refuse this environment");
}

// The environment the first slice aims at: Maya sends through Slack, Priya reads
// through IMAP.
const FIRST_SLICE = environment(
  ["slack.messaging.v1", "mail.imap.v1", "mail.smtp-submission.v1"],
  {
    bindings: {
      SLACK_BASE_URL: "slack.messaging.v1/base_url",
      SLACK_TOKEN: "slack.messaging.v1/token",
      IMAP_HOST_PORT: "mail.imap.v1/host_port",
    },
    target: { kind: "none", identity: "person.maya-chen" },
  },
);

// ---- the contract --------------------------------------------------------

test("the first-slice environment satisfies environment.v1", () => {
  assert.deepEqual(validate(FIRST_SLICE, schema("environment.v1")), []);
});

test("the lock it resolves to satisfies environment-lock.v1", () => {
  assert.deepEqual(validate(resolve(FIRST_SLICE), schema("environment-lock.v1")), []);
});

test("the validator rejects what the environment schema forbids", () => {
  // A validator that passes everything makes the two tests above vacuous.
  const cases = [
    ["wrong api_version", { ...FIRST_SLICE, api_version: "droplive.environment/v1" }],
    ["no requires", { ...FIRST_SLICE, requires: [] }],
    ["unversioned capability", { ...FIRST_SLICE, requires: ["slack.messaging"] }],
    ["world without a version", { ...FIRST_SLICE, world: { use: "business.saas-company" } }],
    ["lower-case binding name", { ...FIRST_SLICE, bindings: { slack_url: "slack.messaging.v1/base_url" } }],
    ["binding with no attribute", { ...FIRST_SLICE, bindings: { SLACK: "slack.messaging.v1" } }],
  ];
  for (const [name, spec] of cases) {
    assert.notDeepEqual(validate(spec, schema("environment.v1")), [], name);
  }
});

test("a lock is a pure function of its inputs", () => {
  // The lock carries no timestamp and no port number, so two resolutions of one
  // specification have to be byte-identical or nothing downstream can compare
  // two runs.
  assert.equal(serializeLock(resolve(FIRST_SLICE)), serializeLock(resolve(FIRST_SLICE)));
});

test("a changed specification is a different lock", () => {
  const other = environment(["slack.messaging.v1"]);
  assert.notEqual(resolve(FIRST_SLICE).environment_sha256, resolve(other).environment_sha256);
});

test("canonical form is insensitive to key order and nothing else", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});

// ---- capability selection ------------------------------------------------

test("each required capability is pinned to one service and one port", () => {
  const lock = resolve(FIRST_SLICE);
  assert.deepEqual(lock.capabilities, {
    "mail.imap.v1": { service: "mail", port: "imap" },
    "mail.smtp-submission.v1": { service: "mail", port: "smtp" },
    "slack.messaging.v1": { service: "emulate", port: "slack" },
  });
});

test("PostgreSQL supplies a complete application connection", () => {
  const lock = resolve(environment(["postgres.wire.v1"], {
    bindings: {
      POSTGRES_HOST: "postgres.wire.v1/host",
      POSTGRES_PORT: "postgres.wire.v1/port",
      POSTGRES_USERNAME: "postgres.wire.v1/username",
      POSTGRES_PASSWORD: "postgres.wire.v1/password",
      POSTGRES_DATABASE: "postgres.wire.v1/database",
      POSTGRES_URL: "postgres.wire.v1/url"
    },
  }));
  const result = resolveBindings(lock, {
    artifactPath: ARTIFACT,
    addressOf: () => ({ host: "127.0.0.1", port: 55432 }),
    credentials: CREDENTIALS,
  });

  assert.deepEqual(result.unresolved, []);
  assert.equal(lock.bindings.POSTGRES_PASSWORD.key, "postgres.password");
  assert.equal(lock.bindings.POSTGRES_PASSWORD.value, undefined);
  assert.equal(
    lock.services.find((service) => service.name === "postgres").environment
      .find((entry) => entry.name === "POSTGRES_PASSWORD").key,
    "postgres.password",
  );
  assert.equal(result.resolved.POSTGRES_HOST.value, "127.0.0.1");
  assert.equal(result.resolved.POSTGRES_PORT.value, "55432");
  assert.equal(result.resolved.POSTGRES_USERNAME.value, "worldfixture");
  assert.match(result.resolved.POSTGRES_PASSWORD.value, /^[0-9a-f]{48}$/);
  assert.equal(result.resolved.POSTGRES_PASSWORD.scope, "project");
  assert.equal(result.resolved.POSTGRES_DATABASE.value, "postgres");
  assert.equal(
    result.resolved.POSTGRES_URL.value,
    `postgresql://worldfixture:${result.resolved.POSTGRES_PASSWORD.value}@127.0.0.1:55432/postgres`,
  );
});

test("MySQL supplies a complete application connection", () => {
  const lock = resolve(environment(["mysql.wire.v1"], {
    bindings: {
      MYSQL_HOST: "mysql.wire.v1/host",
      MYSQL_PORT: "mysql.wire.v1/port",
      MYSQL_USERNAME: "mysql.wire.v1/username",
      MYSQL_PASSWORD: "mysql.wire.v1/password",
      MYSQL_DATABASE: "mysql.wire.v1/database",
      MYSQL_URL: "mysql.wire.v1/url"
    },
  }));
  const result = resolveBindings(lock, {
    artifactPath: ARTIFACT,
    addressOf: () => ({ host: "127.0.0.1", port: 33306 }),
    credentials: CREDENTIALS,
  });

  assert.deepEqual(result.unresolved, []);
  assert.equal(result.resolved.MYSQL_HOST.value, "127.0.0.1");
  assert.equal(result.resolved.MYSQL_PORT.value, "33306");
  assert.equal(result.resolved.MYSQL_USERNAME.value, "worldfixture");
  assert.match(result.resolved.MYSQL_PASSWORD.value, /^[0-9a-f]{48}$/);
  assert.equal(result.resolved.MYSQL_PASSWORD.scope, "project");
  assert.equal(result.resolved.MYSQL_DATABASE.value, "worldfixture");
  assert.equal(
    result.resolved.MYSQL_URL.value,
    `mysql://worldfixture:${result.resolved.MYSQL_PASSWORD.value}@127.0.0.1:33306/worldfixture`,
  );
});

test("the world the artifact holds must be the world the environment asked for", () => {
  const error = refuses(environment(["slack.messaging.v1"], { world: { use: "business.saas-company:v3" } }));
  assert.equal(error.code, "world_mismatch");
});

test("the product image default includes providers and SeaweedFS but closes composer AWS", () => {
  const lock = resolve(
    defaultEnvironment("business.saas-company:v2", { includeS3: true, includeProviders: true }),
  );

  assert.deepEqual(lock.capabilities["aws.s3.objects.v1"], { service: "s3", port: "s3" });
  for (const profile of [
    "apple.oauth.v1",
    "clerk.organizations.v1",
    "github.apps.v1",
    "google.gmail.v1",
    "google.calendar.v1",
    "google.drive.v1",
    "linear.teams.v1",
    "microsoft.graph-users.v1",
    "mongoatlas.clusters.v1",
    "notion.users.v1",
    "notion.oauth.v1",
    "notion.webhooks.v1",
    "notion.pages-read.v1",
    "notion.pages-write.v1",
    "notion.blocks-read.v1",
    "notion.blocks-write.v1",
    "notion.meeting-notes.v1",
    "notion.agents.v1",
    "notion.sessions.v1",
    "notion.databases.v1",
    "notion.data-sources.v1",
    "notion.views.v1",
    "notion.custom-emojis.v1",
    "notion.async-tasks.v1",
    "notion.markdown.v1",
    "notion.comments.v1",
    "notion.file-uploads.v1",
    "okta.groups.v1",
    "resend.domains.v1",
    "slack.oauth.v1",
    "stripe.catalog.v1",
    "twilio.verify.v1",
    "vercel.teams.v1",
  ]) {
    assert.equal(lock.capabilities[profile].service, "emulate", profile);
  }
  assert.deepEqual(
    lock.services.find((service) => service.name === "emulate").ports.map((port) => port.name).sort(),
    [
      "apple", "clerk", "github", "google", "linear", "microsoft", "mongoatlas",
      "notion", "okta", "resend", "slack", "stripe", "twilio", "vercel",
    ],
  );
  assert.equal(lock.bindings.S3_BASE_URL.service, "s3");
  const s3 = resolveBindings(lock, {
    artifactPath: ARTIFACT,
    addressOf: () => ({ host: "127.0.0.1", port: 61006 }),
    credentials: CREDENTIALS,
  }).resolved;
  assert.match(s3.S3_ACCESS_KEY_ID.value, /^[0-9a-f]{48}$/);
  assert.match(s3.S3_SECRET_ACCESS_KEY.value, /^[0-9a-f]{48}$/);
  assert.notEqual(s3.S3_ACCESS_KEY_ID.value, s3.S3_SECRET_ACCESS_KEY.value);
  assert.equal(s3.S3_REGION.value, "eu-west-2");
  assert.equal(s3.S3_BUCKET.value, "northstar-relay-documents");
  assert.equal(s3.S3_PATH_STYLE.value, "true");
  assert.ok(lock.closed_conflicts.some((entry) => entry.disclaimed_by === "emulate" && entry.port === "aws"));
});

// ---- ports ---------------------------------------------------------------

test("the composer starts only the vendors a run selected", () => {
  // A vendor is enabled by being given a port. Fourteen are declared; a run that
  // needs Slack pays for Slack.
  const lock = resolve(environment(["slack.messaging.v1"]));
  const emulate = lock.services.find((service) => service.name === "emulate");
  assert.deepEqual(emulate.ports.map((port) => port.name), ["slack"]);
});

test("the Notion REST profiles share one listener", () => {
  const profiles = [
    "notion.users.v1", "notion.oauth.v1", "notion.webhooks.v1", "notion.pages-read.v1", "notion.pages-write.v1",
    "notion.blocks-read.v1", "notion.blocks-write.v1", "notion.meeting-notes.v1", "notion.agents.v1", "notion.sessions.v1", "notion.databases.v1",
    "notion.data-sources.v1", "notion.views.v1", "notion.custom-emojis.v1", "notion.async-tasks.v1",
    "notion.markdown.v1", "notion.comments.v1", "notion.file-uploads.v1",
  ];
  const lock = resolve(environment(profiles, {
    bindings: { NOTION_TOKEN: "notion.pages-read.v1/token" },
    target: { kind: "none", identity: "maya-chen" },
  }));
  for (const profile of profiles) assert.deepEqual(lock.capabilities[profile], { service: "emulate", port: "notion" });
  const emulate = lock.services.find((service) => service.name === "emulate");
  assert.deepEqual(emulate.ports.map((port) => port.name), ["notion"]);
  assert.equal(emulate.readiness[0].path, "/.well-known/oauth-protected-resource");
  assert.equal(lock.bindings.NOTION_TOKEN.person, "maya-chen");
});

test("a profile dependency selects its provider and pins its internal binding", () => {
  const lock = resolve(environment(["notion.file-uploads.v1"]));

  assert.deepEqual(lock.capabilities["aws.s3.objects.v1"], { service: "s3", port: "s3" });
  const dependency = lock.services.find((service) => service.name === "emulate").environment
    .find((entry) => entry.name === "WORLDFIXTURE_NOTION_OBJECT_STORE_URL");
  assert.deepEqual(dependency, {
    name: "WORLDFIXTURE_NOTION_OBJECT_STORE_URL",
    from: "capability.port.url",
    profile: "aws.s3.objects.v1",
    attribute: "base_url",
    service: "s3",
    port: "s3",
    required: true,
  });
});

test("a service that cannot start without a port always gets it", () => {
  // SeaweedFS needs its master, volume and filer ports whether or not an
  // application calls them, and its readiness seed gate is on the filer.
  const lock = resolve(environment(["aws.s3.objects.v1"]));
  const s3 = lock.services.find((service) => service.name === "s3");
  assert.deepEqual(
    s3.ports.map((port) => port.name).sort(),
    ["filer", "filer-grpc", "master", "master-grpc", "s3", "s3-grpc", "volume", "volume-grpc"],
  );
  assert.deepEqual(s3.ports.filter((port) => port.published).map((port) => port.name), ["s3"]);
});

test("a seed gate is kept whichever capabilities were selected", () => {
  const lock = resolve(environment(["mail.imap.v1"]));
  const mail = lock.services.find((service) => service.name === "mail");
  const gates = mail.readiness.filter((check) => check.kind === "seed_gate");
  assert.deepEqual(gates.map((check) => check.port), ["health"]);
});

test("readiness is carried only for ports the run opens", () => {
  const lock = resolve(environment(["slack.messaging.v1"]));
  const emulate = lock.services.find((service) => service.name === "emulate");
  assert.deepEqual(emulate.readiness.map((check) => check.port), ["slack"]);
  assert.equal(emulate.readiness[0].kind, "protocol");
});

test("a published port with no protocol check is refused, not started blind", () => {
  // AWS is deliberately the only composer vendor with no readiness check. Its
  // listener also owns live S3 routes, so selecting even IAM must fail before a
  // run can raise that second S3 owner beside SeaweedFS.
  const error = refuses(environment(["aws.iam.v1"]));
  assert.equal(error.code, "capability_not_provable");
  assert.equal(error.detail.port, "aws");
});

// ---- S3 has exactly one owner --------------------------------------------

test("no manifest but the S3 service claims an S3 capability", () => {
  const claimants = MANIFESTS.filter((manifest) =>
    manifest.provides.some((entry) => entry.profile.startsWith("aws.s3.")),
  );
  assert.deepEqual(claimants.map((manifest) => manifest.name), ["s3"]);
});

test("selecting SeaweedFS closes the composer's S3 port and records why", () => {
  // Measured live: @emulators/aws answers PUT bucket, PUT object and GET object
  // with 200, and self-seeds three buckets the world never declares. Withholding
  // its projection changed what those routes serve, not whether they exist.
  const lock = resolve(environment(["aws.s3.objects.v1", "slack.messaging.v1"]));
  const emulate = lock.services.find((service) => service.name === "emulate");

  assert.ok(!emulate.ports.some((port) => port.name === "aws"), "the aws port must not be open");
  assert.deepEqual(lock.closed_conflicts.map((entry) => [entry.profile, entry.owner, entry.disclaimed_by]), [
    ["aws.s3.objects.v1", "s3", "emulate"],
  ]);
  assert.equal(lock.closed_conflicts[0].action, "port_closed");
});

test("a second S3 owner that cannot be closed is refused", () => {
  // `aws.iam.v1` lives on the same listener as the S3 routes, so the port cannot
  // be shut without taking IAM with it. Two owners of one provider's mutable
  // state is what the design forbids, so this fails rather than picking one.
  const error = refuses(environment(["aws.s3.objects.v1", "aws.iam.v1"]));
  assert.equal(error.code, "capability_conflict");
  assert.equal(error.detail.owner, "s3");
  assert.deepEqual(error.detail.blocked_by, ["aws.iam.v1"]);
});

test("the rule is about ownership, not about the aws port being unwelcome", () => {
  // With no S3 owner selected there is no second owner and nothing to close, so
  // the refusal changes shape: `aws.iam.v1` alone fails because no measured
  // readiness check exists for that vendor, not because anything conflicts.
  // Eleven of the composer's fourteen vendors are unselectable for that reason
  // today, and that is the honest state rather than a conflict.
  const error = refuses(environment(["aws.iam.v1", "slack.messaging.v1"]));
  assert.equal(error.code, "capability_not_provable");
  assert.equal(error.detail.port, "aws");
});

test("an ownership conflict is decided before a provability refusal", () => {
  // Both apply to the aws port. The conflict is the more specific answer and
  // the one a user can act on, so it must win.
  const error = refuses(environment(["aws.s3.objects.v1", "aws.iam.v1"]));
  assert.equal(error.code, "capability_conflict");
});

// ---- Cyrus and Gmail are not rivals --------------------------------------

test("Cyrus and Gmail resolve together, as separate capabilities", () => {
  // They carry the same person's mail on purpose: one is the world's mailbox
  // over IMAP, the other the integration surface an application is built
  // against. A resolver that grouped profiles into families would refuse this.
  const lock = resolve(environment(["mail.imap.v1", "google.gmail.v1"]));

  assert.deepEqual(lock.capabilities["mail.imap.v1"], { service: "mail", port: "imap" });
  assert.deepEqual(lock.capabilities["google.gmail.v1"], { service: "emulate", port: "google" });
  assert.deepEqual(lock.closed_conflicts, []);
  assert.deepEqual(lock.services.map((service) => service.name), ["emulate", "mail"]);
});

test("both mail surfaces read the same world and neither is disclaimed", () => {
  const disclaimed = MANIFESTS.flatMap((manifest) => (manifest.disclaims ?? []).map((entry) => entry.profile));
  assert.ok(!disclaimed.includes("mail.imap.v1"));
  assert.ok(!disclaimed.includes("google.gmail.v1"));
});

// ---- bindings ------------------------------------------------------------

test("a binding resolves to a service, a port and how to compute it", () => {
  const lock = resolve(FIRST_SLICE);
  assert.deepEqual(lock.bindings.SLACK_BASE_URL, {
    service: "emulate",
    profile: "slack.messaging.v1",
    attribute: "base_url",
    from: "port.url",
    port: "slack",
  });
  // A per-person attribute additionally carries whose credential it is.
  assert.deepEqual(lock.bindings.SLACK_TOKEN, {
    service: "emulate",
    profile: "slack.messaging.v1",
    attribute: "token",
    from: "projection",
    port: "slack",
    pointer: "/tokens",
    person: "person.maya-chen",
  });
});

test("the lock in memory is the lock on disk", () => {
  // The environment digest is taken over serialized bytes, so an optional field
  // present in one and absent in the other would make two equal locks unequal.
  const lock = resolve(FIRST_SLICE);
  assert.deepEqual(JSON.parse(serializeLock(lock)), lock);
});

test("the lock pins where a binding comes from and never a port number", () => {
  const lock = resolve(FIRST_SLICE);
  assert.ok(!serializeLock(lock).includes("4003"), "a lock must not carry an allocated port");
  for (const binding of Object.values(lock.bindings)) {
    assert.ok(!("port_number" in binding));
  }
});

test("a per-person credential needs a person", () => {
  // Every Slack token in this world once resolved to the default admin. There is
  // no anonymous default, so a token binding without an identity is refused.
  const error = refuses(environment(["slack.messaging.v1"], {
    bindings: { SLACK_TOKEN: "slack.messaging.v1/token" },
  }));
  assert.equal(error.code, "identity_required");
});

test("a binding on a capability the environment does not require is refused", () => {
  const error = refuses(environment(["slack.messaging.v1"], {
    bindings: { GITHUB_HOST: "github.repositories.v1/base_url" },
    target: { kind: "none", identity: "person.maya-chen" },
  }));
  assert.equal(error.code, "binding_not_required");
});

test("a binding on an attribute the service does not declare is refused", () => {
  const error = refuses(environment(["slack.messaging.v1"], {
    bindings: { SLACK_WEBHOOK: "slack.messaging.v1/webhook_url" },
    target: { kind: "none", identity: "person.maya-chen" },
  }));
  assert.equal(error.code, "binding_not_declared");
  assert.equal(error.detail.attribute, "webhook_url");
});

// ---- the world -----------------------------------------------------------

test("the lock pins a digest for every artifact file a selected service reads", () => {
  const lock = resolve(FIRST_SLICE);
  assert.deepEqual(Object.keys(lock.world.projections).sort(), [
    "manifest.json",
    "projections/emulator-overlay.json",
    "projections/mail.json",
    "world.json",
  ]);
  for (const [file, entry] of Object.entries(lock.world.projections)) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, file);
    assert.ok(entry.size > 0, `${file} has a real size`);
  }
});

test("the lock records which services verify a projection and which only read it", () => {
  // Only the composer checks a digest before using its projection. Recording
  // that is what stops "verified" being assumed of the other three.
  const lock = resolve(FIRST_SLICE);
  assert.deepEqual(lock.world.projections["projections/emulator-overlay.json"].verified_by, ["emulate"]);
  assert.deepEqual(lock.world.projections["projections/mail.json"].verified_by, []);
  assert.deepEqual(lock.world.projections["projections/mail.json"].read_by, ["mail"]);
});
