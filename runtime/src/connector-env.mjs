import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const KEY = "WORLDFIXTURE_TOKEN";

function localEnvName(value) {
  const name = value ?? ".env.local";
  if (basename(name) !== name || !/^\.env(?:\.[A-Za-z0-9_-]+)*\.local$/.test(name)) {
    throw new Error("the connector environment file must be .env.local or another .env.*.local file");
  }
  return name;
}

function tokenIn(contents) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?WORLDFIXTURE_TOKEN\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[1].replace(/^(['"])(.*)\1$/, "$2").trim();
    if (value) return value;
  }
  return null;
}

function withToken(contents, token) {
  const lines = contents ? contents.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  const result = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*(?:export\s+)?WORLDFIXTURE_TOKEN\s*=/.test(line)) {
      if (!replaced) result.push(`${KEY}=${token}`);
      replaced = true;
    } else {
      result.push(line);
    }
  }
  if (!replaced) {
    if (result.length > 0 && result.at(-1) !== "") result.push("");
    result.push("# Local WorldFixture application connector");
    result.push(`${KEY}=${token}`);
  }
  return `${result.join("\n")}\n`;
}

function ensureIgnored(appDir, name, ignoreName) {
  const ignorePath = join(appDir, ignoreName);
  const entry = `/${name}`;
  const contents = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (contents.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const prefix = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  writeFileSync(ignorePath, `${contents}${prefix}\n# WorldFixture local connector secret\n${entry}\n`);
}

export function readConnectorEnvironment(appDirectory, { fileName } = {}) {
  const appDir = resolve(appDirectory);
  const name = localEnvName(fileName);
  const envPath = join(appDir, name);
  const contents = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  return { appDir, envPath, fileName: name, token: tokenIn(contents) };
}

export function writeConnectorEnvironment(appDirectory, { fileName, token } = {}) {
  const current = readConnectorEnvironment(appDirectory, { fileName });
  if (!statSync(current.appDir).isDirectory()) throw new Error(`${current.appDir} is not a directory`);
  const value = token ?? current.token ?? `wf_local_${randomUUID().replaceAll("-", "")}`;
  const contents = existsSync(current.envPath) ? readFileSync(current.envPath, "utf8") : "";
  const temporary = `${current.envPath}.worldfixture-${process.pid}`;
  writeFileSync(temporary, withToken(contents, value), { mode: 0o600 });
  renameSync(temporary, current.envPath);
  chmodSync(current.envPath, 0o600);
  ensureIgnored(current.appDir, current.fileName, ".gitignore");
  ensureIgnored(current.appDir, current.fileName, ".dockerignore");
  return { ...current, token: value, created: !current.token };
}
