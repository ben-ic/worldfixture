// SMTP submission, over the real protocol.
//
// The runtime delivers a causal rule's mail through the same submission port an
// application would use, rather than writing into Cyrus. A message the server
// refused is not a message that was sent, so nothing is recorded as delivered
// until the server has answered 250 to the final dot.

import { connect } from "node:net";

function conversation(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = "";
    const waiters = [];

    const drain = () => {
      // An SMTP reply ends on a line whose fourth character is a space.
      for (;;) {
        const match = buffer.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/);
        if (!match || waiters.length === 0) return;
        const reply = buffer.slice(0, match[0].length);
        buffer = buffer.slice(match[0].length);
        const waiter = waiters.shift();
        const code = Number(match[1]);
        if (waiter.expect.includes(code)) waiter.resolve(reply.trim());
        else waiter.reject(new Error(`SMTP said ${reply.trim()}, expected ${waiter.expect.join(" or ")}`));
      }
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`SMTP at ${host}:${port} did not answer within ${timeoutMs}ms`));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      drain();
    });

    const expect = (...codes) =>
      new Promise((ok, no) => {
        waiters.push({ expect: codes, resolve: ok, reject: no });
        drain();
      });

    const say = (line, ...codes) => {
      socket.write(`${line}\r\n`);
      return expect(...codes);
    };

    socket.on("connect", () => resolve({ expect, say, close: () => socket.destroy() }));
  });
}

export async function send(address, { from, to, subject, body, date, headers = {} }, { timeoutMs = 10_000 } = {}) {
  const [host, port] = address.split(":");
  const smtp = await conversation(host, Number(port), timeoutMs);

  try {
    await smtp.expect(220);
    await smtp.say("EHLO worldfixture", 250);
    await smtp.say(`MAIL FROM:<${from}>`, 250);
    for (const recipient of [].concat(to)) await smtp.say(`RCPT TO:<${recipient}>`, 250);
    await smtp.say("DATA", 354);

    const message = [
      `From: ${from}`,
      `To: ${[].concat(to).join(", ")}`,
      `Subject: ${subject}`,
      `Date: ${date ?? new Date().toUTCString()}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "Content-Type: text/plain; charset=utf-8",
      "",
      // A lone dot would end DATA early; escaping it is part of the protocol.
      ...body.split("\n").map((line) => (line === "." ? ".." : line)),
      ".",
    ].join("\r\n");

    return await smtp.say(message, 250);
  } finally {
    try {
      await smtp.say("QUIT", 221);
    } catch {
      /* the server may close first */
    }
    smtp.close();
  }
}
