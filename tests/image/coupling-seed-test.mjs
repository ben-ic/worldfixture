// Source-backed mail, Linear, and finance reads before and after normal reset.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverArtifacts, loadArtifact, snapshotArtifact } from "./coupling-artifacts.mjs";
import { probeFinanceWorld } from "./coupling-finance-probes.mjs";
import { probeGoogleWorld } from "./coupling-google-probes.mjs";
import { probeLinearWorld } from "./coupling-probes.mjs";
import { probeDomainWorld } from "./coupling-domain-probes.mjs";
import { containerArguments, docker, mappedBindings, pauseRunClock, readRunBindings, readRunCredentialSet,
  redact, removeOwnedContainer, responseInventory, waitForReady } from "./coupling-runner.mjs";

const { values } = parseArgs({ options: { image: { type: "string" }, report: { type: "string" },
  dist: { type: "string", default: resolve("dist") } } });
if (!values.image || !values.report) throw new Error("Use --image IMAGE --report DIRECTORY");
const root = resolve(values.report);
mkdirSync(root, { recursive: true });
if (existsSync(join(root, "report.json"))) throw new Error("Refusing to overwrite an existing report");
const [image] = JSON.parse((await docker(["image", "inspect", values.image])).stdout);
const secrets = [];
const report = { scope: "Source mail, Linear tasks, finance transactions, complete domain records, and normal reset. Every failed check fails this run.",
  image: { tag: values.image, id: image.Id }, started: new Date().toISOString(), worlds: [] };
const save = () => writeFileSync(join(root, "report.json"), `${JSON.stringify(redact(report, secrets), null, 2)}\n`, { mode: 0o600 });
const inputs = [];
mkdirSync(join(root, "inputs"));
for (const path of discoverArtifacts(resolve(values.dist))) {
  const original = loadArtifact(path);
  const label = `${original.identity.id}.${original.identity.version}`;
  const pathIn = join(root, "inputs", label);
  snapshotArtifact(path, pathIn);
  inputs.push({ path: pathIn, label, identity: original.identity });
}
save();
for (const input of inputs) {
  const owner = randomUUID(), name = `wf-seed-${owner}`;
  const result = { label: input.label, identity: input.identity, checks: [], responses: [] };
  report.worlds.push(result);
  const check = (name, expected, actual) => {
    try { assert.deepEqual(actual, expected); result.checks.push({ check: name, status: "passed" }); }
    catch { result.checks.push({ check: name, status: "failed", expected, actual }); }
  };
  let bindings, credentials;
  try {
    const artifact = loadArtifact(input.path);
    assert.deepEqual(artifact.identity, input.identity);
    assert.ok(artifact.checks.every(row => row.status === "passed"));
    await docker([...containerArguments({ image: image.Id, artifactPath: input.path, name, owner,
      exposedPorts: Object.keys(image.Config.ExposedPorts ?? {}) }), "--only", "providers,domain"]);
    await waitForReady(name);
    await pauseRunClock(name);
    const [inspection] = JSON.parse((await docker(["inspect", name])).stdout);
    check("immutable-image", image.Id, inspection.Config.Image);
    const lock = JSON.parse((await docker(["exec", name, "cat", "/state/environment.lock.json"])).stdout);
    check("active-world", input.identity, { id: lock.world.id, version: lock.world.version, digest: lock.world.artifact_sha256 });
    const refresh = async () => {
      credentials = await readRunCredentialSet(name);
      secrets.push(...Object.values(credentials.values));
      bindings = mappedBindings(await readRunBindings(name), inspection.NetworkSettings.Ports);
    };
    await refresh();
    const request = async (provider, path, init = {}) => {
      const response = await fetch(`${bindings[`${provider.toUpperCase()}_BASE_URL`]}${path}`, {
        ...init, signal: AbortSignal.timeout(30000), headers: {
          authorization: `Bearer ${bindings[`${provider.toUpperCase()}_TOKEN`]}`, ...init.headers,
        },
      });
      const raw = await response.text();
      let body; try { body = JSON.parse(raw); } catch { body = raw; }
      result.responses.push({ provider, path, status: response.status, body });
      return { status: response.status, body };
    };
    const query = async (query, variables = {}) => {
      const response = await request("linear", "/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
      assert.equal(response.status, 200);
      assert.ok(!response.body.errors?.length, JSON.stringify(response.body.errors));
      return response.body.data;
    };
    const read = async phase => {
      const domain = await probeDomainWorld({ artifact, bindings });
      result.checks.push(...domain.checks.map(row => ({ ...row, check: `${phase}.${row.check}` })));
      result.responses.push(...domain.responses);
      const readers = [
        () => probeGoogleWorld({ artifact, bindings, credentials }),
        () => probeFinanceWorld({ artifact, bindings, domainCoverage: domain.coverage }),
        () => probeLinearWorld({ artifact, bindings }),
      ];
      for (const reader of readers) {
        const proof = await reader();
        result.checks.push(...proof.checks.map(row => ({ ...row, check: `${phase}.${row.check}` })));
        result.responses.push(...proof.responses);
      }
      save();
    };
    await read("before");
    const receipts = {};
    for (const provider of ["google", "linear"]) {
      const response = await request(provider, "/_worldfixture/seed-receipt");
      assert.equal(response.status, 200);
      receipts[provider] = response.body;
    }
    const primary = artifact.world.people.find(row => row.primary);
    const marker = `reset-${owner}`;
    const message = await request("google", "/gmail/v1/users/me/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: primary.email, to: primary.email, subject: marker, body: "Manual reset check", labelIds: ["INBOX"] }),
    });
    assert.equal(message.status, 200);
    assert.ok(message.body.id);
    const teams = await query("{teams{nodes{id}}}");
    const task = await query("mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id}}}", {
      input: { title: marker, teamId: teams.teams.nodes[0].id },
    });
    assert.equal(task.issueCreate.success, true);
    const payment = artifact.world.finance.resolved.payments[0];
    const paymentId = `pi_${payment.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const refund = await request("stripe", "/v1/refunds", { method: "POST", body: new URLSearchParams({ payment_intent: paymentId, amount: "1" }) });
    assert.equal(refund.status, 200);
    assert.ok(refund.body.id);
    check("manual-api-writes", [true, true, true], [!!message.body.id, !!task.issueCreate.issue.id, !!refund.body.id]);
    await docker(["exec", name, "node", "runtime/bin/worldfixture.mjs", "reset", "--state", "/state"], { timeout: 120000 });
    await waitForReady(name);
    await pauseRunClock(name);
    await refresh();
    for (const provider of ["google", "linear"]) check(`reset.${provider}.receipt`, receipts[provider], (await request(provider, "/_worldfixture/seed-receipt")).body);
    check("reset.manual-mail-removed", 404, (await request("google", `/gmail/v1/users/me/messages/${message.body.id}`)).status);
    check("reset.manual-refund-removed", 404, (await request("stripe", `/v1/refunds/${refund.body.id}`)).status);
    const afterTask = await request("linear", "/graphql", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query($id:String!){issue(id:$id){id}}", variables: { id: task.issueCreate.issue.id } }) });
    check("reset.manual-task-removed", null, afterTask.body.data?.issue ?? null);
    await read("after");
  } catch (error) {
    result.checks.push({ check: "live-seed-lifecycle", status: "failed", detail: error.stack ?? error.message });
    try { result.logs = (await docker(["logs", name])).stdout; } catch { /* startup may have failed */ }
  } finally {
    try { await removeOwnedContainer(name, owner); }
    catch (error) { result.checks.push({ check: "cleanup", status: "failed", detail: error.message }); }
    result.response_inventory = responseInventory(redact(result.responses, secrets));
    save();
  }
}
const checks = report.worlds.flatMap(world => world.checks);
const failed = checks.filter(check => check.status === "failed");
report.summary = { checks: checks.length, failed: failed.length };
report.finished = new Date().toISOString();
save();
console.log(JSON.stringify(report.summary));
process.exitCode = report.summary.failed ? 1 : 0;
