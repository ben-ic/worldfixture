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

    // A FAILURE HAS TO REACH WHOEVER IS WAITING FOR A REPLY.
    //
    // The timeout used to call `reject` alone, and `reject` is the promise this
    // function returned -- which has already resolved the moment the socket
    // connected. So a server that answered 220 and then went silent destroyed
    // the socket, resolved nothing, and left `send` pending forever: no error,
    // no timeout, no return. That blocks a scheduler tick, and a blocked tick
    // blocks `reset` and shutdown, both of which wait for the tick to settle.
    //
    // Every pending waiter is failed as well, so the error the timeout already
    // writes is the one the caller actually receives.
    let failure = null;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      reject(error);
      while (waiters.length > 0) waiters.shift().reject(error);
      socket.destroy();
    };

    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => {
      fail(new Error(`SMTP at ${host}:${port} did not answer within ${timeoutMs}ms`));
    });
    socket.on("error", fail);
    // A server that hangs up mid-conversation is the same shape of failure as
    // one that stops answering, and leaves the same waiter pending.
    socket.on("close", () => fail(new Error(`SMTP at ${host}:${port} closed the connection`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      drain();
    });

    const expect = (...codes) =>
      new Promise((ok, no) => {
        // A reply asked for after the connection has already failed can never
        // arrive. `send` asks for one in its `finally` -- the QUIT -- so
        // queueing it would put the hang back in the cleanup path.
        if (failure) return no(failure);
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
      // DOT-STUFFING IS PER LINE THAT BEGINS WITH A DOT, NOT PER LINE THAT IS
      // ONE. RFC 5321 section 4.5.2 has the sender insert a period before every
      // line whose first character is a period, and the receiver strip one back
      // off. Escaping only the lone `.` meant the receiver stripped a period
      // that was never doubled: measured over a real DATA conversation, a body
      // line `.hidden` was delivered as `hidden` and `..double` as `.double`.
      // The lone dot is covered by the same rule, since it also begins with one.
      ...body.split("\n").map((line) => (line.startsWith(".") ? `.${line}` : line)),
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
