// Check the real image entrypoint. --checkout overlays only the changed runtime
// source for a local check; CI tests the built image without an overlay.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

const { values } = parseArgs({ options: {
  image: { type: "string", default: "worldfixture:local" },
  checkout: { type: "boolean", default: false },
  run: { type: "boolean", default: false },
} });
if (!values.run) {
  console.log("Use --run --image <image> to check image network bindings.");
} else {
  const execute = promisify(execFile);
  const docker = async args => (await execute("docker", args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  const name = `worldfixture-network-test-${randomUUID()}`;
  const ports = [4703, 4715, 8080];
  const args = ["run", "--detach", "--name", name,
    ...ports.flatMap(port => ["--publish", `127.0.0.1::${port}`])];
  if (values.checkout) {
    const root = join(import.meta.dirname, "../..");
    for (const path of ["runtime/src", "emulators/http-targets/server.mjs"]) {
      args.push("--mount", `type=bind,source=${join(root, path)},target=/opt/worldfixture/${path},readonly`);
    }
  }
  // Use the shipped ENTRYPOINT and its SINGLE_CONTAINER environment. Do not
  // supply --direct or override entrypoint: either would weaken this check.
  args.push(values.image, "--only", "site,slack", "--no-rebase", "--setup", "--no-sample-app");
  try {
    await docker(args);
    const [container] = JSON.parse(await docker(["inspect", name]));
    const mappings = container.NetworkSettings.Ports;
    for (const entries of Object.values(mappings).filter(Boolean)) {
      assert.ok(entries.every(entry => entry.HostIp === "127.0.0.1"), "all host publications must use loopback");
    }
    const origin = port => `http://127.0.0.1:${mappings[`${port}/tcp`][0].HostPort}`;
    const ready = `${origin(4715)}/readyz`;
    let started = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(ready, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { started = true; break; }
      } catch { /* Wait for this test container's Workbench. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(started, "image Workbench must accept Docker-forwarded traffic");
    // CLI status checks aggregate readiness, including service startup.
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await docker(["exec", name, "node", "runtime/bin/worldfixture.mjs", "status", "--state", "/state"]); healthy = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(healthy, "selected image services must become ready");
    const check = async () => {
      assert.equal((await fetch(`${origin(8080)}/readyz`)).status, 200);
      assert.equal((await (await fetch(`${origin(4703)}/api/auth.test`, { method: "POST" })).json()).error, "not_authed");
      const listeners = JSON.parse(await docker(["exec", name, "node", "--input-type=module", "-e", `
        import {readFileSync} from 'node:fs';
        const rows = ['tcp','tcp6'].flatMap(family => readFileSync('/proc/net/'+family,'utf8').trim().split('\\n').slice(1).map(row => {
          const fields=row.trim().split(/\\s+/), [address,port]=fields[1].split(':');
          return {family,address,port:parseInt(port,16),state:fields[3]};
        })).filter(row=>row.state==='0A');
        console.log(JSON.stringify(rows));
      `]));
      for (const port of ports) assert.ok(listeners.some(row => row.port === port && row.family === "tcp" && row.address === "00000000"), `container transport ${port}`);
      assert.ok(!listeners.some(row => row.family === "tcp6" && /^0+$/.test(row.address)), "no implicit IPv6 wildcard listener");
    };
    await check();
    // A switch restarts services through startOptions, not the initial start call.
    const generation = async () => JSON.parse(await docker(["exec", name, "cat", "/state/active-generation.json"])).generation;
    const before = await generation();
    await docker(["exec", name, "node", "runtime/bin/worldfixture.mjs", "switch", "business.saas-company:v3", "--no-rebase", "--state", "/state"]);
    assert.notEqual(await generation(), before, "switch must start a new generation");
    await check();
    console.log(`Image network checks passed${values.checkout ? " with checkout source overlay" : ""}: loopback host mappings, container forwarding, and world switch.`);
  } finally {
    await docker(["rm", "--force", name]);
  }
}
