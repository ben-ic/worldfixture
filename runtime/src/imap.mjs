// A small IMAP client, speaking the real protocol to the real server.
//
// `worldfixture mail inbox` exists for the same reason `slack send` does: to
// show that a manual action uses the interface an application uses. It logs in
// as the world person, selects a mailbox and fetches envelopes over IMAP4rev1.
// It never reads Cyrus's files.
//
// It implements the four commands that need implementing and no more. A world
// person reading their own inbox needs LOGIN, SELECT, FETCH and LOGOUT; a
// general-purpose IMAP library is not the thing under test here.

import { mimeContent } from "./message-content.mjs";
import { connect } from "node:net";

class Session {
  #socket;
  #buffer = Buffer.alloc(0);
  #literal = null;
  #error = null;
  #tag = 0;
  #waiters = [];

  constructor(socket, timeoutMs) {
    this.#socket = socket;
    socket.on("error", error => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("IMAP connection closed")));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("IMAP response timed out")));
    socket.on("data", (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
  }

  #fail(error) { this.#error = error; for (const waiter of this.#waiters.splice(0)) waiter.reject(error); }

  // Untagged lines accumulate; a tagged line ends the command that asked.
  #drain() {
    for (;;) {
      const waiter = this.#waiters[0];
      if (!waiter) return;

      if (this.#literal !== null) {
        if (this.#buffer.length < this.#literal) return;
        const literal = this.#buffer.subarray(0, this.#literal).toString('utf8');
        this.#buffer = this.#buffer.subarray(this.#literal); this.#literal = null;
        waiter.lines.literals.push(literal); waiter.lines.push(...literal.split('\r\n'));
        continue;
      }
      const end = this.#buffer.indexOf("\r\n");
      if (end === -1) return;

      const line = this.#buffer.subarray(0, end).toString("utf8");
      this.#buffer = this.#buffer.slice(end + 2);

      if (waiter.tag && line.startsWith(`${waiter.tag} `)) {
        this.#waiters.shift();
        const [, status] = line.split(" ");
        if (status === "OK") waiter.resolve(waiter.lines);
        else waiter.reject(new Error(line.slice(waiter.tag.length + 1)));
      } else if (!waiter.tag) {
        // The greeting: one untagged line and nothing more.
        this.#waiters.shift();
        if (line.startsWith("* OK")) waiter.resolve([line]);
        else waiter.reject(new Error(`unexpected greeting: ${line}`));
      } else {
        waiter.lines.push(line);
        const literal = line.match(/\{(\d+)\}$/);
        if (literal) this.#literal = Number(literal[1]);
      }
    }
  }

  #expect(tag) {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => {
      const lines = []; lines.literals = [];
      this.#waiters.push({ tag, lines, resolve, reject });
      this.#drain();
    });
  }

  greeting() {
    return this.#expect(null);
  }

  send(command) {
    this.#tag += 1;
    const tag = `a${this.#tag}`;
    const done = this.#expect(tag);
    this.#socket.write(`${tag} ${command}\r\n`);
    return done;
  }

  close() {
    this.#socket.destroy();
  }
}

function open(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`IMAP at ${host}:${port} did not answer within ${timeoutMs}ms`));
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.setTimeout(0);
      resolve(new Session(socket, timeoutMs));
    });
  });
}

// A mailbox listing, as envelopes rather than whole messages.
export async function inbox(address, { login, password, mailbox = "INBOX", limit = 20, timeoutMs = 10_000 } = {}) {
  const [host, port] = address.split(":");
  const session = await open(host, Number(port), timeoutMs);

  try {
    await session.greeting();
    // The caller resolves the artifact's reference from the run credentials.
    await session.send(`LOGIN "${login}" "${password}"`);

    const selected = await session.send(`SELECT "${mailbox}"`);
    const exists = Number(selected.find((line) => / EXISTS$/.test(line))?.split(" ")[1] ?? 0);
    const unseen = selected.find((line) => /UNSEEN/.test(line));

    if (exists === 0) return { mailbox, exists: 0, unseen, messages: [] };

    const first = Math.max(1, exists - limit + 1);
    const fetched = await session.send(
      `FETCH ${first}:${exists} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID IN-REPLY-TO)])`,
    );

    return { mailbox, exists, unseen, messages: parseEnvelopes(fetched) };
  } finally {
    try {
      await session.send("LOGOUT");
    } catch {
      /* the server may close first, which is a normal LOGOUT */
    }
    session.close();
  }
}

// FETCH replies interleave an untagged header line, then the literal's lines,
// then a closing `)`. This walks that shape rather than parsing IMAP generally.
function parseEnvelopes(lines) {
  const messages = [];
  let current = null;

  for (const line of lines) {
    const start = line.match(/^\* (\d+) FETCH /);
    if (start) {
      current = { seq: Number(start[1]), uid: Number(line.match(/UID (\d+)/)?.[1]) || undefined, seen: !/\\Seen/.test(line) === false, headers: {} };
      messages.push(current);
      continue;
    }
    if (!current) continue;
    if (line === ")") {
      current = null;
      continue;
    }
    const header = line.match(/^(From|To|Subject|Date|Message-ID|In-Reply-To):\s*(.*)$/i);
    if (header) current.headers[header[1].toLowerCase()] = decodeWords(header[2].trim());
  }

  return messages.filter((message) => Object.keys(message.headers).length > 0);
}

// RFC 2047 encoded words. A header carrying a non-ASCII subject arrives as
// `=?UTF-8?B?…?=`, and showing that to a person is showing them the wire rather
// than their mail. This world's invoice subjects use an em dash, so every one of
// them is encoded.
function decodeWords(value) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, text) => {
    try {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replaceAll("_", " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
              String.fromCharCode(parseInt(hex, 16)),
            ), "binary");
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      // An unknown charset is not a reason to lose the header.
      return whole;
    }
  });
}

// UID stays stable when another message is removed from the mailbox.
export async function readMessage(address, { login, password, mailbox = 'INBOX', uid, timeoutMs = 10_000 }) {
  if (!Number.isSafeInteger(uid) || uid < 1 || !['INBOX', 'Sent'].includes(mailbox)) throw new Error('Invalid message UID or mailbox');
  const quote = value => '"' + String(value).replace(/["\\]/g, '\\$&').replace(/[\r\n]/g, '') + '"';
  const [host, port] = address.split(':');
  const session = await open(host, Number(port), timeoutMs);
  try {
    await session.greeting(); await session.send(`LOGIN ${quote(login)} ${quote(password)}`);
    await session.send(`SELECT ${quote(mailbox)}`);
    const fetched = await session.send(`UID FETCH ${uid} (BODY.PEEK[])`);
    if (fetched.literals.length !== 1) throw new Error('Message is no longer available');
    return mimeContent(fetched.literals[0]);
  } finally { session.close(); }
}
