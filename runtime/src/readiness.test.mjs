import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { probe } from "./readiness.mjs";

test("the PostgreSQL probe sends a startup packet and requires a protocol reply", async (t) => {
  let startup;
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      startup = data;
      const reply = Buffer.alloc(9);
      reply[0] = "R".charCodeAt(0);
      reply.writeInt32BE(8, 1);
      reply.writeInt32BE(10, 5);
      socket.end(reply);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const result = await probe(
    { protocol: "postgres", username: "worldfixture", database: "postgres" },
    { host: "127.0.0.1", port: server.address().port },
  );

  assert.equal(result.ok, true);
  assert.equal(startup.readInt32BE(4), 196608);
  assert.match(startup.toString("utf8", 8), /user\0worldfixture\0database\0postgres/);
});

test("the MySQL probe requires a protocol 10 handshake", async (t) => {
  const server = createServer((socket) => {
    const payload = Buffer.from([10, ...Buffer.from("10.11.18\0")]);
    const header = Buffer.from([
      payload.length & 0xff,
      (payload.length >> 8) & 0xff,
      (payload.length >> 16) & 0xff,
      0,
    ]);
    socket.end(Buffer.concat([header, payload]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const result = await probe(
    { protocol: "mysql" },
    { host: "127.0.0.1", port: server.address().port },
  );

  assert.equal(result.ok, true);
  assert.match(result.detail, /MySQL protocol 10 handshake/);
});

test("the MySQL probe reports a listener that closes before its handshake", async (t) => {
  const server = createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const result = await probe(
    { protocol: "mysql" },
    { host: "127.0.0.1", port: server.address().port },
  );

  assert.equal(result.ok, false);
  assert.match(result.detail, /closed before MySQL handshake/);
});


test("private container readiness requires an exact HTTP 200 and keeps curl bounded", async () => {
  const check = { protocol: "http", path: "/worldfixture/ready", expect: "200" };
  const address = { host: "127.0.0.1", port: 61004, container: "test-s3" };
  for (const status of ["200", "301", "404", "500"]) {
    const result = await probe(check, address, { timeoutMs: 1200, containerExec: async (command, args, options) => {
      assert.equal(command, "docker");
      assert.deepEqual(args.slice(0, 3), ["exec", "test-s3", "curl"]);
      assert.equal(args.at(-1), "http://127.0.0.1:61004/worldfixture/ready");
      assert.equal(args[args.indexOf("--max-time") + 1], "1.2");
      assert.ok(options.timeout > 0);
      return { stdout: status };
    } });
    assert.equal(result.ok, status === "200");
  }
  assert.equal((await probe(check, address, { containerExec: async () => { throw new Error("container stopped"); } })).ok, false);
  assert.equal((await probe(check, { ...address, host: "0.0.0.0" }, { containerExec: () => assert.fail("must not execute") })).ok, false);
});
