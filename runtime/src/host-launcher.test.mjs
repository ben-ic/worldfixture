import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  HostLauncherError,
  hostContainerName,
  launchHostInstance,
  runInHostInstance,
  selectHostPorts,
  stopHostInstance,
  translateBindings,
} from "./host-launcher.mjs";

function inspection(stateDir, overrides = {}) {
  return {
    Id: "abc123worldfixture",
    Name: `/${hostContainerName(stateDir)}`,
    Image: "sha256:image",
    State: { Running: true },
    Config: {
      Image: "sha256:image",
      Labels: {
        "org.worldfixture.instance": "local",
        "org.opencontainers.image.title": "WorldFixture",
      },
    },
    Mounts: [{ Type: "bind", Source: stateDir, Destination: "/state", RW: true }],
    ...overrides,
  };
}

function missing() {
  return Object.assign(new Error("No such object"), { stderr: "Error: No such object" });
}

test("a busy preferred host port gets a free fallback", async () => {
  const busy = createServer();
  await new Promise((resolve) => busy.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const preferredPort = busy.address().port;

  try {
    const selected = await selectHostPorts([{ name: "test", containerPort: 4703, preferredPort }]);
    assert.equal(selected.length, 1);
    assert.notEqual(selected[0].hostPort, preferredPort);
    assert.equal(selected[0].containerPort, 4703);
    await selected[0].release();
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});

test("host bindings translate HTTP, host-port, and database URLs", () => {
  const ports = new Map([
    [61006, { hostPort: 62006 }],
    [2525, { hostPort: 32525 }],
    [5432, { hostPort: 35432 }],
    [3306, { hostPort: 33306 }],
  ]);
  assert.deepEqual(translateBindings({
    S3_BASE_URL: "http://127.0.0.1:61006",
    SMTP_HOST_PORT: "127.0.0.1:2525",
    POSTGRES_URL: "postgresql://worldfixture:secret@127.0.0.1:5432/postgres",
    MYSQL_URL: "mysql://worldfixture:secret@127.0.0.1:3306/worldfixture",
  }, ports), {
    S3_BASE_URL: "http://127.0.0.1:62006",
    SMTP_HOST_PORT: "127.0.0.1:32525",
    POSTGRES_URL: "postgresql://worldfixture:secret@127.0.0.1:35432/postgres",
    MYSQL_URL: "mysql://worldfixture:secret@127.0.0.1:33306/worldfixture",
  });
});

test("down finds and stops a verified container when the host record is missing", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-orphan-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const calls = [];
  let stopped = false;
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "stop") {
      stopped = true;
      return { stdout: "abc123worldfixture\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      if (stopped) throw missing();
      return { stdout: `${JSON.stringify(inspection(stateDir))}\n`, stderr: "" };
    }
    throw new Error(`unexpected docker call: ${args.join(" ")}`);
  };

  assert.equal(await stopHostInstance(stateDir, { runner }), true);
  assert.deepEqual(calls[0], ["docker", "inspect", hostContainerName(stateDir), "--format", "{{json .}}"]);
  assert.deepEqual(calls[1], ["docker", "stop", "--time", "15", "abc123worldfixture"]);
});

test("up refuses a verified unrecorded container before selecting ports", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-orphan-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const runner = async () => ({ stdout: `${JSON.stringify(inspection(stateDir))}\n`, stderr: "" });
  let selected = false;

  await assert.rejects(
    launchHostInstance({
      stateDir,
      runner,
      selectPorts: async () => {
        selected = true;
        return [];
      },
    }),
    (error) => error instanceof HostLauncherError &&
      error.code === "host_container_unrecorded" &&
      /worldfixture down/.test(error.repair),
  );
  assert.equal(selected, false);
});

test("down does not stop a same-name container with another state mount", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-orphan-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let stopped = false;
  const runner = async (_command, args) => {
    if (args[0] === "stop") stopped = true;
    return {
      stdout: `${JSON.stringify(inspection(stateDir, {
        Mounts: [{ Type: "bind", Source: "/tmp/somewhere-else", Destination: "/state", RW: true }],
      }))}\n`,
      stderr: "",
    };
  };

  await assert.rejects(
    stopHostInstance(stateDir, { runner }),
    (error) => error instanceof HostLauncherError && error.code === "host_container_conflict",
  );
  assert.equal(stopped, false);
});

test("down reports no instance when no record or deterministic container exists", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-orphan-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  assert.equal(await stopHostInstance(stateDir, { runner: async () => { throw missing(); } }), false);
});

// The bug this closes: the local secret was passed as `--env NAME=value`, which
// puts it in argv. argv is readable by every user on the machine through `ps`,
// and `execFile` copies the whole command line into the Error it throws -- so
// any `docker run` failure printed the token in cleartext into the terminal and
// into CI logs, which `security.md` promises never happens.
test("the connector token is passed to Docker by name, never on the command line", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-token-argv-"));
  const generatedSecretsPath = join(stateDir, "generated-secrets.json");
  writeFileSync(generatedSecretsPath, "{}\n", { mode: 0o600 });
  const token = "wf_local_notarealtokenjustatest";
  let runArgs = null;
  let runEnvironment = null;

  const runner = async (_command, args, options = {}) => {
    if (args[0] === "inspect") throw missing();
    if (args[0] === "image") return { stdout: "sha256:image\n" };
    if (args[0] === "run") {
      runArgs = args;
      runEnvironment = options.env;
      throw Object.assign(new Error(`Command failed: docker ${args.join(" ")}`), { stderr: "boom" });
    }
    return { stdout: "" };
  };

  try {
    await assert.rejects(() => launchHostInstance({
      stateDir, image: "worldfixture:test", connectorToken: token, generatedSecretsPath, runner,
      selectPorts: async () => [{ name: "slack", containerPort: 4703, hostPort: 4703, release: async () => {} }],
    }));

    assert.equal(runArgs.includes("--env"), true);
    assert.equal(runArgs.includes("WORLDFIXTURE_TOKEN"), true);
    // The value appears nowhere in the argument list, and therefore nowhere in
    // `ps`, and nowhere in the message any failure throws.
    assert.equal(runArgs.some((argument) => argument.includes(token)), false);
    assert.equal(runEnvironment.WORLDFIXTURE_TOKEN, token);
    assert.equal(
      runArgs.includes(`type=bind,source=${dirname(generatedSecretsPath)},target=/project-private`),
      true,
    );
    assert.equal(runArgs.includes("WORLDFIXTURE_GENERATED_SECRETS_PATH=/project-private/generated-secrets.json"), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the Notion emulator advertises its selected host origin", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-notion-origin-"));
  let runArgs;
  let runEnvironment;
  const runner = async (_command, args, options = {}) => {
    if (args[0] === "inspect") throw missing();
    if (args[0] === "image") return { stdout: "sha256:image\n" };
    if (args[0] === "run") {
      runArgs = args;
      runEnvironment = options.env;
      throw new Error("stop after docker arguments are captured");
    }
    return { stdout: "" };
  };

  try {
    await assert.rejects(() => launchHostInstance({
      stateDir,
      image: "worldfixture:test",
      runner,
      selectPorts: async () => [{ name: "notion", containerPort: 4716, hostPort: 59428, release: async () => {} }],
    }));
    assert.equal(runArgs.includes("WORLDFIXTURE_NOTION_PUBLIC_BASE_URL"), true);
    assert.equal(runEnvironment.WORLDFIXTURE_NOTION_PUBLIC_BASE_URL, "http://127.0.0.1:59428");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The bug this closes: reserving a socket on 127.0.0.1 proves no PROGRAM holds
// the port, and says nothing about Docker's own allocator. A container from
// another project publishing 3306 let the reservation succeed and then made
// `docker run` fail. Ghost publishes 3306 in its development stack, so a Ghost
// developer could not start a world at all.
test("a port Docker refuses is taken out of the pool and the launch is retried", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-port-retry-"));
  const attempts = [];

  const runner = async (_command, args) => {
    if (args[0] === "inspect") throw missing();
    if (args[0] === "image") return { stdout: "sha256:image\n" };
    if (args[0] === "run") {
      const published = args.filter((_argument, index) => args[index - 1] === "--publish");
      attempts.push(published);
      if (published.some((entry) => entry.endsWith(":3306:3306"))) {
        throw Object.assign(new Error("docker run failed"), {
          stderr: "docker: Error response from daemon: Bind for 0.0.0.0:3306 failed: port is already allocated",
        });
      }
      throw Object.assign(new Error("stop here"), { stderr: "the retry is what this case is about" });
    }
    return { stdout: "" };
  };

  const selectPorts = async (surfaces, { avoid = new Set() } = {}) =>
    surfaces.map((surface) => ({
      ...surface,
      hostPort: avoid.has(surface.preferredPort) ? 55000 + surface.containerPort : surface.preferredPort,
      release: async () => {},
    }));

  try {
    await assert.rejects(() => launchHostInstance({
      stateDir, image: "worldfixture:test", runner, selectPorts,
      projectConfig: { api_version: "worldfixture.project/v1", application_url: "http://localhost:3000", services: ["mysql"] },
    }));

    assert.equal(attempts.length, 2, "the launch was not retried");
    assert.equal(attempts[0].some((entry) => entry.endsWith(":3306:3306")), true);
    assert.equal(attempts[1].some((entry) => entry.endsWith(":3306:3306")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The bug this closes: the port retry reported itself through `onPull`, whose
// only caller is `cli.mjs` and whose only argument is the image name it prints
// as `Fetching <name>`. Handing it `{stage, port}` printed
// `Fetching    [object Object]` and then "about 190 MB, once; later runs reuse
// it" -- an untrue sentence about an event that fetches nothing. The retry now
// has its own callback and is called with the port number alone.
test("a port retry reports the port on its own callback, not through onPull", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-port-retry-notice-"));
  const pulled = [];
  const retried = [];

  const runner = async (_command, args) => {
    if (args[0] === "inspect") throw missing();
    if (args[0] === "image") return { stdout: "sha256:image\n" };
    if (args[0] === "run") {
      const published = args.filter((_argument, index) => args[index - 1] === "--publish");
      if (published.some((entry) => entry.endsWith(":3306:3306"))) {
        throw Object.assign(new Error("docker run failed"), {
          stderr: "docker: Error response from daemon: Bind for 0.0.0.0:3306 failed: port is already allocated",
        });
      }
      throw Object.assign(new Error("stop here"), { stderr: "the retry is what this case is about" });
    }
    return { stdout: "" };
  };

  const selectPorts = async (surfaces, { avoid = new Set() } = {}) =>
    surfaces.map((surface) => ({
      ...surface,
      hostPort: avoid.has(surface.preferredPort) ? 55000 + surface.containerPort : surface.preferredPort,
      release: async () => {},
    }));

  try {
    await assert.rejects(() => launchHostInstance({
      stateDir, image: "worldfixture:test", runner, selectPorts,
      onPull: (name) => pulled.push(name),
      onPortRetry: (port) => retried.push(port),
      projectConfig: { api_version: "worldfixture.project/v1", application_url: "http://localhost:3000", services: ["mysql"] },
    }));

    assert.deepEqual(retried, [3306]);
    // Whatever `onPull` receives has to render as an image name.
    for (const name of pulled) assert.equal(typeof name, "string", `onPull was handed ${String(name)}`);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The bug this closes: `HostLauncherError` carries a written `repair` line for
// each way a launch can fail -- the image cannot be pulled, a port is taken, a
// container of that name is not ours -- and the CLI caught `ConnectorError` and
// `ScaleError` and not this one. So the most likely first-use failure of all,
// `npx worldfixture up` before the image exists or without network, printed a
// Node stack trace naming `host-launcher.mjs:281` and buried the sentence that
// says what to do.
test("a launch failure carries a repair line for the command line to print", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-image-"));
  const runner = async (_command, args) => {
    if (args[0] === "inspect") throw missing();
    if (args[0] === "image") throw missing();
    if (args[0] === "pull") throw Object.assign(new Error("pull failed"), { stderr: "manifest unknown" });
    return { stdout: "" };
  };

  try {
    await assert.rejects(
      () => launchHostInstance({ stateDir, image: "ghcr.io/example/worldfixture:9.9.9", runner }),
      (error) => {
        assert.equal(error instanceof HostLauncherError, true);
        assert.equal(error.code, "image_unavailable");
        assert.match(error.message, /could not be pulled/);
        assert.match(error.repair, /WORLDFIXTURE_IMAGE/);
        return true;
      },
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// The bug this closes: a CLI inside the container that deliberately refused --
// printed its reason and set `process.exitCode = 1` -- reached the user as an
// unhandled Node error and a stack trace, because `run` is a promisified
// `execFile` and nothing caught its rejection. The written answer sat in
// `error.stdout`. Measured against the published 0.2.3 image with
// `slack send --as maya`, which this session's ambiguity fix made a common
// input rather than a rare one.
test("a command that exits non-zero returns its output and its code, and does not throw", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-exec-code-"));
  const name = hostContainerName(stateDir);
  const refusal = '"maya" names 2 people in this world. Say which one:\n';

  const runner = async (_command, args) => {
    if (args[0] === "inspect") {
      // `docker inspect --format "{{json .}}"` answers one object, not an array.
      return { stdout: JSON.stringify({
        Id: "c0ffee", Name: `/${name}`, State: { Running: true }, Image: "sha256:image",
        Config: { Image: "worldfixture:test",
          Labels: { "org.worldfixture.instance": "local", "org.opencontainers.image.title": "WorldFixture" } },
        Mounts: [{ Destination: "/state", Source: stateDir, Type: "bind", RW: true }],
      }) };
    }
    if (args[0] === "exec") {
      throw Object.assign(new Error("Command failed"), { code: 1, stdout: refusal, stderr: "" });
    }
    return { stdout: "" };
  };

  try {
    const result = await runInHostInstance(stateDir, ["slack", "send", "--as", "maya"], { runner });
    assert.equal(result.code, 1, "the command's own exit status travels back");
    assert.equal(result.stdout, refusal, "and so does what it wrote");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// A transport failure is not a command answering, and still throws.
test("a spawn failure is not mistaken for a command that exited non-zero", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "worldfixture-exec-enoent-"));
  const name = hostContainerName(stateDir);

  const runner = async (_command, args) => {
    if (args[0] === "inspect") {
      // `docker inspect --format "{{json .}}"` answers one object, not an array.
      return { stdout: JSON.stringify({
        Id: "c0ffee", Name: `/${name}`, State: { Running: true }, Image: "sha256:image",
        Config: { Image: "worldfixture:test",
          Labels: { "org.worldfixture.instance": "local", "org.opencontainers.image.title": "WorldFixture" } },
        Mounts: [{ Destination: "/state", Source: stateDir, Type: "bind", RW: true }],
      }) };
    }
    throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  };

  try {
    await assert.rejects(() => runInHostInstance(stateDir, ["people"], { runner }), /ENOENT/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
