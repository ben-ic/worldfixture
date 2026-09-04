#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

function argumentsFor(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!flag?.startsWith("--") || values[index + 1] === undefined) throw new Error(`invalid argument: ${flag ?? "missing value"}`);
    result[flag.slice(2).replaceAll("-", "_")] = values[index + 1];
  }
  return result;
}

const options = argumentsFor(process.argv.slice(2));
if (!options.server || !options.output) throw new Error("--server and --output are required");
if (!/^https:\/\//.test(options.server)) throw new Error("--server must use https");

const proxy = spawn("npx", [
  "-y", "-p", "mcp-remote@0.1.38", "mcp-remote", options.server,
  "--transport", "http-only", "--silent",
], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
let completed = false;
const send = (message) => proxy.stdin.write(`${JSON.stringify(message)}\n`);
const finish = (error, response) => {
  if (completed) return;
  completed = true;
  clearTimeout(timer);
  if (response) {
    if (!Array.isArray(response.result?.tools)) error = new Error("tools/list did not return a tools array");
    else {
      writeFileSync(options.output, `${JSON.stringify(response)}\n`, { mode: 0o600 });
      process.stdout.write(`captured ${response.result.tools.length} tools in ${options.output}\n`);
    }
  }
  proxy.kill("SIGTERM");
  if (error) {
    process.stderr.write(`capture-remote-mcp-tools: ${error.message}\n`);
    process.exitCode = 1;
  }
};

proxy.stdout.setEncoding("utf8");
proxy.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const boundary = buffer.indexOf("\n");
    const line = buffer.slice(0, boundary).trim();
    buffer = buffer.slice(boundary + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { return finish(new Error("the MCP proxy wrote a non-JSON protocol line")); }
    if (message.id === 1) {
      if (message.error) return finish(new Error(`initialize failed: ${message.error.message ?? message.error.code}`));
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    } else if (message.id === 2) {
      if (message.error) return finish(new Error(`tools/list failed: ${message.error.message ?? message.error.code}`));
      finish(null, message);
    }
  }
});
proxy.once("error", (error) => finish(error));
proxy.once("exit", (code) => {
  if (!completed) finish(new Error(`MCP proxy exited before tools/list with code ${code}`));
});

const timer = setTimeout(() => finish(new Error("tools/list timed out after 120 seconds")), 120_000);
timer.unref();
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: options.protocol_version ?? "2025-11-25",
    capabilities: {},
    clientInfo: { name: "worldfixture-capture", version: "1" },
  },
});
