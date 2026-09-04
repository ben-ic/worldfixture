#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { serializeMcpToolsCapture } from "../src/mcp-capture.mjs";

function argumentsFor(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    if (!flag?.startsWith("--") || values[index + 1] === undefined) throw new Error(`invalid argument: ${flag ?? "missing value"}`);
    result[flag.slice(2).replaceAll("-", "_")] = values[index + 1];
  }
  return result;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (!options.input) throw new Error("--input is required");
  const source = options.input === "-" ? readFileSync(0, "utf8") : readFileSync(options.input, "utf8");
  const response = JSON.parse(source);
  const normalized = serializeMcpToolsCapture(response, options);
  if (options.output) writeFileSync(options.output, normalized);
  else process.stdout.write(normalized);
} catch (error) {
  process.stderr.write(`normalize-mcp-tools: ${error.message}\n`);
  process.exitCode = 64;
}
