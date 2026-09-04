import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

import { RELEASE_CHANNEL } from "../lib/provider-client.mjs";

const child = spawn(process.execPath, [join(import.meta.dirname, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
});

function rpc(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "renewal-copilot-demo", version: "1.0.0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

async function tool(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  if (response.isError) throw new Error(response.content[0].text);
  return response.structuredContent.value;
}

let run = null;
async function initialState() {
  const [listed, customer, mail, issue, slack] = await Promise.all([
    rpc("tools/list"), tool("get_customer", { query: "Lumen Labs" }), tool("read_mail", { query: "Lumen" }),
    tool("get_github_issue", { query: "Lumen" }), tool("search_slack", { query: "Lumen" }),
  ]);
  return { tools: listed.tools, customer, counts: { mail: mail.length, slack: slack.length, issues: issue ? 1 : 0 }, run };
}

async function runAgent() {
  const marker = `RENEWAL_COPILOT_${Date.now()}`;
  const steps = [];
  const invoke = async (name, args, text) => {
    const value = await tool(name, args);
    steps.push({ tool: name, text, evidence: value });
    return value;
  };
  const slack = await invoke("search_slack", { query: "Lumen" }, "Read the customer and team context from Slack.");
  const mail = await invoke("read_mail", { query: "Lumen" }, "Read the Lumen customer thread in Gmail.");
  const issue = await invoke("get_github_issue", { query: "Lumen" }, "Read the open export fault from GitHub.");
  const customer = await invoke("get_customer", { query: "Lumen Labs" }, "Read the customer identity from Stripe.");
  const brief = {
    marker, customer: customer.name,
    summary: `${issue.title}. ${mail[0]?.snippet ?? "No matching customer mail."}`,
    cautions: ["The open invoice is not proof of payment.", "The GitHub issue does not show team consensus."],
    evidence: { slack: slack.map((message) => message.ts), mail: mail.map((message) => message.id), issue: issue.html_url, customer: customer.id },
  };
  const object = await invoke("put_object", { bucket: "northstar-relay-documents", key: `renewal-copilot/${marker}.json`, body: brief }, "Store the evidence-backed draft in S3.");
  run = { marker, steps, brief, object, state: "approval", sent: false };
  return run;
}

async function approve() {
  if (!run || run.state !== "approval") throw new Error("No run is waiting for approval");
  const mail = await tool("send_mail", { to: "priya@lumen-labs.worldfixture.test", subject: "Lumen Labs renewal brief", text: `${run.brief.summary}\n\nEvidence: ${run.object.bucket}/${run.object.key}` });
  run.steps.push({ tool: "send_mail", text: "Gmail accepted the customer message after human approval.", evidence: mail });
  const slack = await tool("post_message", { channel: RELEASE_CHANNEL, text: `${run.marker}: Lumen renewal brief approved. ${run.object.bucket}/${run.object.key}` });
  run.steps.push({ tool: "post_message", text: "Slack accepted the internal summary.", evidence: slack });
  run.state = "complete";
  run.sent = true;
  return run;
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}
function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

const PUBLIC = join(import.meta.dirname, "public");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://example.local");
    if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, await initialState());
    if (request.method === "POST" && url.pathname === "/api/run") { await requestBody(request); return sendJson(response, 200, await runAgent()); }
    if (request.method === "POST" && url.pathname === "/api/approve") { await requestBody(request); return sendJson(response, 200, await approve()); }
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(PUBLIC, relative);
    if (request.method === "GET" && file.startsWith(PUBLIC) && existsSync(file)) {
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      return createReadStream(file).pipe(response);
    }
    sendJson(response, 404, { error: "not found" });
  } catch (error) { sendJson(response, 500, { error: error.message }); }
});

const port = Number(process.env.PORT ?? 4400);
server.once("error", (error) => { if (error.code !== "EADDRINUSE" || process.env.PORT) throw error; server.listen({ host: "127.0.0.1", port: 0 }); });
server.on("listening", () => console.log(`Renewal Copilot: http://127.0.0.1:${server.address().port}`));
server.listen({ host: "127.0.0.1", port });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { child.kill(signal); server.close(() => process.exit(0)); });
