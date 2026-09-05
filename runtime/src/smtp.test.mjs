import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { send } from "./smtp.mjs";

// A server under our control, so the failure being tested is the one that is
// meant: the real Cyrus always answers.
function serverThat(behaviour) {
  const open = new Set();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    behaviour(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      address: `127.0.0.1:${server.address().port}`,
      // A server socket nothing ever reads from stays paused, so it never sees
      // the client's FIN and `server.close` waits for it forever. Destroying
      // them is the test's own cleanup, not something under test.
      close: () => new Promise((done) => {
        for (const socket of open) socket.destroy();
        server.close(done);
      }),
    }));
  });
}

// THE HANG THIS CLOSES. `conversation` called `reject` from its socket timeout,
// and `reject` belongs to the promise that already resolved when the socket
// connected. So a server that answered 220 and then stopped answering destroyed
// the socket and settled nothing: `send` stayed pending with no error and no
// timeout. Measured against a silent server, `send` was still pending two
// seconds after a 200ms timeout. It matters because a scheduler tick holds
// `running` while it delivers, and `suspend()` and `stop()` both wait for that
// to clear -- so one wedged mail server hung `reset` and shutdown as well.
test("a server that greets and then goes silent fails the send rather than hanging it", async () => {
  const smtp = await serverThat((socket) => {
    socket.write("220 silent.test ESMTP\r\n");
  });
  try {
    await assert.rejects(
      send(smtp.address, { from: "a@example.test", to: "b@example.test", subject: "s", body: "hi" }, { timeoutMs: 200 }),
      /did not answer within 200ms/,
    );
  } finally {
    await smtp.close();
  }
});

// The same waiter is left pending by a server that hangs up mid-conversation,
// which is what a mail server does when it is restarted underneath a delivery.
test("a server that hangs up mid-conversation fails the send", async () => {
  const smtp = await serverThat((socket) => {
    socket.write("220 rude.test ESMTP\r\n");
    socket.once("data", () => socket.destroy());
  });
  try {
    await assert.rejects(
      send(smtp.address, { from: "a@example.test", to: "b@example.test", subject: "s", body: "hi" }, { timeoutMs: 5_000 }),
      /closed the connection/,
    );
  } finally {
    await smtp.close();
  }
});

// The ordinary path still works, so the failure handling above cannot be
// passing by refusing everything.
test("a server that answers every step accepts the message", async () => {
  const seen = [];
  const smtp = await serverThat((socket) => {
    socket.setEncoding("utf8");
    let inData = false;
    socket.write("220 good.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\r\n")) {
        if (line === "") continue;
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 2.0.0 Ok: queued\r\n");
          }
          continue;
        }
        seen.push(line);
        if (line.startsWith("DATA")) { inData = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
        else if (line.startsWith("QUIT")) socket.write("221 2.0.0 Bye\r\n");
        else socket.write("250 2.1.0 Ok\r\n");
      }
    });
  });
  try {
    const reply = await send(
      smtp.address,
      { from: "a@example.test", to: "b@example.test", subject: "s", body: "hi" },
      { timeoutMs: 5_000 },
    );
    assert.match(reply, /^250 /);
    assert.deepEqual(seen.slice(0, 4), [
      "EHLO worldfixture",
      "MAIL FROM:<a@example.test>",
      "RCPT TO:<b@example.test>",
      "DATA",
    ]);
  } finally {
    await smtp.close();
  }
});

// THE CORRUPTION THIS CLOSES. Dot-stuffing was `line === "." ? ".." : line`,
// which escapes a line that IS a dot and not a line that BEGINS with one. RFC
// 5321 section 4.5.2 makes the receiver strip one leading period from every
// line in DATA, so an unescaped `.hidden` arrived as `hidden` and `..double` as
// `.double`. Measured over a real DATA conversation before the fix:
// ".hidden\n..double\nordinary\n.\ntrailing" was delivered as
// "hidden\n.double\nordinary\n.\ntrailing".
test("a body line that begins with a dot survives the round trip", async () => {
  const body = [".hidden", "..double", "ordinary", ".", "...", "trailing"].join("\n");
  let delivered;

  const smtp = await serverThat((socket) => {
    socket.setEncoding("utf8");
    let inData = false;
    let buffer = "";
    const lines = [];
    socket.write("220 dot.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            // What a receiver does: strip one leading period, then take
            // everything after the header separator as the body.
            const unstuffed = lines.map((entry) => (entry.startsWith(".") ? entry.slice(1) : entry));
            delivered = unstuffed.slice(unstuffed.indexOf("") + 1).join("\n");
            socket.write("250 2.0.0 Ok: queued\r\n");
            continue;
          }
          lines.push(line);
          continue;
        }
        if (line.startsWith("DATA")) { inData = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
        else if (line.startsWith("QUIT")) socket.write("221 2.0.0 Bye\r\n");
        else socket.write("250 2.1.0 Ok\r\n");
      }
    });
  });

  try {
    await send(
      smtp.address,
      { from: "a@example.test", to: "b@example.test", subject: "s", body },
      { timeoutMs: 5_000 },
    );
    assert.equal(delivered, body);
  } finally {
    await smtp.close();
  }
});
