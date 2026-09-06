// Run every built world against the product image. This is a strict defect gate:
// the initial audit is expected to fail, and its JSON report says exactly why.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { checkVocabularyIsolation, collectionCoverage, discoverArtifacts, exclusiveVocabulary, inventoryCollections, snapshotArtifact } from "./coupling-artifacts.mjs";
import { probeExtraWorld, SUPPLEMENTAL_PROVIDERS } from "./coupling-extra-probes.mjs";
import { probeFinanceWorld } from "./coupling-finance-probes.mjs";
import { probeGoogleWorld } from "./coupling-google-probes.mjs";
import { probeMailWorld } from "./coupling-mail-probes.mjs";
import { probeNotionWorld } from "./coupling-notion-probes.mjs";
import { probeWorld } from "./coupling-probes.mjs";
import { probeRelationshipsWorld } from "./coupling-relationships-probes.mjs";
import { reportMarkdown, summarizeReport } from "./coupling-report.mjs";
import { containerArguments, credentialValues, docker, mappedBindings, pauseRunClock, readRunBindings, readRunCredentialSet, redact, removeOwnedContainer, responseInventory, waitForReady } from "./coupling-runner.mjs";
import { runTemporalWorld } from "./coupling-temporal-probes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = promisify(execFile);
const python = process.env.PYTHON ?? "python3";
const { values } = parseArgs({ options: {
  image: { type: "string", default: process.env.WORLDFIXTURE_IMAGE ?? "worldfixture:local" },
  dist: { type: "string", default: join(ROOT, "dist") },
  report: { type: "string", default: join(ROOT, ".worldfixture/coupling", new Date().toISOString().replaceAll(":", "-")) },
  seed: { type: "string", default: "coupling-regression-2026-09-05" },
  "fresh-seed": { type: "string", default: randomBytes(12).toString("hex") },
  "ready-timeout-ms": { type: "string", default: "180000" },
} });
const timeoutMs = Number(values["ready-timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("--ready-timeout-ms must be a positive integer");
const reportDir = resolve(values.report);
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const owner = randomBytes(12).toString("hex");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort(new Error(`matrix interrupted by ${signal}`)));
const report = { api_version: "worldfixture.coupling-report/v1", started_at: new Date().toISOString(),
  image: values.image, regression_seed: values.seed, fresh_seed: values["fresh-seed"],
  scope: "Artifact integrity, collection consumers, and the public API requests listed per world. No claim covers unexercised operations.",
  cases: [], checks: [] };
const save = () => {
  writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(reportDir, "SUMMARY.md"), reportMarkdown(report), { mode: 0o600 });
};
const fail = (check, error, finding) => ({ check, status: "failed", ...(finding ? { finding } : {}), detail: error.message ?? String(error) });
const queued = [];
const temporalRuns = new Map();

async function generatedArtifacts() {
  const result = [];
  for (const [label, seed] of [["regression", values.seed], ["fresh", values["fresh-seed"]]]) {
    for (const variant of ["short", "long"]) {
      const directory = join(reportDir, `alien-${label}-${variant}`);
      mkdirSync(directory, { recursive: true });
      const source = join(directory, "source.json");
      const output = join(directory, "artifact");
      try {
        await run(python, [join(ROOT, "tests/fixtures/alien-world.py"), "--seed", seed, "--variant", variant, "--output", source], { cwd: ROOT });
        await run(python, ["-m", "worldfixture_compiler", "build", source, "--output", output], {
          cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, "compiler") }, maxBuffer: 1024 * 1024,
        });
        result.push({ path: output, label: `alien-${label}-${variant}`, seed, variant });
      } catch (error) {
        report.cases.push({ label: `alien-${label}-${variant}`, seed, variant, checks: [fail("alien.build", error)] });
      }
    }
  }
  return result;
}

async function runWorld(entry, artifact, foreignVocabulary, exposedPorts) {
  const item = { label: entry.label, identity: artifact.identity, source_artifact_path: entry.path, artifact_path: artifact.path, seed: entry.seed, variant: entry.variant,
    checks: [...artifact.checks], collections: [], responses: [] };
  report.cases.push(item);
  const inventories = [["world", inventoryCollections(artifact.world)], ["packs", inventoryCollections(artifact.packs)]];
  item.collections = inventories.flatMap(([source, rows]) => rows.map(({ records, ...row }) => ({ source, ...row })));
  const name = `wf-coupling-${owner}-${report.cases.length}`;
  let started = false, bindings = {}, responses = [], coverage = [];
  let secrets = credentialValues(artifact.projections);
  console.log(`${entry.label}: starting ${artifact.identity.id}:${artifact.identity.version}`);
  try {
    abort.signal.throwIfAborted();
    if (artifact.checks.some((check) => check.status === "failed")) throw new Error("artifact integrity failed; refusing to boot unverified data");
    await docker(containerArguments({ image: report.image_id, artifactPath: artifact.path, name, owner, exposedPorts }), { timeout: 60_000 });
    started = true;
    await waitForReady(name, { timeoutMs, signal: abort.signal });
    item.checks.push({ check: "world.boot", status: "passed" });
    const clock = await pauseRunClock(name);
    item.checks.push({ check: "world.baseline-clock-paused", status: clock.running === false ? "passed" : "failed", actual: clock });
    bindings = await readRunBindings(name);
    secrets = [...secrets, ...credentialValues(bindings)];
    const [inspection] = JSON.parse((await docker(["inspect", name])).stdout);
    bindings = mappedBindings(bindings, inspection.NetworkSettings.Ports);
    item.selected_bindings = Object.keys(bindings).sort();
    const lock = JSON.parse((await docker(["exec", name, "node", "-e",
      "process.stdout.write(require('node:fs').readFileSync('/state/environment.lock.json','utf8'))"])).stdout);
    item.selected_capabilities = lock.capabilities;
    item.checks.push({ check: "world.active-identity", status: lock.world.id === artifact.identity.id && lock.world.version === artifact.identity.version && lock.world.artifact_sha256 === artifact.identity.digest ? "passed" : "failed",
      expected: artifact.identity, actual: lock.world });
    const credentials = await readRunCredentialSet(name);
    secrets.push(...Object.values(credentials.values));
    const probes = await probeWorld({ artifact, bindings, credentials, elapsedMs: clock.elapsed_ms, supplementalGoogle: true, supplementalProviders: [...SUPPLEMENTAL_PROVIDERS, "mail"] });
    item.checks.push(...probes.checks);
    responses = probes.responses;
    coverage = probes.coverage;
    const extra = await probeExtraWorld({ artifact, bindings, supplementalApple: true, supplementalNotion: true, supplementalTemporal: temporalRuns.has(entry.label) });
    item.checks.push(...extra.checks);
    responses.push(...extra.responses);
    coverage.push(...extra.coverage);
    const selectedReaders = [
      ...(bindings.GOOGLE_BASE_URL || artifact.projections.google ? [probeGoogleWorld] : []),
      ...(bindings.STRIPE_BASE_URL || artifact.projections.stripe ? [probeFinanceWorld] : []),
      probeRelationshipsWorld,
    ];
    for (const reader of selectedReaders) {
      abort.signal.throwIfAborted();
      const result = await reader({ artifact, bindings, credentials, elapsedMs: clock.elapsed_ms, domainCoverage: probes.coverage });
      item.checks.push(...result.checks);
      responses.push(...result.responses);
      coverage.push(...result.coverage);
    }
    if (bindings.NOTION_BASE_URL || artifact.projections.notion) {
      const notion = await probeNotionWorld({ artifact, bindings, credentials });
      item.checks.push(...notion.checks);
      responses.push(...notion.responses);
      coverage.push(...notion.coverage);
    }
    if (bindings.IMAP_HOST_PORT || artifact.projections.mail) {
      const mail = await probeMailWorld({ artifact, bindings, credentials, elapsedMs: clock.elapsed_ms });
      item.checks.push(...mail.checks);
      responses.push(...mail.responses);
      coverage.push(...mail.coverage);
    }
    if (bindings.WORKBENCH_URL) {
      try {
        const response = await fetch(`${bindings.WORKBENCH_URL.replace(/\/$/, "")}/api/overview`, { signal: AbortSignal.timeout(60_000) });
        const body = await response.json();
        responses.push({ provider: "workbench", path: "/api/overview", status: response.status, body });
        item.checks.push({ check: "workbench.active-world", status: response.ok && body.world?.id === artifact.identity.id && body.world?.version === artifact.identity.version ? "passed" : "failed",
          expected: artifact.identity.id, actual: body.world?.id ?? response.status });
      } catch (error) { item.checks.push(fail("workbench.active-world", error)); }
    }
  } catch (error) {
    item.checks.push(fail(started && item.checks.some((check) => check.check === "world.boot") ? "world.probe" : "world.boot", error, artifact.world.profile ? undefined : 25));
  } finally {
    if (temporalRuns.has(entry.label)) {
      const temporal = await temporalRuns.get(entry.label);
      item.checks.push(...temporal.checks);
      responses.push(...temporal.responses);
      coverage.push(...temporal.coverage);
    }
    item.checks.push(...inventories.flatMap(([source, rows]) => collectionCoverage(rows, { evidence: coverage, readersAttempted: item.checks.some(check => check.check === "world.boot" && check.status === "passed") })
      .map((check) => ({ ...check, check: `${source}.${check.check}` }))));
    if (responses.length) item.checks.push(checkVocabularyIsolation({ responses, foreignVocabulary }));
    else item.checks.push(fail("world.vocabulary-isolation", "No API responses were available; isolation is unproved."));
    item.responses = responseInventory(responses);
    if (started) {
      try {
        const logs = await docker(["logs", "--tail", "300", name]);
        writeFileSync(join(reportDir, `${entry.label}.log`), redact(logs.stdout + logs.stderr, secrets), { mode: 0o600 });
      } catch (error) { item.checks.push(fail("evidence.logs", error)); }
    }
    // A timed-out docker run may already have created the container. Inspect
    // the exact name even when launch did not return, and verify its owner.
    try { await removeOwnedContainer(name, owner); }
    catch (error) { item.checks.push(fail("container.cleanup", error)); }
    Object.assign(item, redact(item, secrets));
    item.failures = item.checks.filter((check) => check.status === "failed").length;
    console.log(`${entry.label}: ${item.failures} failed checks; ${item.responses.length} API responses recorded`);
    save();
  }
}

try {
  const entries = discoverArtifacts(resolve(values.dist)).map((path) => ({ path, label: basename(path) }));
  if (!entries.length) throw new Error("No built artifacts found. Build the world sources before running this gate.");
  entries.push(...await generatedArtifacts());
  const inputs = join(reportDir, "inputs");
  mkdirSync(inputs, { recursive: true });
  for (const [index, entry] of entries.entries()) {
    try { queued.push({ entry, artifact: snapshotArtifact(entry.path, join(inputs, `${index}-${entry.label}`)) }); }
    catch (error) { report.cases.push({ label: entry.label, checks: [fail("artifact.load", error)] }); }
  }
  await docker(["version", "--format", "{{.Server.Version}}"]);
  const [image] = JSON.parse((await docker(["image", "inspect", values.image])).stdout);
  report.image_id = image.Id;
  const exposedPorts = Object.keys(image.Config.ExposedPorts ?? {});
  const vocabulary = exclusiveVocabulary(queued.map((entry) => entry.artifact));
  for (const [index, { entry, artifact }] of queued.entries()) {
    if (!artifact.projections["http-targets"]?.feeds?.length) continue;
    temporalRuns.set(entry.label, runTemporalWorld({ artifact, image: report.image_id, name: `wf-coupling-${owner}-http-${index}`, owner, signal: abort.signal,
      onProgress: ({ remaining_seconds }) => console.log(`${entry.label}: HTTP arrival checks; ${remaining_seconds}s remaining`) }));
  }
  for (const { entry, artifact } of queued) {
    await runWorld(entry, artifact, vocabulary.get(`${artifact.identity.id}:${artifact.identity.version}`), exposedPorts);
  }
} catch (error) {
  report.checks.push(fail("matrix.infrastructure", error));
  for (const { entry, artifact } of queued) {
    if (report.cases.some((item) => item.label === entry.label)) continue;
    report.cases.push({ label: entry.label, identity: artifact.identity, seed: entry.seed, variant: entry.variant,
      checks: [...artifact.checks, fail("world.boot", `Infrastructure prevented this world from starting: ${error.message}`)] });
  }
} finally {
  await Promise.all(temporalRuns.values());
  report.finished_at = new Date().toISOString();
  report.failed_checks = [...report.checks, ...report.cases.flatMap((entry) => entry.checks)].filter((check) => check.status === "failed").length;
  report.status = report.failed_checks ? "failed" : "passed";
  report.reader_gap_checks = summarizeReport(report).reader_gap_checks;
  save();
  console.log(`Coupling matrix ${report.status}: ${report.cases.length} worlds, ${report.failed_checks} failed checks. Report: ${join(reportDir, "report.json")}`);
  process.exitCode = report.failed_checks ? 1 : 0;
}
