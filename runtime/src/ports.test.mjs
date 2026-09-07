import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { loadManifests } from "./manifests.mjs";
import { allocate, environmentFor, listenHost } from "./ports.mjs";
import { dockerInvocation } from "./supervisor.mjs";

// Select every declared port, including optional providers. No world or service
// container starts: only allocation reservations and the socket below are used.
const services = loadManifests(join(import.meta.dirname, "../../emulators"))
  .map(({ name, runtime }) => ({ name, ...runtime }));
const lock = { services };

for (const topology of [
  { name: "host checkout", runner: "container", inContainer: false },
  { name: "host processes", runner: "process", inContainer: false },
  { name: "product image", runner: "process", inContainer: true },
]) {
  test(`${topology.name}: every manifest port obeys its namespace boundary`, async () => {
    const { allocation, release } = await allocate(lock, topology);
    try {
      for (const [key, port] of allocation) {
        assert.equal(port.host, "127.0.0.1", key);
        assert.equal(port.publishOn, "127.0.0.1", key);
        const containerTransport = port.contained || (topology.inContainer && port.published);
        assert.equal(port.bind, containerTransport ? "0.0.0.0" : "127.0.0.1", key);
      }
      // Exercise the actual environment adapter, not only allocation metadata.
      for (const service of services) {
        const env = environmentFor({ ...service, environment: [] }, allocation, {});
        for (const port of service.ports) {
          const assigned = allocation.get(`${service.name}/${port.name}`);
          if (port.env_format === "host_port") assert.equal(env[port.env], `${assigned.bind}:${assigned.serverPort}`);
          if (port.bind_env) assert.equal(env[port.bind_env], assigned.bind);
        }
        if (service.container && topology.runner !== "process") {
          const { args } = dockerInvocation(service, env, { allocation, worldPath: "/test-world" });
          const mappings = args.filter((_arg, index) => args[index - 1] === "-p");
          assert.equal(mappings.length, service.ports.length);
          assert.ok(mappings.every(value => /^127\.0\.0\.1:\d+:\d+$/.test(value)), service.name);
        }
      }
      assert.equal(listenHost({ inContainer: topology.inContainer }), topology.inContainer ? "0.0.0.0" : "127.0.0.1", "Workbench");
    } finally { await release(); }
  });
}

test("a published host service opens an actual IPv4 loopback socket", async () => {
  const service = services.find(value => value.name === "domain");
  const { allocation, release } = await allocate({ services: [service] });
  const env = environmentFor({ ...service, environment: [] }, allocation, {});
  await release();
  const [host, port] = env.WORLDFIXTURE_DOMAIN_LISTEN.split(":");
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(port), host, resolve);
    });
    assert.equal(server.address().address, "127.0.0.1");
    assert.equal(server.address().family, "IPv4");
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
});

test("world switches retain the same network policy and reject stale wide host allocations", async () => {
  const service = services.find(value => value.name === "domain");
  for (const inContainer of [false, true]) {
    const options = { runner: "process", inContainer };
    const first = await allocate({ services: [service] }, options);
    await first.release();
    const next = await allocate({ services: [service] }, { ...options, preservedAllocation: first.allocation });
    await next.release();
    assert.equal(next.allocation.get("domain/http"), first.allocation.get("domain/http"));
    await assert.rejects(allocate({ services: [service] }, { ...options, inContainer: !inContainer, preservedAllocation: first.allocation }), /incompatible network access/);
  }
});

test("Docker argument generation rejects non-loopback host publications, including IPv6", () => {
  const service = services.find(value => value.name === "mail");
  for (const publishOn of ["0.0.0.0", "::", "[::]", "192.168.1.20", "", undefined]) {
    const allocation = new Map(service.ports.map(port => [`mail/${port.name}`, { publishOn, number: 40000, serverPort: port.container_port }]));
    assert.throws(() => dockerInvocation(service, {}, { allocation, worldPath: "/test-world" }), /must use loopback/);
  }
});
