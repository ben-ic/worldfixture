import { createInterface } from "node:readline";
import { loadBindings } from "../lib/bindings.mjs";
import {
  allSlackMessages, githubIssues, gmailMessageDetails, postSlack, putS3Object, sendGmail, stripeCustomers,
} from "../lib/provider-client.mjs";

const bindings = loadBindings();
const definitions = [
  ["search_slack", "Search Slack channel messages", { query: { type: "string" } }],
  ["read_mail", "Read Gmail message metadata and snippets", { query: { type: "string" } }],
  ["get_github_issue", "Read a matching GitHub issue", { query: { type: "string" } }],
  ["get_customer", "Read a Stripe customer", { query: { type: "string" } }],
  ["put_object", "Write a brief through the S3 protocol", { bucket: { type: "string" }, key: { type: "string" }, body: { type: "object" } }],
  ["send_mail", "Send a message through the Gmail API", { to: { type: "string" }, subject: { type: "string" }, text: { type: "string" } }],
  ["post_message", "Post a Slack message", { channel: { type: "string" }, text: { type: "string" } }],
];

const tools = definitions.map(([name, description, properties]) => ({
  name, description, inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
}));

const includes = (value, query) => JSON.stringify(value).toLowerCase().includes(String(query).toLowerCase());
async function callTool(name, input) {
  if (name === "search_slack") return (await allSlackMessages(bindings)).filter((message) => includes(message, input.query));
  if (name === "read_mail") return (await gmailMessageDetails(bindings)).filter((message) => includes(message, input.query)).map((message) => ({
    id: message.id, snippet: message.snippet, headers: message.payload?.headers,
  }));
  if (name === "get_github_issue") return (await githubIssues(bindings)).find((issue) => includes(issue, input.query)) ?? null;
  if (name === "get_customer") return (await stripeCustomers(bindings)).find((customer) => includes(customer, input.query)) ?? null;
  if (name === "put_object") return await putS3Object(bindings, input.bucket, input.key, input.body);
  if (name === "send_mail") return await sendGmail(bindings, input);
  if (name === "post_message") return await postSlack(bindings, input.text, input.channel);
  throw new Error(`Unknown tool: ${name}`);
}

function result(id, value) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
}

async function handle(message) {
  if (message.method === "initialize") return result(message.id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "renewal-copilot", version: "1.0.0" },
  });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") return result(message.id, { tools });
  if (message.method === "tools/call") {
    try {
      const value = await callTool(message.params.name, message.params.arguments ?? {});
      return result(message.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: { value } });
    } catch (error) {
      return result(message.id, { content: [{ type: "text", text: error.message }], isError: true });
    }
  }
  if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  try { await handle(JSON.parse(line)); }
  catch (error) { process.stderr.write(`${error.stack ?? error.message}\n`); }
}
