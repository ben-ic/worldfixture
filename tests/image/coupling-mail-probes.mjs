import { connect } from "node:net";
import { credential } from "../../runtime/src/credentials.mjs";
import { compareIdentities } from "./coupling-artifacts.mjs";

const quoted = value => {
  if (/[\r\n\0]/.test(String(value))) throw new Error("Invalid IMAP argument");
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
};

// Unlike the CLI envelope preview, this reader consumes byte-counted literals
// and full bodies. A line in a message can never terminate an IMAP command.
function sessionFor(socket, timeoutMs) {
  let buffer = Buffer.alloc(0), literal = null, waiter = null, failure = null, tag = 0;
  const frames = [];
  const fail = error => {
    failure ??= error;
    waiter?.reject(failure);
    waiter = null;
    socket.destroy();
  };
  const drain = () => {
    while (waiter) {
      if (literal !== null) {
        if (buffer.length < literal) return;
        frames.push({ literal: buffer.subarray(0, literal) });
        buffer = buffer.subarray(literal); literal = null;
        continue;
      }
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 2);
      if (!waiter.tag || line.startsWith(`${waiter.tag} `)) {
        const current = waiter; waiter = null;
        const ok = current.tag ? line.startsWith(`${current.tag} OK`) : line.startsWith("* OK");
        if (ok) current.resolve(frames.splice(0));
        else current.reject(new Error(`IMAP ${current.operation} was rejected`));
        return;
      }
      frames.push({ line });
      const size = line.match(/\{(\d+)\+?\}$/)?.[1];
      if (size !== undefined) literal = Number(size);
    }
  };
  socket.setTimeout(timeoutMs, () => fail(new Error(`IMAP read exceeded ${timeoutMs} ms`)));
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("IMAP connection closed before reply")));
  socket.on("data", data => { buffer = Buffer.concat([buffer, data]); drain(); });
  const expect = (commandTag, operation) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    waiter = { tag: commandTag, operation, resolve, reject };
    drain();
  });
  return {
    greeting: () => expect(null, "greeting"),
    send: command => {
      const commandTag = `c${++tag}`;
      const answer = expect(commandTag, command.split(" ")[0]);
      socket.write(`${commandTag} ${command}\r\n`);
      return answer;
    },
    close: () => socket.destroy(),
  };
}

function decodeWords(value) {
  return value.replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, encoding, text) => {
    const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64")
      : Buffer.from(text.replaceAll("_", " ").replace(/=([a-f\d]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
    return new TextDecoder(charset).decode(bytes);
  });
}

export function parseMailMessage(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  const normalized = raw.replaceAll("\r\n", "\n");
  const split = normalized.indexOf("\n\n");
  if (split < 0) throw new Error("IMAP message has no header/body separator");
  const headers = {};
  for (const line of normalized.slice(0, split).replace(/\n[ \t]+/g, " ").split("\n")) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) headers[match[1].toLowerCase()] = decodeWords(match[2]);
  }
  if (headers["content-type"] && !/^text\/plain\b/i.test(headers["content-type"])) throw new Error("IMAP message is not plain text; MIME reader coverage is required");
  let body = normalized.slice(split + 2);
  const encoding = headers["content-transfer-encoding"]?.toLowerCase();
  if (encoding === "base64") body = Buffer.from(body, "base64").toString("utf8");
  else if (encoding === "quoted-printable") body = Buffer.from(body.replace(/=\n/g, "").replace(/=([a-f\d]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "binary").toString("utf8");
  else if (encoding && !["7bit", "8bit", "binary"].includes(encoding)) throw new Error(`Unsupported mail transfer encoding: ${encoding}`);
  return { headers, body_text: body.replaceAll("\r\n", "\n"), raw };
}

export async function readImapMailbox({ address, login, password, mailbox, timeoutMs = 15_000 }) {
  const url = new URL(`imap://${address}`);
  const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) });
  const session = sessionFor(socket, timeoutMs);
  try {
    await session.greeting();
    await session.send(`LOGIN ${quoted(login)} ${quoted(password)}`);
    const selected = await session.send(`EXAMINE ${quoted(mailbox)}`);
    const count = selected.find(frame => /^\* \d+ EXISTS$/.test(frame.line ?? ""))?.line.match(/\d+/)?.[0];
    if (count === undefined) throw new Error("IMAP EXAMINE omitted the message count");
    const exists = Number(count), messages = [];
    if (exists) {
      const frames = await session.send(`FETCH 1:${exists} (UID FLAGS BODY.PEEK[])`);
      let record = null;
      for (const frame of frames) {
        const start = frame.line?.match(/^\* (\d+) FETCH /);
        if (start) record = { seq: Number(start[1]), flags: frame.line.match(/FLAGS \(([^)]*)\)/)?.[1].split(/\s+/).filter(Boolean) ?? [] };
        if (frame.literal !== undefined) {
          if (!record) throw new Error("IMAP returned a message literal without FETCH identity");
          messages.push({ ...record, ...parseMailMessage(frame.literal) });
          record = null;
        }
      }
      if (messages.length !== exists || new Set(messages.map(message => message.seq)).size !== exists) throw new Error(`IMAP returned ${messages.length} complete records for ${exists} messages`);
    }
    return { mailbox, exists, messages };
  } finally {
    // No LOGOUT round trip is needed after read-only EXAMINE. Closing avoids a
    // second timeout when a failed server cannot answer cleanup commands.
    session.close();
  }
}

const array = value => Array.isArray(value) ? value : [];
const normalizeBody = value => String(value ?? "").replaceAll("\r\n", "\n").replace(/\n+$/, "");
const addresses = value => [...String(value ?? "").matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi)].map(match => match[0].toLowerCase()).sort();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export async function probeMailWorld({ artifact, bindings, credentials, readMailbox = readImapMailbox, elapsedMs = 0 }) {
  const checks = [], responses = [], coverage = [];
  const world = artifact.world, projection = artifact.projections?.mail ?? {};
  const people = array(world.people), users = array(projection.users);
  const byId = new Map(people.map(person => [person.id, person]));
  const source = [...new Map([...array(world.communication?.resolved_mail), ...array(world.communication?.mail)].map(message => [message.id, message])).values()];
  const add = (check, passed, detail = {}) => checks.push({ check, status: passed ? "passed" : "failed", ...detail });
  checks.push(compareIdentities({ check: "mail.projection.people", expected: people, actual: users, finding: 8 }));
  checks.push(compareIdentities({ check: "mail.projection.messages", expected: source, actual: array(projection.messages), finding: 8 }));
  const credentialWorldMatches = credentials?.world?.id === world.id && credentials?.world?.version === String(world.version);
  add("mail.credentials-world", credentialWorldMatches, { expected: { id: world.id, version: String(world.version) }, actual: credentials?.world ?? null });
  const safeError = error => {
    let detail = String(error.message ?? error);
    for (const secret of Object.values(credentials?.values ?? {})) if (typeof secret === "string" && secret) detail = detail.replaceAll(secret, "[redacted]");
    return detail;
  };
  if (!bindings.IMAP_HOST_PORT) {
    add("provider.mail.read", false, { detail: "Missing IMAP_HOST_PORT" });
    return { checks, responses, coverage };
  }
  if (!people.length || !credentialWorldMatches) {
    add("provider.mail.read", false, { detail: !people.length ? "No source mailboxes are available to prove Local Mail." : "Run credentials do not belong to the source world." });
    return { checks, responses, coverage };
  }
  const realm = people.find(person => person.primary)?.email?.split("@")[1];
  const domain = array(world.organizations).find(org => org.primary)?.domain ?? realm;
  const messageId = id => `<${String(id).replace(/[^A-Za-z0-9._-]/g, "-")}@${domain}>`;
  const fields = message => ({
    subject: String(message.subject ?? ""), from: addresses(byId.get(message.from_id)?.email),
    to: array(message.to_ids).flatMap(id => addresses(byId.get(id)?.email)).sort(),
    body: normalizeBody(message.body_text ?? message.snippet), date: Date.parse(message.sent_at),
    labels: [...array(message.labels)].sort(), message_id: messageId(message.id),
  });
  for (const person of people) {
    const user = users.find(entry => entry.id === person.id);
    for (const mailbox of ["INBOX", "Sent"]) {
      const path = `imap://${bindings.IMAP_HOST_PORT}/${encodeURIComponent(person.email ?? person.id)}/${mailbox}`;
      const prefix = `mail.${person.id}.${mailbox}`;
      try {
        if (!user) throw new Error("Source person has no projected mailbox or credential reference");
        if (user.email !== person.email || user.login !== person.email) throw new Error("Projected mailbox identity differs from source person email");
        const read = await readMailbox({ address: bindings.IMAP_HOST_PORT, login: user.login, password: credential(credentials, user.password_ref), mailbox });
        responses.push({ provider: "mail", path, status: 200, body: read });
        const actual = array(read.messages);
        add(`${prefix}.complete`, Number.isSafeInteger(read.exists) && read.exists === actual.length, { expected: read.exists, actual: actual.length });
        const expected = source.filter(message => mailbox === "INBOX" ? array(message.to_ids).includes(person.id)
          : message.from_id === person.id && array(message.labels).includes("SENT"));
        const baseline = actual.filter(message => message.headers?.["x-worldfixture-record"]);
        checks.push(compareIdentities({ check: `${prefix}.records`, expected, actual: baseline, actualId: message => message.headers["x-worldfixture-record"], finding: 8 }));
        for (const message of baseline) {
          const record = expected.find(entry => entry.id === message.headers["x-worldfixture-record"]);
          if (!record) continue;
          const wanted = fields(record);
          const served = { subject: message.headers.subject, from: addresses(message.headers.from), to: addresses(message.headers.to),
            body: normalizeBody(message.body_text), date: Date.parse(message.headers.date),
            labels: String(message.headers["x-worldfixture-labels"] ?? "").split(",").map(label => label.trim()).filter(Boolean).sort(), message_id: message.headers["message-id"] };
          add(`${prefix}.fields.${record.id}`, equal(wanted, served), { expected: wanted, actual: served, finding: 8 });
          const seen = mailbox === "Sent" || !array(record.labels).includes("UNREAD");
          add(`${prefix}.seen.${record.id}`, array(message.flags).includes("\\Seen") === seen, { expected: seen, actual: array(message.flags).includes("\\Seen") });
        }
        const elapsed = typeof elapsedMs === "function" ? elapsedMs() : elapsedMs;
        const due = array(world.timeline).filter(event => event.after_seconds * 1000 <= elapsed);
        const allowed = [];
        if (mailbox === "INBOX") for (const event of due) {
          const payload = event.payload ?? {};
          if (event.kind === "incoming-email" && (payload.via ?? "smtp") === "smtp" && payload.to_id === person.id) {
            allowed.push({ arrival: event.id, from: addresses(byId.get(payload.from_id)?.email), to: addresses(person.email), subject: payload.subject ?? "", body: normalizeBody(payload.body_text ?? payload.snippet) });
          }
          if (event.kind === "chat-message") {
            const channel = array(world.communication?.channels).find(entry => entry.id === payload.channel_id);
            const author = byId.get(payload.author_id);
            if (author && person.id !== author.id && array(channel?.member_ids).includes(person.id)) allowed.push({
              notification: true, from: addresses(author.email), to: addresses(person.email), subject: `[#${channel.name}] ${author.name} posted`,
              body: normalizeBody(`${author.name} posted in #${channel.name}:\n\n${payload.text}\n`),
            });
          }
        }
        const unexpected = [];
        for (const message of actual.filter(entry => !entry.headers?.["x-worldfixture-record"])) {
          const shape = { from: addresses(message.headers?.from), to: addresses(message.headers?.to), subject: message.headers?.subject, body: normalizeBody(message.body_text) };
          const index = allowed.findIndex(entry => equal({ from: entry.from, to: entry.to, subject: entry.subject, body: entry.body }, shape)
            && (entry.notification ? !!message.headers?.["x-worldfixture-rule"] : entry.arrival === message.headers?.["x-worldfixture-arrival"]));
          if (index < 0) unexpected.push(shape); else allowed.splice(index, 1);
        }
        add(`${prefix}.unexpected`, unexpected.length === 0, { expected: [], actual: unexpected, finding: 6,
          detail: "Only exact due authored arrivals and their known chat notification shapes are allowed beyond seeded mail. Timeline delivery completeness is checked separately." });
      } catch (error) {
        add(`${prefix}.read`, false, { finding: 8, detail: safeError(error) });
        responses.push({ provider: "mail", path, status: "failed", body: { error: safeError(error) } });
      }
    }
  }
  const status = checks.some(check => check.status === "failed") ? "failed" : "passed";
  add("provider.mail.read", status === "passed", { detail: "Every source person attempted through IMAP EXAMINE and complete body FETCH in INBOX and Sent." });
  for (const collection of ["communication.mail", "communication.resolved_mail"]) coverage.push({ collection, provider: "mail", path: "IMAP EXAMINE INBOX/Sent; FETCH 1:EXISTS (UID FLAGS BODY.PEEK[])", status,
    detail: "Source-derived identity, body, date, sender, recipients, labels, and read-state checks; each person's runtime credential is used." });
  return { checks, responses, coverage };
}
