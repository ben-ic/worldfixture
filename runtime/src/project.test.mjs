import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { connectorTarget, ensureProject, readProject, readProjectToken } from "./project.mjs";

test("up can create a project-local config, ignored state, and stable token", () => {
  const directory = mkdtempSync(join(tmpdir(), "worldfixture-project-"));
  writeFileSync(join(directory, ".dockerignore"), "node_modules\n");
  const first = ensureProject(directory);
  const second = ensureProject(directory);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(readProject(directory).config.application_url, "http://localhost:3000");
  assert.equal(readProjectToken(directory), first.token);
  assert.equal(second.token, first.token);
  assert.equal(statSync(join(directory, ".worldfixture/token")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(directory, ".worldfixture/.gitignore"), "utf8"), /^\*$/m);
  assert.match(readFileSync(join(directory, ".worldfixture/.gitignore"), "utf8"), /^!project\.json$/m);
  assert.match(readFileSync(join(directory, ".dockerignore"), "utf8"), /^\/\.worldfixture\/token$/m);
});

test("a container Workbench uses the host transport address", () => {
  const config = { application_url: "http://localhost:3000" };
  assert.deepEqual(connectorTarget(config), {
    url: "http://localhost:3000",
    transport_url: "http://localhost:3000",
  });
  assert.deepEqual(connectorTarget(config, { inContainer: true }), {
    url: "http://localhost:3000",
    transport_url: "http://host.docker.internal:3000",
  });
});

test("up can set and later change the local application URL", () => {
  const directory = mkdtempSync(join(tmpdir(), "worldfixture-project-url-"));

  ensureProject(directory, { applicationUrl: "http://localhost:5175" });
  assert.equal(readProject(directory).config.application_url, "http://localhost:5175");

  ensureProject(directory, { applicationUrl: "http://127.0.0.1:8787" });
  assert.equal(readProject(directory).config.application_url, "http://127.0.0.1:8787");
  assert.throws(
    () => ensureProject(directory, { applicationUrl: "not-a-url" }),
    /WorldFixture project/,
  );
});

test("Git can track project config but ignores tokens and run data", () => {
  const directory = mkdtempSync(join(tmpdir(), "worldfixture-project-git-"));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });

  ensureProject(directory);
  mkdirSync(join(directory, ".worldfixture/runs"), { recursive: true });
  writeFileSync(join(directory, ".worldfixture/runs/latest.json"), "{}\n");

  const ignored = execFileSync("git", [
    "check-ignore",
    ".worldfixture/token",
    ".worldfixture/runs/latest.json",
  ], { cwd: directory, encoding: "utf8" }).trim().split("\n");
  const visible = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: directory,
    encoding: "utf8",
  });

  assert.deepEqual(ignored, [".worldfixture/token", ".worldfixture/runs/latest.json"]);
  assert.match(visible, /\.worldfixture\/project\.json/);
  assert.doesNotMatch(visible, /\.worldfixture\/token/);
  assert.doesNotMatch(visible, /\.worldfixture\/runs/);
});

test("a project can request the MySQL-compatible service", () => {
  const directory = mkdtempSync(join(tmpdir(), "worldfixture-project-mysql-"));
  ensureProject(directory);
  const configPath = join(directory, ".worldfixture/project.json");
  const config = readProject(directory).config;
  writeFileSync(configPath, `${JSON.stringify({ ...config, services: ["mysql"] }, null, 2)}\n`);

  assert.deepEqual(readProject(directory).config.services, ["mysql"]);
});
