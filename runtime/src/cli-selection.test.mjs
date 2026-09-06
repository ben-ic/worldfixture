import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse, paths, prepareContainerArgs, resolveUpSelection } from "./cli.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_URL = new URL("./cli.mjs", import.meta.url).href;
const WORLD = realpathSync(join(ROOT, "dist/business.saas-company.v2"));
function scratch(t) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "worldfixture-selection-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function cli(args, { cwd, hook = "" } = {}) {
  const script = `${hook}\nconst {main}=await import(${JSON.stringify(CLI_URL)}); await main(${JSON.stringify(args)});`;
  try {
    return { code: 0, stdout: execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: cwd ?? ROOT, encoding: "utf8", env: { ...process.env, WORLDFIXTURE_SINGLE_CONTAINER: "0" }, stdio: "pipe", timeout: 30000,
    }) };
  } catch (error) {
    if (error.stdout === undefined) throw error;
    return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

test("worlds reports verified identities in readable and JSON output", () => {
  const json = cli(["worlds", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const entries = JSON.parse(json.stdout);
  assert.ok(entries.length >= 3);
  const v2 = entries.find(entry => entry.id === "business.saas-company" && entry.version === "v2");
  assert.equal(v2.valid, true);
  assert.equal(v2.artifactPath, WORLD);
  assert.match(v2.digest, /^[a-f0-9]{64}$/);
  const text = cli(["worlds"]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /business.saas-company:v2\s+valid/);
  assert.match(text.stdout, /consumer.retail-brand:v1\s+valid/);
});

test('env and run read the generation after host inspection and reject a change during binding reads', t => {
  const root = scratch(t), state = join(root, 'state');
  mkdirSync(state);
  const save = (path, value) => writeFileSync(path, JSON.stringify(value));
  const generations = [WORLD, join(ROOT, 'dist/consumer.retail-brand.v1')].map((artifactPath, index) => {
    const manifest = JSON.parse(readFileSync(join(artifactPath, 'manifest.json')));
    const stateDir = join(state, String(index)); mkdirSync(stateDir);
    const world = { id: manifest.world_id, version: manifest.world_version, artifact_sha256: manifest.artifact_sha256 };
    save(join(stateDir, 'environment.lock.json'), { world, bindings: {
      SOURCE_WORLD_ID: { from: 'projection', profile: 'domain.collections.v1', service: 'domain', port: 'http', file: 'world.json', pointer: '/id' },
    } });
    save(join(stateDir, 'bindings.json'), { WORKBENCH_URL: `http://127.0.0.1:${8000 + index}`, WORLDFIXTURE_TOKEN: `test-generation-${index}` });
    save(join(stateDir, 'addresses.json'), { 'domain/http': { host: '127.0.0.1', port: 9000 + index } });
    save(join(stateDir, 'credentials.json'), { api_version: 'worldfixture.credentials/v1', world, values: {} });
    return { api_version: 'worldfixture.active-generation/v1', phase: 'ready', generation: String(index), artifactPath, stateDir, world };
  });
  const pointer = join(state, 'active-generation.json');
  for (const duringRead of [false, true]) {
    const hook = `
      import {registerHooks} from 'node:module';
      registerHooks({load(url, context, next) {
        if (url.endsWith('/host-launcher.mjs')) return {format:'module',shortCircuit:true,source:
          'export * from '+JSON.stringify(url+'?actual=1')+';'+
          'import {writeFileSync} from "node:fs";'+
          'export function hostInstance() { return {}; }'+
          'export function hostBindings() { return null; }'+
          'export function hostAddresses() { return null; }'+
          'export async function inspectHostInstance() { await Promise.resolve(); writeFileSync('+${JSON.stringify(JSON.stringify(pointer))}+', '+${JSON.stringify(JSON.stringify(JSON.stringify(generations[1])))}+'); return {}; }'
        };
        if (${duringRead} && url.endsWith('/bindings.mjs')) return {format:'module',shortCircuit:true,source:
          'export * from '+JSON.stringify(url+'?actual=1')+';'+
          'import {resolveBindings as actual} from '+JSON.stringify(url+'?actual=1')+';'+
          'import {writeFileSync} from "node:fs";'+
          'export function resolveBindings(...args) { const result=actual(...args); writeFileSync('+${JSON.stringify(JSON.stringify(pointer))}+', '+${JSON.stringify(JSON.stringify(JSON.stringify(generations[0])))}+'); return result; }'
        };
        return next(url, context);
      }});
    `;
    for (const args of [
      ['env', '--state', state, '--json'],
      ['run', '--state', state, '--', process.execPath, '-e', 'console.log(JSON.stringify({SOURCE_WORLD_ID:process.env.SOURCE_WORLD_ID,WORKBENCH_URL:process.env.WORKBENCH_URL,WORLDFIXTURE_TOKEN:process.env.WORLDFIXTURE_TOKEN}))'],
    ]) {
      save(pointer, generations[0]);
      const result = cli(args, { hook });
      if (duringRead) {
        assert.notEqual(result.code, 0);
        assert.match(result.stdout + result.stderr, /active world changed while reading bindings/);
        assert.doesNotMatch(result.stdout, /test-generation-/);
      } else {
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), { SOURCE_WORLD_ID: generations[1].world.id, WORKBENCH_URL: 'http://127.0.0.1:8001', WORLDFIXTURE_TOKEN: 'test-generation-1' });
      }
    }
  }
});

test("startup rejects unknown, ambiguous, repeated, conflicting and incomplete selectors without writes", t => {
  const root = scratch(t);
  for (const args of [
    ["unknown-world"], ["business.saas-company"], ["--world-path", join(root, "missing")],
    ["business.saas-company:v2", "consumer.retail-brand:v1"],
    ["business.saas-company:v2", "--world-path", WORLD],
    ["business.saas-company:v2", "--world", "business.saas-company:v2"],
    ["--world", "business.saas-company:v2", "--world-path", WORLD],
    ["--world-path", WORLD, "--world-path", WORLD],
    ["--world", "business.saas-company:v2", "--world", "business.saas-company:v2"],
    ["--world"], ["--world-path", "--no-rebase"],
  ]) {
    const project = join(root, "project");
    const state = join(root, "state");
    const result = cli(["up", "--app-dir", project, "--state", state, ...args], { cwd: root });
    assert.notEqual(result.code, 0, `${args}: ${result.stdout}`);
    assert.match(result.stdout, /failed:/);
    assert.equal(existsSync(project), false, `project/app env changed for ${args}`);
    assert.equal(existsSync(state), false, `state changed for ${args}`);
  }
  assert.deepEqual(readdirSync(root), []);
});

test("selection uses manifest identity for positional names, aliases and renamed paths", t => {
  const root = scratch(t);
  const renamed = join(root, "unrelated-folder");
  cpSync(WORLD, renamed, { recursive: true });
  for (const args of [["business.saas-company:v2"], ["business.saas-company.v2"], ["--world", "business.saas-company:v2"], [renamed], ["--world-path", renamed]]) {
    const selected = resolveUpSelection(parse(args));
    assert.equal(selected.id, "business.saas-company");
    assert.equal(selected.version, "v2");
    assert.equal(selected.artifactPath, args.includes(renamed) ? renamed : WORLD);
  }
});

test("project world and default precedence are explicit and invalid projects do not create tokens", t => {
  const root = scratch(t);
  const configDir = join(root, ".worldfixture");
  mkdirSync(configDir);
  const config = { api_version: "worldfixture.project/v1", application_url: "http://localhost:3000", services: [], world: "unknown-world" };
  writeFileSync(join(configDir, "project.json"), JSON.stringify(config));
  const before = readFileSync(join(configDir, "project.json"), "utf8");
  const failed = cli(["up", "--direct"], { cwd: root });
  assert.notEqual(failed.code, 0);
  assert.match(failed.stdout, /Unknown world selector/);
  assert.equal(readFileSync(join(configDir, "project.json"), "utf8"), before);
  assert.deepEqual(readdirSync(configDir), ["project.json"]);
  const chosen = resolveUpSelection(parse([]), { projectWorld: "business.saas-company:v2" });
  assert.equal(chosen.selectionSource, "projectWorld");
  assert.equal(chosen.version, "v2");
  assert.equal(resolveUpSelection(parse([])).selectionSource, "defaultWorld");
  assert.equal(resolveUpSelection(parse(["business.saas-company:v2"]), { projectWorld: "unknown" }).version, "v2");
});

test("state-only path reads do not require a valid selected or default artifact", t => {
  const root = scratch(t);
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".worldfixture"), { recursive: true });
  writeFileSync(join(projectDir, ".worldfixture/project.json"), "malformed project config");
  const located = paths({ "project-dir": projectDir, state: "state", "world-path": "missing" }, { cwd: root, packageRoot: join(root, "no-package") });
  assert.equal(located.stateDir, join(root, "state"));
  assert.equal(located.projectDir, projectDir);
  assert.equal(existsSync(located.stateDir), false);
});

test("relative project selection uses the project directory and explicit selection uses cwd", t => {
  const root = scratch(t);
  const projectDir = join(root, "project");
  cpSync(WORLD, join(projectDir, "built"), { recursive: true });
  const options = { projectWorld: "./built", projectDir, cwd: root };
  assert.equal(resolveUpSelection(parse([]), options).artifactPath, join(projectDir, "built"));
  assert.throws(() => resolveUpSelection(parse(["./built"]), options), /Invalid world artifact/);
  assert.equal(resolveUpSelection(parse(["./project/built"]), options).artifactPath, join(projectDir, "built"));
});

test("read paths prefer rebased and no-rebase session snapshots; explicit paths still win", t => {
  const root = scratch(t);
  const state = join(root, "state");
  cpSync(WORLD, join(state, "input-world"), { recursive: true });
  assert.equal(paths({ state }, { packageRoot: join(root, "no-package") }).artifactPath, join(state, "input-world"));
  cpSync(WORLD, join(state, "world"), { recursive: true });
  assert.equal(paths({ state }).artifactPath, join(state, "world"));
  assert.equal(paths({ state, "world-path": WORLD }).artifactPath, WORLD);
});

test("new-start staging forwards only/no-rebase and replaces a stale session after copying input", t => {
  const state = scratch(t);
  const old = join(state, "world");
  cpSync(WORLD, old, { recursive: true });
  const before = readFileSync(join(old, "manifest.json"));
  const args = prepareContainerArgs(old, state, { only: "site,slack", "no-rebase": true });
  assert.deepEqual(args, ["--world-path", "/state/input-world", "--only", "site,slack", "--no-rebase"]);
  assert.equal(existsSync(old), false);
  assert.deepEqual(readFileSync(join(state, "input-world/manifest.json")), before);
  assert.deepEqual(prepareContainerArgs(join(state, "input-world"), state), ["--world-path", "/state/input-world"]);
});

test("a changed artifact cannot replace the selected input or the previous session", t => {
  const root = scratch(t);
  const state = join(root, "state");
  const source = join(root, "build");
  cpSync(WORLD, source, { recursive: true });
  cpSync(WORLD, join(state, "input-world"), { recursive: true });
  cpSync(WORLD, join(state, "world"), { recursive: true });
  const selected = resolveUpSelection(parse([source]));
  const before = readFileSync(join(state, "input-world/manifest.json"));
  const body = readFileSync(join(source, "world.json"));
  body[0] = 32;
  writeFileSync(join(source, "world.json"), body);
  assert.throws(() => prepareContainerArgs(source, state, {}, selected), /artifact changed before startup/);
  assert.deepEqual(readFileSync(join(state, "input-world/manifest.json")), before);
  assert.deepEqual(readFileSync(join(state, "world/manifest.json")), before);
  assert.deepEqual(readdirSync(state).sort(), ["input-world", "world"]);
  rmSync(source, { recursive: true });
  cpSync(join(ROOT, "dist/consumer.retail-brand.v1"), source, { recursive: true });
  assert.throws(() => prepareContainerArgs(source, state, {}, selected), /copied identity or digest differs/);
  assert.deepEqual(readFileSync(join(state, "input-world/manifest.json")), before);
  assert.equal(existsSync(join(state, "world/world.json")), true);
});

test("starting from an artifact directory copies declared files without copying its project state", t => {
  const root = scratch(t);
  const artifact = join(root, "built");
  cpSync(WORLD, artifact, { recursive: true });
  const state = join(artifact, ".worldfixture/runs/local");
  mkdirSync(join(artifact, ".worldfixture"));
  writeFileSync(join(artifact, ".worldfixture/token"), "local-project-value");
  const selected = resolveUpSelection(parse([artifact]));
  assert.deepEqual(prepareContainerArgs(artifact, state, {}, selected), ["--world-path", "/state/input-world"]);
  const staged = join(state, "input-world");
  assert.equal(existsSync(join(staged, ".worldfixture")), false);
  assert.deepEqual(readFileSync(join(staged, "manifest.json")), readFileSync(join(artifact, "manifest.json")));
  assert.equal(resolveUpSelection(parse([staged])).digest, selected.digest);
});

test("host CLI supplies original tuple and defers staging until launcher callback", t => {
  const root = scratch(t);
  const record = join(root, "launch.json");
  const state = join(root, "state");
  const hook = `
    import {registerHooks} from 'node:module';
    registerHooks({load(url, context, next) {
      if (!url.endsWith('/host-launcher.mjs')) return next(url,context);
      return {format:'module',shortCircuit:true,source:
        'export * from '+JSON.stringify(url+'?actual=1')+';'+
        'import {writeFileSync,existsSync} from "node:fs";'+
        'export async function inspectHostInstance() { return null; }'+
        'export async function runInHostInstance(state,argv) { return {code:0,stdout:JSON.stringify({ok:true,mode:"running",clock:{running:true,elapsed_ms:0},timeline:{pending:8,in_flight:0,delivered:0,failed:0,skipped:0,next_due_ms:20000},repeat:{enabled:false}})}; }'+
        'export async function launchHostInstance(options) {'+
        'const before=existsSync(options.stateDir+"/input-world");'+
        'const args=await options.prepareContainerArgs();'+
        'writeFileSync('+JSON.stringify(${JSON.stringify(record)})+',JSON.stringify({before,args,requestedWorld:options.requestedWorld}));'+
        'return {reused:false,bindings:{WORLDFIXTURE_TOKEN:options.connectorToken}};}'
      };
    }});
  `;
  const result = cli(["up", "business.saas-company:v2", "--state", state, "--only", "site", "--no-rebase"], { cwd: root, hook });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const launch = JSON.parse(readFileSync(record));
  assert.equal(launch.before, false);
  assert.deepEqual(launch.args, ["--world-path", "/state/input-world", "--only", "site", "--no-rebase"]);
  const manifest = JSON.parse(readFileSync(join(WORLD, "manifest.json")));
  assert.deepEqual(launch.requestedWorld, { id: manifest.world_id, version: manifest.world_version, digest: manifest.artifact_sha256 });
  assert.match(result.stdout, /Selected world: business.saas-company:v2 \(selector\)/);
});

test("a different running world is refused before project or application environment writes", t => {
  const root = scratch(t);
  const project = join(root, "project");
  const app = join(root, "app");
  const state = join(root, "state");
  const configPath = join(project, ".worldfixture/project.json");
  const tokenPath = join(project, ".worldfixture/token");
  const envPath = join(app, ".env.local");
  const launched = join(root, "launch-called");
  mkdirSync(join(project, ".worldfixture"), { recursive: true });
  mkdirSync(app);
  mkdirSync(state);
  writeFileSync(configPath, JSON.stringify({ api_version: "worldfixture.project/v1", application_url: "http://localhost:3000", services: [] }, null, 2));
  writeFileSync(tokenPath, "wf_local_1234567890abcdef\n");
  writeFileSync(envPath, "EXISTING_SETTING=keep\nWORLDFIXTURE_TOKEN=existing-app-value\n");
  writeFileSync(join(state, "keep"), "existing state\n");
  const before = [configPath, tokenPath, envPath, join(state, "keep")].map(path => readFileSync(path));
  const running = { api_version: "worldfixture.host-instance/v1", requested_world: { id: "consumer.retail-brand", version: "v1", digest: "a".repeat(64) } };
  const hook = `
    import {registerHooks} from 'node:module';
    registerHooks({load(url, context, next) {
      if (!url.endsWith('/host-launcher.mjs')) return next(url,context);
      return {format:'module',shortCircuit:true,source:
        'export * from '+JSON.stringify(url+'?actual=1')+';'+
        'import {writeFileSync} from "node:fs";'+
        'export async function inspectHostInstance() { return '+${JSON.stringify(JSON.stringify(running))}+'; }'+
        'export async function launchHostInstance() { writeFileSync('+JSON.stringify(${JSON.stringify(launched)})+',"called"); throw new Error("launch must not run"); }'
      };
    }});
  `;
  const result = cli(["up", "business.saas-company:v2", "--project-dir", project, "--app-dir", app,
    "--state", state, "--application-url", "http://localhost:9000"], { cwd: root, hook });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /running instance was started from consumer.retail-brand@v1/);
  assert.match(result.stdout, /requested world is business.saas-company@v2/);
  assert.equal(existsSync(launched), false);
  assert.deepEqual([configPath, tokenPath, envPath, join(state, "keep")].map(path => readFileSync(path)), before);
  assert.deepEqual(readdirSync(project), [".worldfixture"]);
  assert.deepEqual(readdirSync(join(project, ".worldfixture")).sort(), ["project.json", "token"]);
  assert.deepEqual(readdirSync(app), [".env.local"]);
  assert.deepEqual(readdirSync(state), ["keep"]);
});

test("status and env report a missing run without reading malformed project or artifact data", t => {
  const root = scratch(t);
  mkdirSync(join(root, ".worldfixture"));
  writeFileSync(join(root, ".worldfixture/project.json"), "invalid project JSON");
  const hook = `
    import {registerHooks} from 'node:module';
    registerHooks({load(url, context, next) {
      if (!url.endsWith('/host-launcher.mjs')) return next(url,context);
      return {format:'module',shortCircuit:true,source:
        'export * from '+JSON.stringify(url+'?actual=1')+';'+
        'export async function inspectHostInstance() { return null; }'
      };
    }});
  `;
  for (const command of ["status", "env"]) {
    const result = cli([command, "--state", join(root, "missing-state")], { cwd: root, hook });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /No instance is running/);
    assert.doesNotMatch(result.stderr ?? "", /SyntaxError|invalid project JSON/);
  }
  assert.deepEqual(readdirSync(root), [".worldfixture"]);
});
