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
