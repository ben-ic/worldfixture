import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "runtime/bin/worldfixture.mjs");

function waitForLine(child, pattern, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`process did not print ${pattern}:\n${output}`)), timeoutMs);
    const read = (chunk) => {
      output += chunk;
      const match = output.match(pattern);
      if (match) { clearTimeout(timer); resolve(match); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => reject(new Error(`process exited ${code}:\n${output}`)));
  });
}

async function composerPids(containerId) {
  const { stdout } = await run("docker", ["top", containerId, "-eo", "pid,ppid,pgid,args"]);
  return stdout.split("\n").filter((line) => line.includes("node src/main.mjs"))
    .map((line) => line.trim().split(/\s+/)[0]);
}

test("MCP and protocol examples use a real one-container instance with fallback ports", { timeout: 360_000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), "worldfixture-examples-"));
  const busy = createServer((_request, response) => response.end("busy"));
  await new Promise((resolve) => busy.listen(8080, "127.0.0.1", resolve));
  let copilot;

  try {
    const up = await run(process.execPath, [BIN, "up", "--state", state], { cwd: ROOT, timeout: 300_000 });
    assert.match(up.stdout, /WorldFixture is ready/);
    const bindings = JSON.parse(readFileSync(join(state, "host-bindings.json"), "utf8"));
    const instance = JSON.parse(readFileSync(join(state, "instance.json"), "utf8"));
    const portFor = (surface) => instance.ports.find((entry) => entry.name === surface)?.hostPort;
    assert.equal(Number(new URL(bindings.WORKBENCH_URL).port), portFor("workbench"));
    assert.equal(Number(new URL(bindings.SLACK_BASE_URL).port), portFor("slack"));
    assert.equal(Number(new URL(bindings.GITHUB_BASE_URL).port), portFor("github"));
    assert.equal(Number(new URL(bindings.GOOGLE_BASE_URL).port), portFor("google"));
    const inspected = JSON.parse((await run("docker", ["inspect", instance.container_id, "--format", "{{json .Mounts}}"])).stdout);
    assert.equal(inspected.find((mount) => mount.Destination === "/state")?.Source, state);
    assert.notEqual(new URL(bindings.SITE_BASE_URL).port, "8080");
    assert.ok(bindings.WORKBENCH_URL);
    const workbenchHtml = await fetch(bindings.WORKBENCH_URL).then((response) => response.text());
    assert.match(workbenchHtml, /id="root"/);
    const workbenchScript = workbenchHtml.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert.ok(workbenchScript, "the production Workbench JavaScript bundle is present");
    const workbenchBundle = await fetch(new URL(workbenchScript, bindings.WORKBENCH_URL)).then((response) => response.text());
    assert.match(workbenchBundle, /What did I get\?/);
    assert.match(workbenchBundle, /Copy \.env/);
    assert.match(workbenchBundle, /This will remove all messages, issues, objects, mail, website progress, and observed events/);
    const workbench = await fetch(`${bindings.WORKBENCH_URL}/api/overview`).then((response) => response.json());
    assert.equal(workbench.world.id, "business.saas-company");
    assert.ok(workbench.world.description);
    assert.ok(workbench.organizations.length > 1);
    assert.ok(workbench.people[0].email);
    assert.ok(workbench.readiness.every((service) => service.state === "running"));
    assert.equal(workbench.bindings.SITE_BASE_URL, bindings.SITE_BASE_URL);
    assert.ok(workbench.providers.gmail.messages.length > 0);
    assert.ok(workbench.providers.mail.messages.length > 0);
    assert.ok(workbench.providers.gmail.inbox.messages.length > 0);
    assert.ok(workbench.providers.gmail.sent.messages.length > 0);
    assert.ok(workbench.providers.mail.inbox.messages.length > 0);
    assert.ok(workbench.providers.mail.sent.messages.length > 0);
    assert.ok(workbench.providers.mail.inbox.messages.every((message, index, messages) => index === 0 || messages[index - 1].seq > message.seq));
    const liveAbort = new AbortController();
    const live = await fetch(`${bindings.WORKBENCH_URL}/api/live`, { signal: liveAbort.signal });
    assert.match(live.headers.get("content-type"), /text\/event-stream/);
    const liveReader = live.body.getReader();
    const firstLiveEvent = new TextDecoder().decode((await liveReader.read()).value);
    assert.match(firstLiveEvent, /event: ready/);

    const maya = workbench.people.find((person) => person.id === "maya-chen");
    const release = workbench.providers.slack.channels.find((channel) => channel.name === "release-3-2");
    const repository = workbench.providers.github.repositories[0];
    const exportBucket = workbench.providers.s3.details.find((bucket) => bucket.name.includes("exports"));
    const workbenchAction = async (path, input) => {
      const response = await fetch(`${bindings.WORKBENCH_URL}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const slackAction = await workbenchAction("/api/actions/slack", { person_id: maya.id, channel: release.id, text: "Workbench release gate" });
    assert.match(slackAction.message, /delivered \d+ notification emails? through SMTP|No causal rule matched/);
    let liveText = "";
    for (let read = 0; read < 10 && !liveText.includes("event: provider-change"); read += 1) {
      liveText += new TextDecoder().decode((await liveReader.read()).value);
    }
    assert.match(liveText, /event: provider-change/);
    liveAbort.abort();
    await workbenchAction("/api/actions/github-issue", { person_id: maya.id, repository: repository.full_name,
      title: "Workbench release gate", text: "Created through the real GitHub API." });
    await workbenchAction("/api/actions/gmail", { person_id: maya.id, to: "jon@worldfixture.test",
      subject: "Workbench release gate", text: "Created through the real Gmail API." });
    await workbenchAction("/api/actions/mail", { person_id: maya.id, to: bindings.IMAP_USERNAME,
      subject: "Workbench SMTP gate", text: "Created through SMTP and visible through IMAP." });
    await workbenchAction("/api/actions/s3", { person_id: maya.id, bucket: exportBucket.name,
      key: "workbench/release-gate.txt", text: "Created through the real SeaweedFS S3 API." });
    const changedWorkbench = await fetch(`${bindings.WORKBENCH_URL}/api/overview`).then((response) => response.json());
    assert.ok(changedWorkbench.activity.length >= 4);
    assert.ok(changedWorkbench.providers.slack.messageCount > workbench.providers.slack.messageCount);
    assert.ok(changedWorkbench.providers.mail.sent.exists > workbench.providers.mail.sent.exists);

    copilot = spawn("npm", ["start"], {
      cwd: join(ROOT, "examples/mcp-server"),
      env: { ...process.env, WORLDFIXTURE_STATE: state },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const copilotUrl = (await waitForLine(copilot, /Renewal Copilot: (http:\/\/\S+)/))[1];
    const mcpState = await fetch(`${copilotUrl}/api/state`).then((response) => response.json());
    assert.equal(mcpState.tools.length, 7);
    assert.equal(mcpState.customer.name, "Lumen Labs");
    const agentRun = await fetch(`${copilotUrl}/api/run`, { method: "POST", body: "{}" }).then((response) => response.json());
    assert.equal(agentRun.state, "approval");
    assert.equal(agentRun.steps.at(-1).tool, "put_object");
    const approved = await fetch(`${copilotUrl}/api/approve`, { method: "POST", body: "{}" }).then((response) => response.json());
    assert.equal(approved.state, "complete");
    assert.equal(approved.steps.at(-1).tool, "post_message");

    const python = await run("python3", ["app.py"], {
      cwd: join(ROOT, "examples/protocol-app"),
      env: { ...process.env, WORLDFIXTURE_STATE: state },
      timeout: 60_000,
    });
    assert.match(python.stdout, /SMTP -> IMAP/);
    assert.match(python.stdout, /HTTP callback/);
    assert.match(python.stdout, /SeaweedFS S3/);

    // The host command executes in the recorded container. This creates a
    // runtime event without opening SQLite from the host filesystem.
    await run(process.execPath, [BIN, "slack", "send", "--as", "maya", "--channel", "release-3-2",
      "Automated example gate", "--state", state], { cwd: ROOT, timeout: 30_000 });
    const composerBeforeReset = await composerPids(instance.container_id);
    assert.equal(composerBeforeReset.length, 1);
    const reset = await fetch(`${bindings.WORKBENCH_URL}/api/reset`, { method: "POST", body: "{}" });
    assert.equal(reset.status, 200);
    const composerAfterReset = await composerPids(instance.container_id);
    assert.equal(composerAfterReset.length, 1);
    assert.notEqual(composerAfterReset[0], composerBeforeReset[0], "reset replaced the provider process");
    const restored = await fetch(`${bindings.WORKBENCH_URL}/api/overview`).then((response) => response.json());
    assert.equal(restored.providers.slack.messageCount, workbench.providers.slack.messageCount,
      "reset restored the starting Slack message count");
    assert.equal(restored.providers.mail.sent.exists, workbench.providers.mail.sent.exists,
      "reset restored the starting Local Mail sent count");
    const events = await run(process.execPath, [BIN, "events", "--state", state], { cwd: ROOT });
    assert.match(events.stdout, /No events yet/);

    await run(process.execPath, [BIN, "down", "--state", state], { cwd: ROOT, timeout: 30_000 });
    await assert.rejects(run("docker", ["inspect", instance.container_id]));
  } finally {
    if (copilot?.exitCode === null) copilot.kill("SIGTERM");
    await run(process.execPath, [BIN, "down", "--state", state], { cwd: ROOT }).catch(() => {});
    await new Promise((resolve) => busy.close(resolve));
    rmSync(state, { recursive: true, force: true });
  }
});
