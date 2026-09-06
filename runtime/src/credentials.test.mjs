import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { credential, prepareCredentials, readRunCredentials } from "./credentials.mjs";
import { ensureGeneratedSecrets } from "./generated-secrets.mjs";
import { resolveBindings, resolveToken, resolveTokenReference } from "./bindings.mjs";
import { defaultEnvironment } from "./environments.mjs";
import { loadManifests } from "./manifests.mjs";
import { resolveEnvironment, serializeLock } from "./resolve.mjs";
import { bindingCanBePrinted } from "./cli.mjs";

const ROOT = join(import.meta.dirname, "../..");
const artifactPath = join(ROOT, "dist/business.saas-company.v2");
const manifests = loadManifests(join(ROOT, "emulators"));
const lock = resolveEnvironment(defaultEnvironment("business.saas-company:v2", { artifactPath, manifests, includeS3: true, includePostgres: true, includeMySQL: true, includeProviders: true }), {
  artifactPath, manifests,
});
const run = promisify(execFile);

test('personal credentials cannot substitute a shared grant belonging to another person', t => {
  const root = mkdtempSync(join(tmpdir(), 'worldfixture-person-grants-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(artifactPath, root, { recursive: true });
  const path = join(root, 'projections/emulator-overlay.json'), overlay = JSON.parse(readFileSync(path));
  const github = { profile: 'github.repositories.v1', person: 'jon-bell' };
  assert.equal(resolveTokenReference(root, github).reference, undefined);
  assert.deepEqual(resolveTokenReference(root, { ...github, person: 'maya-chen' }), { reference: 'token:github_token', scope: 'person' });
  assert.equal(resolveTokenReference(root, { ...github, person: 'unknown-person' }).reference, undefined);
  assert.equal(resolveTokenReference(root, { profile: github.profile }).scope, 'shared');
  for (const provider of ['slack', 'google', 'notion']) {
    const request = { profile: `${provider}.identity.v1`, person: 'jon-bell' };
    const key = `${provider}_token_jon-bell`;
    assert.equal(resolveTokenReference(root, request).scope, 'person');
    assert.throws(() => resolveToken(root, { ...request, credentials: { values: { [`token:${provider}_token`]: 'other-person-secret', 'token:demo_token': 'other-person-secret' } } }), /no credential/);
    const granted = overlay.tokens[key]; delete overlay.tokens[key];
    writeFileSync(path, JSON.stringify(overlay));
    assert.equal(resolveTokenReference(root, request).reference, undefined);
    overlay.tokens[key] = { ...granted, login: 'another-person' };
    writeFileSync(path, JSON.stringify(overlay));
    assert.equal(resolveTokenReference(root, request).reference, undefined);
  }
});

test("startup output excludes credentials, including secrets inside connection URLs", () => {
  for (const name of ["SLACK_TOKEN", "TWILIO_AUTH_TOKEN", "IMAP_PASSWORD", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) {
    assert.equal(bindingCanBePrinted(name, "generated-secret"), false, name);
  }
  assert.equal(bindingCanBePrinted("DATABASE_URL", "postgres://app:generated-secret@127.0.0.1:5432/app"), false);
  assert.equal(bindingCanBePrinted("SLACK_BASE_URL", "http://127.0.0.1:4703"), true);
});

test("two terminals and restarted runs share credentials; other projects and worlds do not", async t => {
  const project = mkdtempSync(join(tmpdir(), "worldfixture-credential-test-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const generatedSecretsPath = join(project, "generated-secrets.json");
  const stateDir = join(project, "run-a");
  const before = readFileSync(join(artifactPath, "projections/emulator-overlay.json"));
  const lockBefore = serializeLock(lock);
  const first = await prepareCredentials({ lock, artifactPath, stateDir, generatedSecretsPath });
  const restarted = await prepareCredentials({ lock, artifactPath, stateDir: join(project, "run-b"), generatedSecretsPath });
  const other = await prepareCredentials({ lock, artifactPath, stateDir: join(project, "other-run"), generatedSecretsPath: join(project, "other-project.json") });
  const world = await prepareCredentials({ lock: { ...lock, world: { ...lock.world, id: "another.world" } }, artifactPath, stateDir: join(project, "other-world-run"), generatedSecretsPath });
  assert.deepEqual(first, restarted);
  assert.deepEqual(readRunCredentials(stateDir, lock.world), first);
  for (const reference of Object.keys(first.values)) {
    assert.notEqual(first.values[reference], other.values[reference], reference);
    if (reference.startsWith("token:")) assert.notEqual(first.values[reference], world.values[reference], reference);
  }
  const secondTerminal = await run(process.execPath, ["--input-type=module", "-e",
    `import { readRunCredentials } from ${JSON.stringify(new URL("./credentials.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(readRunCredentials(process.argv[1])));`, stateDir], { cwd: tmpdir() });
  assert.deepEqual(JSON.parse(secondTerminal.stdout), first);
  assert.equal(statSync(join(stateDir, "credentials.json")).mode & 0o777, 0o600);
  assert.equal(statSync(generatedSecretsPath).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(join(artifactPath, "projections/emulator-overlay.json")), before);
  assert.equal(serializeLock(lock), lockBefore);
  assert.throws(() => readRunCredentials(stateDir, { id: "wrong", version: "v2" }), /different world/);
});

test("lost stores cannot make a later command mint a token the running service does not accept", async t => {
  const project = mkdtempSync(join(tmpdir(), "worldfixture-lost-credentials-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const generatedSecretsPath = join(project, "generated-secrets.json");
  const stateDir = join(project, "run");
  const first = await prepareCredentials({ lock, artifactPath, stateDir, generatedSecretsPath });
  unlinkSync(generatedSecretsPath);
  const resolve = credentials => resolveBindings(lock, { artifactPath, credentials, addressOf: () => ({ host: "127.0.0.1", port: 1234 }) });
  assert.deepEqual(resolve(readRunCredentials(stateDir)), resolve(first));
  unlinkSync(join(stateDir, "credentials.json"));
  assert.throws(() => readRunCredentials(stateDir), /cannot read this run's credentials/);
  assert.throws(() => credential({}, "token:slack_token_maya-chen"), /no credential/);
  writeFileSync(generatedSecretsPath, "{broken");
  await assert.rejects(() => prepareCredentials({ lock, artifactPath, stateDir, generatedSecretsPath }), /restore the file/);
  assert.equal(readFileSync(generatedSecretsPath, "utf8"), "{broken");
});

test("session generations rotate provider credentials while declared application credentials stay valid", async t => {
  const project = mkdtempSync(join(tmpdir(), "worldfixture-generation-credentials-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const generatedSecretsPath = join(project, "secrets.json");
  const first = await prepareCredentials({ lock, artifactPath, stateDir: join(project, "a"), generatedSecretsPath, generation: "generation-a" });
  const preservedCredentials = Object.fromEntries(Object.entries(first.values).filter(([key]) => key.startsWith("postgres.") || key.startsWith("mysql.")));
  assert.ok(Object.keys(preservedCredentials).length > 0);
  const second = await prepareCredentials({ lock, artifactPath, stateDir: join(project, "b"), generatedSecretsPath, generation: "generation-b", preservedCredentials });
  for (const [key, value] of Object.entries(first.values)) {
    if (Object.hasOwn(preservedCredentials, key)) assert.equal(second.values[key], value, key);
    else assert.notEqual(second.values[key], value, key);
  }
  const restart = await prepareCredentials({ lock, artifactPath, stateDir: join(project, "b-again"), generatedSecretsPath, generation: "generation-b", preservedCredentials });
  assert.deepEqual(restart, second);
});

test("concurrent startup processes retain every generated key and agree on shared keys", async t => {
  const project = mkdtempSync(join(tmpdir(), "worldfixture-concurrent-credentials-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const path = join(project, "generated-secrets.json");
  const script = `import { ensureGeneratedSecrets } from ${JSON.stringify(new URL("./generated-secrets.mjs", import.meta.url).href)}; const values = await ensureGeneratedSecrets(process.argv[1], ["shared", process.argv[2]]); process.stdout.write(values.shared);`;
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => run(process.execPath, ["--input-type=module", "-e", script, path, `key-${index}`])));
  assert.equal(new Set(results.map(result => result.stdout)).size, 1);
  const stored = await ensureGeneratedSecrets(path, []);
  assert.equal(Object.keys(stored).length, 9);
});

test("managed mail requires both person and Cyrus admin passwords before it can seed", async t => {
  const root = mkdtempSync(join(tmpdir(), "worldfixture-mail-credentials-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "run");
  const credentials = await prepareCredentials({ lock, artifactPath, stateDir, generatedSecretsPath: join(root, "secrets.json") });
  const path = join(stateDir, "credentials.json");
  const prepare = destination => run("perl", [join(ROOT, "emulators/mail/world-mail.pl"), "prepare", artifactPath, join(root, destination)], {
    env: { ...process.env, WORLDFIXTURE_CREDENTIALS: path },
  });
  await prepare("valid");
  assert.ok(readFileSync(join(root, "valid/accounts.tsv"), "utf8").includes(credential(credentials, "mail-password:maya-chen")));
  assert.ok(readFileSync(join(root, "valid/admin.tsv"), "utf8").includes(credential(credentials, "mail-password:cyrus-admin")));
  for (const reference of ["mail-password:maya-chen", "mail-password:cyrus-admin"]) {
    const incomplete = structuredClone(credentials);
    delete incomplete.values[reference];
    writeFileSync(path, JSON.stringify(incomplete));
    await assert.rejects(() => prepare(reference.replaceAll(":", "-")), error => error.stderr.includes(`no credential for ${reference}`));
  }
  unlinkSync(path);
  await assert.rejects(() => prepare("missing-file"), error => error.stderr.includes("not readable"));
});
