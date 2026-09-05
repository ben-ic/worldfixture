// Host port allocation.
//
// The lock carries port names and protocols and no numbers, because a number
// belongs to a run rather than to a resolution. This is where a run gets them.
//
// Allocation asks the kernel for a free port and then holds it until the child
// is spawned. Picking a number and hoping is how two services end up on one
// port, and the failure that produces -- "Slack did not start because port 4013
// is in use" -- has to arrive as a doctor message naming the port rather than
// as a mystery.

import { createServer } from "node:net";

import { credential } from "./credentials.mjs";

// A port the kernel says is free right now. There is an unavoidable race between
// releasing it and a child binding it; holding the listener until the moment of
// spawn is what keeps that window to microseconds instead of seconds.
function reserve(host, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      const { port } = server.address();
      resolve({ port, release: () => new Promise((done) => server.close(done)) });
    });
  });
}

// Allocate one host port per port the lock opens.
//
// `bind` follows `published`: a surface an application reaches binds every
// interface, and a private back channel stays on loopback. A fixture that binds
// more than it needs to is a fixture reachable from more than it should be.
export async function allocate(lock, {
  loopback = "127.0.0.1",
  publicHost = "0.0.0.0",
  runner = "container",
  fixedPorts,
} = {}) {
  const reservations = [];
  const allocation = new Map();

  try {
    for (const service of lock.services) {
      // A container has its own network namespace, so its ports are the fixed
      // ones its image was built around and the host maps an allocated number
      // onto each. A child process shares this namespace and binds the
      // allocated number itself.
      const contained = Boolean(service.container) && runner !== "process";

      for (const port of service.ports) {
        const key = `${service.name}/${port.name}`;
        const fixed = fixedPorts?.[key];
        if (fixedPorts && !Number.isInteger(fixed)) {
          throw new Error(`the single-container image assigns no port to ${key}`);
        }
        const reservation = await reserve(loopback, fixed ?? 0);
        reservations.push(reservation);

        if (contained && port.container_port === undefined) {
          throw new Error(
            `${service.name}: port ${port.name} runs in a container and declares no container_port`,
          );
        }

        allocation.set(key, {
          service: service.name,
          port: port.name,
          protocol: port.protocol,
          published: port.published,
          // The number this machine dials.
          number: reservation.port,
          // The number and interface the service itself binds. Everything in a
          // container binds every interface, because the supervisor probes it
          // from outside the namespace and a loopback-bound listener would be
          // unreachable however it were published.
          serverPort: contained ? port.container_port : reservation.port,
          bind: contained ? publicHost : port.published ? publicHost : loopback,
          // What a published container port is exposed on. A private port stays
          // bound to this machine even though the service inside binds widely.
          publishOn: port.published ? publicHost : loopback,
          contained,
          host: loopback,
        });
      }
    }
  } catch (error) {
    await Promise.all(reservations.map((r) => r.release()));
    throw error;
  }

  return {
    allocation,
    // Called immediately before spawning, never earlier.
    release: () => Promise.all(reservations.map((r) => r.release())),
  };
}

// Stable ports inside the all-in-one image. Docker maps only the published
// entries. Private back channels remain in the same network namespace and need
// no host mapping. These numbers belong to one run topology, not to the lock.
export const SINGLE_CONTAINER_PORTS = {
  "emulate/apple": 4710,
  "emulate/aws": 4711,
  "emulate/clerk": 4712,
  "emulate/github": 4704,
  "emulate/google": 4705,
  "emulate/linear": 4713,
  "emulate/microsoft": 4706,
  "emulate/mongoatlas": 4707,
  "emulate/notion": 4716,
  "emulate/okta": 4708,
  "emulate/resend": 4709,
  "emulate/slack": 4703,
  "emulate/stripe": 4701,
  "emulate/twilio": 4714,
  "emulate/vercel": 4702,
  "http-targets/http": 8080,
  "mail/smtp": 2525,
  "mail/imap": 1143,
  "mail/mailbox": 8081,
  "mail/health": 8025,
  "s3/master": 61000,
  "s3/master-grpc": 61001,
  "s3/volume": 61002,
  "s3/volume-grpc": 61003,
  "s3/filer": 61004,
  "s3/filer-grpc": 61005,
  "s3/s3": 61006,
  "s3/s3-grpc": 61007,
  "postgres/postgres": 5432,
  "mysql/mysql": 3306,
};

// The environment one service is started with: its ports, in whatever shape it
// asks for them, plus the values the supervisor owns.
//
// Three of the four services spell a port differently -- a bare number with a
// separate bind variable, a combined `host:port`, a bare number with no bind at
// all. The manifest carries which, so this function is the whole of the
// supervisor's per-service knowledge, and a fifth service needs no change here.
export function environmentFor(service, allocation, {
  worldPath,
  worldSha256,
  runtimeToken,
  statePath,
  credentials,
}) {
  // WHO PLAYS THE WORLD'S TIMELINE. The composer inherited a `setTimeout` that
  // inserted the world's scheduled Gmail arrival directly, from outside the
  // runtime, with no ledger row and no reset. `runtime/src/scheduler.mjs` now
  // owns every arrival, so a service started BY THE SUPERVISOR must not also
  // play one -- the message would arrive twice, once through each path.
  //
  // It is announced rather than assumed, because a composer started on its own,
  // with no runtime above it, still has nobody else to play its arrivals and
  // must keep doing so.
  const environment = { WORLDFIXTURE_TIMELINE_OWNER: "runtime" };

  for (const port of service.ports) {
    const assigned = allocation.get(`${service.name}/${port.name}`);
    if (!assigned) throw new Error(`${service.name}: port ${port.name} was never allocated`);

    environment[port.env] =
      port.env_format === "host_port"
        ? `${assigned.bind}:${assigned.serverPort}`
        : String(assigned.serverPort);

    if (port.bind_env) environment[port.bind_env] = assigned.bind;
  }

  const sources = {
    "world.path": worldPath,
    "world.sha256": worldSha256,
    "runtime.token": runtimeToken,
    "runtime.state": statePath,
  };

  for (const value of service.environment ?? []) {
    let resolved = value.from === "constant"
      ? value.value
      : value.from === "generated"
        ? credential(credentials, value.key)
        : sources[value.from];
    if (value.from === "capability.port.url" || value.from === "capability.port.host_port") {
      const assigned = allocation.get(`${value.service}/${value.port}`);
      if (assigned) {
        resolved = value.from === "capability.port.url"
          ? `http://${assigned.host}:${assigned.number}`
          : `${assigned.host}:${assigned.number}`;
      }
    }

    if (resolved === undefined) {
      if (value.required) {
        throw new Error(`${service.name} requires ${value.name} from ${value.from}, which this run has no value for`);
      }
      continue;
    }

    environment[value.name] = resolved;
  }

  return environment;
}
