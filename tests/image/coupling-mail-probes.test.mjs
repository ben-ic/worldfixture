import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { parseMailMessage, probeMailWorld, readImapMailbox } from "./coupling-mail-probes.mjs";

function fixture() {
  const people = [{ id: "sender", name: "Sender", email: "sender@odd.test", primary: true }, { id: "reader", name: "Reader", email: "reader@odd.test" }];
  const message = { id: "record-1", from_id: "sender", to_ids: ["reader"], subject: "Seeded note", body_text: "Complete body.", sent_at: "2031-01-02T10:11:12Z", labels: ["SENT", "UNREAD"] };
  const artifact = { world: { id: "odd", version: "v1", people, organizations: [{ primary: true, domain: "odd.test" }], communication: { mail: [message], resolved_mail: [message] }, timeline: [] },
    projections: { mail: { users: people.map(person => ({ ...person, login: person.email, password_ref: `mail-password:${person.id}` })), messages: [message] } } };
  const credentials = { world: { id: "odd", version: "v1" }, values: { "mail-password:sender": "sender-password", "mail-password:reader": "reader-password" } };
  const bindings = { IMAP_HOST_PORT: "127.0.0.1:1234" };
  const raw = ["Message-ID: <record-1@odd.test>", "X-WorldFixture-Record: record-1", "X-WorldFixture-Labels: SENT, UNREAD",
    "From: Sender <sender@odd.test>", "To: Reader <reader@odd.test>", "Subject: Seeded note", "Date: Thu, 02 Jan 2031 10:11:12 +0000",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", "Complete body.", ""].join("\r\n");
  const calls = [];
  const readMailbox = async ({ login, password, mailbox }) => {
    calls.push({ login, password, mailbox });
    const hasMessage = login === "reader@odd.test" && mailbox === "INBOX" || login === "sender@odd.test" && mailbox === "Sent";
    return { mailbox, exists: hasMessage ? 1 : 0, messages: hasMessage ? [{ seq: 1, flags: mailbox === "Sent" ? ["\\Seen"] : [], ...parseMailMessage(raw) }] : [] };
  };
  return { artifact, credentials, bindings, readMailbox, calls, raw };
}

test("reads every source person's inbox and sent mail using their own run credential", async () => {
  const input = fixture();
  const result = await probeMailWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.equal(input.calls.length, 4);
  assert.ok(input.calls.some(call => call.login === "reader@odd.test" && call.password === "reader-password"));
  assert.equal(result.responses.length, 4);
  assert.equal(JSON.stringify(result).includes("reader-password"), false);
  assert.ok(result.coverage.every(row => row.status === "passed"));
});

test("a missing source mailbox cannot be hidden by its missing projection", async () => {
  const input = fixture();
  input.artifact.projections.mail.users.pop();
  const result = await probeMailWorld(input);
  assert.equal(result.checks.find(check => check.check === "mail.projection.people").status, "failed");
  assert.equal(result.checks.find(check => check.check === "mail.reader.INBOX.read").status, "failed");
  assert.ok(result.coverage.every(row => row.status === "failed"));
});

test("credentials from another world are rejected before reading mailboxes", async () => {
  const input = fixture();
  input.credentials.world.id = "foreign-world";
  const result = await probeMailWorld(input);
  assert.equal(input.calls.length, 0);
  assert.equal(result.checks.find(check => check.check === "mail.credentials-world").status, "failed");
});

test("missing source mail fails both projection and complete server record checks", async () => {
  const input = fixture();
  input.artifact.projections.mail.messages = [];
  input.readMailbox = async ({ mailbox }) => ({ mailbox, exists: 0, messages: [] });
  const result = await probeMailWorld(input);
  assert.equal(result.checks.find(check => check.check === "mail.projection.messages").status, "failed");
  assert.equal(result.checks.find(check => check.check === "mail.reader.INBOX.records").status, "failed");
});

test("a changed body and a partial fetch fail independently of record identity", async () => {
  const input = fixture(), read = input.readMailbox;
  input.readMailbox = async options => {
    const response = await read(options);
    if (response.messages.length) response.messages[0].body_text = "Foreign content.";
    return { ...response, exists: response.exists + 1 };
  };
  const result = await probeMailWorld(input);
  assert.equal(result.checks.find(check => check.check === "mail.reader.INBOX.fields.record-1").status, "failed");
  assert.equal(result.checks.find(check => check.check === "mail.reader.INBOX.complete").status, "failed");
});

test("only due exact authored SMTP arrivals are allowed beyond seed records", async () => {
  const input = fixture(), read = input.readMailbox;
  input.artifact.world.timeline = [{ id: "arrival-1", kind: "incoming-email", after_seconds: 10,
    payload: { from_id: "sender", to_id: "reader", subject: "Arrival", body_text: "New content." } }];
  input.readMailbox = async options => {
    const response = await read(options);
    if (options.login === "reader@odd.test" && options.mailbox === "INBOX") response.messages.push({ seq: 2, flags: [], headers: {
      "x-worldfixture-arrival": "arrival-1", from: "sender@odd.test", to: "reader@odd.test", subject: "Arrival",
    }, body_text: "New content.\n" });
    return { ...response, exists: response.messages.length };
  };
  const early = await probeMailWorld({ ...input, elapsedMs: 9999 });
  assert.equal(early.checks.find(check => check.check === "mail.reader.INBOX.unexpected").status, "failed");
  const due = await probeMailWorld({ ...input, elapsedMs: () => 10000 });
  assert.deepEqual(due.checks.filter(check => check.status === "failed"), []);
});

test("mailbox failure details cannot expose the run password", async () => {
  const input = fixture();
  input.readMailbox = async ({ password }) => { throw new Error(`rejected ${password}`); };
  const result = await probeMailWorld(input);
  assert.equal(JSON.stringify(result).includes("reader-password"), false);
  assert.equal(result.checks.find(check => check.check === "provider.mail.read").status, "failed");
});

test("IMAP reader fetches all records and respects UTF-8 literal byte lengths", async t => {
  const { raw } = fixture();
  // A tagged-looking body line must remain message content, not a command reply.
  const bytes = Buffer.from(raw.replace("Complete body.", "Snowman ☃\r\nc3 OK fake completion"));
  const commands = [];
  const server = createServer(socket => {
    socket.write("* OK local test\r\n");
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      for (;;) {
        const end = input.indexOf("\r\n");
        if (end < 0) break;
        const line = input.slice(0, end); input = input.slice(end + 2);
        commands.push(line);
        const tag = line.split(" ")[0];
        if (line.includes(" LOGIN ")) socket.write(`${tag} OK logged in\r\n`);
        else if (line.includes(" EXAMINE ")) socket.write(`* 25 EXISTS\r\n${tag} OK examined\r\n`);
        else if (line.includes(" FETCH ")) {
          for (let seq = 1; seq <= 25; seq++) {
            socket.write(`* ${seq} FETCH (UID ${seq} FLAGS (\\Seen) BODY[] {${bytes.length}}\r\n`);
            socket.write(bytes.subarray(0, 17)); socket.write(bytes.subarray(17)); socket.write(")\r\n");
          }
          socket.write(`${tag} OK complete\r\n`);
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await readImapMailbox({ address: `127.0.0.1:${server.address().port}`, login: "reader", password: "secret", mailbox: "INBOX", timeoutMs: 1000 });
  assert.equal(result.messages.length, 25);
  assert.ok(commands.some(command => command.includes("FETCH 1:25 (UID FLAGS BODY.PEEK[])")));
  assert.match(result.messages[24].body_text, /Snowman ☃\nc3 OK fake completion/);
});

test("IMAP stalled command fails within its timeout", async t => {
  const server = createServer(socket => { socket.write("* OK local test\r\n"); socket.on("data", () => {}); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(readImapMailbox({ address: `127.0.0.1:${server.address().port}`, login: "reader", password: "secret", mailbox: "INBOX", timeoutMs: 30 }), /exceeded/);
});
