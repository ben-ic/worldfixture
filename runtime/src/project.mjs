import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertValid } from "./schema.mjs";
import { GENERATED_SECRETS_FILE, ensureGeneratedSecretStore } from "./generated-secrets.mjs";

export const PROJECT_VERSION = "worldfixture.project/v1";
export const PROJECT_DIRECTORY = ".worldfixture";
export const PROJECT_FILE = "project.json";
export const TOKEN_FILE = "token";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function projectSchema() {
  return JSON.parse(readFileSync(join(ROOT, "schemas/project.v1.schema.json"), "utf8"));
}

function projectPaths(projectDirectory) {
  const projectDir = resolve(projectDirectory);
  const worldfixtureDir = join(projectDir, PROJECT_DIRECTORY);
  return {
    projectDir,
    worldfixtureDir,
    configPath: join(worldfixtureDir, PROJECT_FILE),
    tokenPath: join(worldfixtureDir, TOKEN_FILE),
    generatedSecretsPath: join(worldfixtureDir, GENERATED_SECRETS_FILE),
    stateDir: join(worldfixtureDir, "runs/local"),
    ignorePath: join(worldfixtureDir, ".gitignore"),
  };
}

function writeIgnoreFile(path) {
  const required = ["*", "!.gitignore", `!${PROJECT_FILE}`];
  const current = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const missing = required.filter((line) => !current.includes(line));
  if (missing.length === 0) return;
  const prefix = current.some(Boolean) ? `${current.join("\n").replace(/\n+$/, "")}\n` : "";
  writeFileSync(path, `${prefix}${missing.join("\n")}\n`);
}

function ensureDockerIgnored(projectDir) {
  const path = join(projectDir, ".dockerignore");
  const entries = ["/.worldfixture/token", `/.worldfixture/${GENERATED_SECRETS_FILE}`];
  const contents = existsSync(path) ? readFileSync(path, "utf8") : "";
  const current = contents.split(/\r?\n/);
  const missing = entries.filter((entry) => !current.includes(entry));
  if (missing.length === 0) return;
  const prefix = contents && !contents.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${contents}${prefix}\n# WorldFixture local secrets\n${missing.join("\n")}\n`);
}

export function readProject(projectDirectory = process.cwd()) {
  const paths = projectPaths(projectDirectory);
  if (!existsSync(paths.configPath)) return null;
  const config = JSON.parse(readFileSync(paths.configPath, "utf8"));
  assertValid(config, projectSchema(), "WorldFixture project");
  return { ...paths, config };
}

export function readProjectToken(projectDirectory = process.cwd()) {
  const { tokenPath } = projectPaths(projectDirectory);
  if (!existsSync(tokenPath)) return null;
  const token = readFileSync(tokenPath, "utf8").trim();
  return token || null;
}

export function ensureProject(projectDirectory = process.cwd(), { token, applicationUrl } = {}) {
  const paths = projectPaths(projectDirectory);
  mkdirSync(paths.worldfixtureDir, { recursive: true, mode: 0o700 });
  writeIgnoreFile(paths.ignorePath);
  ensureDockerIgnored(paths.projectDir);
  ensureGeneratedSecretStore(paths.generatedSecretsPath);

  let created = false;
  if (!existsSync(paths.configPath)) {
    const config = {
      api_version: PROJECT_VERSION,
      application_url: applicationUrl ?? "http://localhost:3000",
      services: [],
    };
    assertValid(config, projectSchema(), "WorldFixture project");
    writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
    created = true;
  } else if (applicationUrl) {
    const config = readProject(paths.projectDir).config;
    const updated = { ...config, application_url: applicationUrl };
    assertValid(updated, projectSchema(), "WorldFixture project");
    writeFileSync(paths.configPath, `${JSON.stringify(updated, null, 2)}\n`);
  }

  const currentToken = readProjectToken(paths.projectDir);
  const connectorToken = token ?? currentToken ?? `wf_local_${randomUUID().replaceAll("-", "")}`;
  if (connectorToken !== currentToken) writeFileSync(paths.tokenPath, `${connectorToken}\n`, { mode: 0o600 });
  chmodSync(paths.tokenPath, 0o600);

  return { ...readProject(paths.projectDir), token: connectorToken, created };
}

export function connectorTarget(config, { inContainer = false } = {}) {
  const display = new URL(config.application_url);
  const transport = new URL(display);
  if (inContainer && ["localhost", "127.0.0.1", "::1"].includes(transport.hostname)) {
    transport.hostname = "host.docker.internal";
  }
  return {
    url: display.toString().replace(/\/$/, ""),
    transport_url: transport.toString().replace(/\/$/, ""),
  };
}
