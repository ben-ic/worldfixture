// Asking a service, over its own protocol, whether it is answering.
//
// This is the one place the runtime is allowed to form an opinion about whether
// a service is up, and it is deliberately narrow: connect to the port the lock
// names, speak the protocol the lock names, and compare the answer to what the
// lock expects. It never reads a log line and never inspects a process table.
//
// WHY THAT RULE IS WRITTEN DOWN RATHER THAN ASSUMED. A log line is a claim a
// service makes about itself before anything has tested it, and this extraction
// has already been misled twice by a listener that was up and wrong. A protocol
// answer is the service being asked, by the same door an application uses.
//
// A check has a `kind`. A `seed_gate` answers "did the world finish loading" and
// may be a marker a shell entry point wrote once. A `protocol` check answers "is
// this surface working now" and has to re-answer on every poll. Both are polled
// here; only the second is evidence of a live service, which is why `aggregate`
// reports them separately.

import { connect } from "node:net";

const DEFAULT_TIMEOUT_MS = 2_000;

// An HTTP `expect` is either a status code or a substring of the body. A status
// alone would have accepted the composer's 404 on a path it does not serve; a
// body match is what proves the route is the one intended.
async function probeHttp(check, address, timeoutMs) {
  const url = `http://${address.host}:${address.port}${check.path ?? "/"}`;

  let response;
  try {
    response = await fetch(url, {
      method: check.method ?? "GET",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
  } catch (error) {
    return { ok: false, detail: `${url}: ${error.message}` };
  }

  const expected = check.expect ?? "200";

  if (/^[1-5][0-9][0-9]$/.test(expected)) {
    return response.status === Number(expected)
      ? { ok: true, detail: `${url} -> ${response.status}` }
      : { ok: false, detail: `${url} -> ${response.status}, expected ${expected}` };
  }

  const body = await response.text().catch(() => "");
  return body.includes(expected)
    ? { ok: true, detail: `${url} -> ${response.status}, body names ${JSON.stringify(expected)}` }
    : { ok: false, detail: `${url} -> ${response.status}, body does not name ${JSON.stringify(expected)}` };
}

// SMTP and IMAP both greet the client. Reading that greeting is the cheapest
// thing that is genuinely the protocol: a bare TCP connect proves a socket is
// bound, which is exactly the evidence that has been wrong before.
function probeGreeting(check, address, timeoutMs) {
  return new Promise((resolve) => {
    const where = `${address.host}:${address.port}`;
    const socket = connect({ host: address.host, port: address.port });
    let buffer = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ ok: false, detail: `${where}: no greeting within ${timeoutMs}ms` }));
    socket.on("error", (error) => finish({ ok: false, detail: `${where}: ${error.message}` }));
    socket.on("close", () => finish({ ok: false, detail: `${where}: closed before greeting` }));

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      const greeting = buffer.split("\n")[0].trimEnd();
      finish(
        greeting.startsWith(check.expect)
          ? { ok: true, detail: `${where} -> ${greeting}` }
          : { ok: false, detail: `${where} -> ${greeting}, expected ${JSON.stringify(check.expect)}` },
      );
    });
  });
}

function probeTcp(address, timeoutMs) {
  return new Promise((resolve) => {
    const where = `${address.host}:${address.port}`;
    const socket = connect({ host: address.host, port: address.port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, detail: `${where}: connect timed out` }));
    socket.on("error", (error) => finish({ ok: false, detail: `${where}: ${error.message}` }));
    socket.on("connect", () => finish({ ok: true, detail: `${where} accepted a connection` }));
  });
}

// PostgreSQL answers its startup packet with an authentication message. This
// proves that the listener is PostgreSQL and that the declared database and
// user reached its protocol parser. It does not need a client dependency.
function probePostgres(check, address, timeoutMs) {
  return new Promise((resolve) => {
    const where = `${address.host}:${address.port}`;
    const socket = connect({ host: address.host, port: address.port });
    let settled = false;
    let buffer = Buffer.alloc(0);
    const parameters = Buffer.from(`user\0${check.username ?? "worldfixture"}\0database\0${check.database ?? "postgres"}\0\0`);
    const startup = Buffer.alloc(8 + parameters.length);
    startup.writeInt32BE(startup.length, 0);
    startup.writeInt32BE(196608, 4);
    parameters.copy(startup, 8);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, detail: `${where}: no PostgreSQL reply within ${timeoutMs}ms` }));
    socket.on("error", (error) => finish({ ok: false, detail: `${where}: ${error.message}` }));
    socket.on("connect", () => socket.write(startup));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 5) return;
      const type = String.fromCharCode(buffer[0]);
      const length = buffer.readInt32BE(1);
      if (length < 4 || buffer.length < length + 1) return;
      if (type === "R") finish({ ok: true, detail: `${where} -> PostgreSQL authentication request` });
      else if (type === "E") finish({ ok: true, detail: `${where} -> PostgreSQL startup error response` });
      else finish({ ok: false, detail: `${where} -> unexpected PostgreSQL message ${JSON.stringify(type)}` });
    });
  });
}

// A MySQL-compatible server sends its handshake before authentication. The
// protocol version byte and complete packet framing prove the wire protocol
// without adding a database client dependency.
function probeMySQL(_check, address, timeoutMs) {
  return new Promise((resolve) => {
    const where = `${address.host}:${address.port}`;
    const socket = connect({ host: address.host, port: address.port });
    let settled = false;
    let buffer = Buffer.alloc(0);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, detail: `${where}: no MySQL handshake within ${timeoutMs}ms` }));
    socket.on("error", (error) => finish({ ok: false, detail: `${where}: ${error.message}` }));
    socket.on("close", () => finish({ ok: false, detail: `${where}: closed before MySQL handshake` }));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 5) return;
      const length = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16);
      if (length < 1 || buffer.length < length + 4) return;
      const version = buffer[4];
      if (version === 10) finish({ ok: true, detail: `${where} -> MySQL protocol 10 handshake` });
      else finish({ ok: false, detail: `${where} -> unexpected MySQL protocol version ${version}` });
    });
  });
}

export async function probe(check, address, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  switch (check.protocol) {
    case "http":
    case "s3":
      return probeHttp(check, address, timeoutMs);
    case "smtp":
    case "imap":
    case "lmtp":
      return probeGreeting(check, address, timeoutMs);
    case "tcp":
      return probeTcp(address, timeoutMs);
    case "postgres":
      return probePostgres(check, address, timeoutMs);
    case "mysql":
      return probeMySQL(check, address, timeoutMs);
    default:
      // A protocol nothing knows how to speak is not a readiness check. Saying
      // so is better than a TCP connect wearing the name of one.
      return { ok: false, detail: `no probe for protocol ${JSON.stringify(check.protocol)}` };
  }
}

// Poll one check until it answers or the deadline passes.
export async function waitFor(check, address, { timeoutMs = 60_000, intervalMs = 250, probeTimeoutMs, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, detail: "never probed" }, cancel;
  const cancelled = new Promise(resolve => { cancel = () => resolve(null); });
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (Date.now() < deadline && !signal?.aborted) {
      const result = await Promise.race([probe(check, address, { timeoutMs: probeTimeoutMs }), cancelled]);
      if (signal?.aborted || result === null) return { ok: false, detail: 'Readiness wait cancelled by service lifecycle' };
      last = result;
      if (last.ok) return last;
      await Promise.race([new Promise(resolve => setTimeout(resolve, intervalMs)), cancelled]);
    }
    return signal?.aborted ? { ok: false, detail: 'Readiness wait cancelled by service lifecycle' }
      : { ...last, detail: `${last.detail} (still failing after ${timeoutMs}ms)` };
  } finally { signal?.removeEventListener('abort', cancel); }
}

// One service's readiness, from its own checks.
//
// `ready` is true only when every protocol check answers. A seed gate that has
// not passed also blocks, because a service serving an unseeded world is
// answering about nothing -- but a passing seed gate on its own is never enough,
// which is the distinction the aggregate exists to keep.
export function aggregate(results) {
  const gates = results.filter((result) => result.kind === "seed_gate");
  const live = results.filter((result) => result.kind === "protocol");

  return {
    ready: live.length > 0 && live.every((r) => r.ok) && gates.every((r) => r.ok),
    seeded: gates.every((r) => r.ok),
    proven: live.filter((r) => r.ok).length,
    checks: results,
  };
}
