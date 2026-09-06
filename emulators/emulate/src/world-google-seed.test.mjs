import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "@emulators/google";
import { googleWorldMessageId, prepareWorldGoogleSeed, seedWorldGoogle } from "./world-google-seed.mjs";

const world = { id: "consumer.unusual", version: "v7", digest: "a".repeat(64) };
function fixture() {
  const users = ["one", "two", "empty"].map(id => ({ worldfixture_person_id: id, name: id, email: `${id}@fixture.test` }));
  const messages = ["one", "two"].flatMap(owner => ["shared", "second"].map(id => ({
    worldfixture_message_id: id, worldfixture_owner_id: owner, user_email: `${owner}@fixture.test`,
    thread_id: `thread-${id}`, from: "Sender <sender@fixture.test>", to: "one@fixture.test, two@fixture.test",
    subject: `Subject ${id}`, snippet: `Body ${id}`, body_text: `Body ${id}`, date: "2031-02-03T04:05:06Z", label_ids: ["INBOX", "Orders"],
  })));
  const tokensByPerson = Object.fromEntries(users.map(user => [user.worldfixture_person_id, `scratch-${user.worldfixture_person_id}`]));
  const server = createServer(googlePlugin, { tokens: Object.fromEntries(users.map((user, index) => [tokensByPerson[user.worldfixture_person_id], { login: user.email, id: index + 1, scopes: [] }])) });
  const calls = [], mutations = [];
  const labels = ["one", "two"].map(owner => ({ user_email: `${owner}@fixture.test`, id: "Orders", name: "Orders" }));
  labels.push({ user_email: "empty@fixture.test", id: "Future", name: "Future" });
  const options = { world, config: { users, messages, labels, calendars: [], calendar_events: [] },
    arrivals: [{ worldfixture_owner_id: "empty", label_ids: ["INBOX", "Future"] }], tokensByPerson,
    baseUrl: "http://google.test", pageSize: 1,
    seedFromConfig: config => { mutations.push(config); seedFromConfig(server.store, "http://google.test", config); },
    fetchImpl: (url, init) => { calls.push(String(url)); return server.app.fetch(new Request(url, init)); },
  };
  return { server, options, calls, mutations };
}

test("Google seeds every owner, shared messages, empty identity and future-only labels through pinned routes", async () => {
  const env = fixture();
  const receipt = await seedWorldGoogle(env.options);
  assert.equal(receipt.mailboxes.length, 3);
  assert.equal(receipt.messages.length, 4);
  assert.equal(new Set(receipt.messages.map(row => row.provider_message_id)).size, 4);
  assert.ok(env.calls.some(path => path.includes("pageToken=")), "all mailbox pages must be read");
  assert.ok(env.calls.some(path => path.includes("empty%40fixture.test/labels")));
  assert.ok(env.mutations[0].labels.some(label => label.user_email === "empty@fixture.test" && label.name === "Future"));
  assert.ok(receipt.labels.some(label => label.source_person_id === "empty" && label.source_label_id === "Future" && label.provider_label_id === "Future"));
  assert.equal(JSON.stringify(receipt).includes("scratch-"), false, "receipt must not contain credentials");
  assert.equal(receipt.messages[0].provider_message_id, googleWorldMessageId(world, "one", "shared"));
});

test("Google accepted snapshot and receipt restore without seeding or changing provider identities", async () => {
  const env = fixture();
  const receipt = await seedWorldGoogle(env.options);
  const restored = fixture();
  restored.server.store.restore(env.server.store.snapshot());
  const result = await seedWorldGoogle({ ...restored.options, receipt: JSON.parse(JSON.stringify(receipt)),
    seedFromConfig() { assert.fail("restore must not reseed"); } });
  assert.deepEqual(result, receipt);
  await assert.rejects(seedWorldGoogle({ ...restored.options, receipt: { ...receipt, world: { ...world, digest: "b".repeat(64) } } }), /saved receipt/);
});

test("Google missing and foreign-owner credentials cannot pass verification", async () => {
  const absent = fixture();
  delete absent.options.tokensByPerson.empty;
  await assert.rejects(seedWorldGoogle(absent.options), /credential for empty/);
  assert.equal(absent.mutations.length, 0, "missing credentials fail before seed writes");
  const wrong = fixture();
  wrong.options.tokensByPerson.two = wrong.options.tokensByPerson.one;
  await assert.rejects(seedWorldGoogle(wrong.options), /credential identity for two/);
});

test("Google detects missing, foreign and changed served mail independently of the receipt", async t => {
  for (const damage of ["missing", "foreign", "body"]) await t.test(damage, async () => {
    const env = fixture(), fetchImpl = env.options.fetchImpl;
    await assert.rejects(seedWorldGoogle({ ...env.options, fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init), data = await response.json();
      if (new URL(url).pathname.endsWith("/messages") && data.messages?.length) {
        if (damage === "missing") data.messages = [];
        if (damage === "foreign") data.messages[0].id = "foreign-message";
      }
      if (damage === "body" && data.payload) data.payload = { ...data.payload, mimeType: "text/plain", body: { data: Buffer.from("Changed").toString("base64url") } };
      return Response.json(data, { status: response.status });
    } }), /verification failed/);
  });
});

test("Google API failures and repeated pagination cursors abort verification", async () => {
  const env = fixture();
  await assert.rejects(seedWorldGoogle({ ...env.options, fetchImpl: async () => new Response("down", { status: 503 }) }), /HTTP 503/);
  const repeated = fixture(), fetchImpl = repeated.options.fetchImpl;
  await assert.rejects(seedWorldGoogle({ ...repeated.options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (!new URL(url).pathname.endsWith("/messages")) return response;
    const data = await response.json(); data.nextPageToken = "same";
    return Response.json(data);
  } }), /cursor did not advance/);
});

test("Google preparation rejects ambiguous source ownership and retains input bytes", () => {
  const env = fixture(), before = JSON.stringify(env.options.config);
  prepareWorldGoogleSeed(env.options);
  assert.equal(JSON.stringify(env.options.config), before);
  const duplicate = structuredClone(env.options.config);
  duplicate.messages.push(duplicate.messages[0]);
  assert.throws(() => prepareWorldGoogleSeed({ ...env.options, config: duplicate }), /Duplicate Google source message/);
  const wrong = structuredClone(env.options.config);
  wrong.messages[0].user_email = "other@fixture.test";
  assert.throws(() => prepareWorldGoogleSeed({ ...env.options, config: wrong }), /mismatched.*owner/);
});

test("an empty declared Google service does not call the fallback seed or require a token", async () => {
  const result = await seedWorldGoogle({ world, config: { users: [], messages: [] }, baseUrl: "http://google.test",
    seedFromConfig() { assert.fail("empty seed would create sample-owned labels"); },
    fetchImpl() { assert.fail("no mailbox was declared"); }, tokensByPerson: {} });
  assert.deepEqual(result.mailboxes, []);
  assert.deepEqual(result.messages, []);
});

test("cancellation before Google seeding leaves initialization untouched", async () => {
  const env = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(seedWorldGoogle({ ...env.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(env.mutations.length, 0);
});

test("custom labels must be declared for each owner before seed writes", async () => {
  for (const context of ["message", "arrival", "other-owner"]) {
    const env = fixture();
    if (context === "message") env.options.config.messages[0].label_ids.push("Undeclared");
    if (context === "arrival") env.options.arrivals[0].label_ids.push("Undeclared");
    if (context === "other-owner") env.options.arrivals[0].label_ids.push("Orders");
    await assert.rejects(seedWorldGoogle(env.options), /Undeclared Google custom label/);
    assert.equal(env.mutations.length, 0);
  }
});

test("SMTP arrivals do not require Gmail mailbox owners or labels", async () => {
  const env = fixture();
  env.options.arrivals.push({ via: "smtp", worldfixture_owner_id: "smtp-only", label_ids: ["SMTPOnly"] });
  const receipt = await seedWorldGoogle(env.options);
  assert.equal(receipt.mailboxes.length, 3);
  assert.equal(receipt.labels.some(label => label.name === "SMTPOnly"), false);
});

test("an explicit mailbox subset seeds only selected owners", async () => {
  const env = fixture();
  env.options.config.users = env.options.config.users.filter(user => user.worldfixture_person_id === "empty");
  env.options.config.messages = [];
  env.options.config.labels = env.options.config.labels.filter(label => label.user_email === "empty@fixture.test");
  const receipt = await seedWorldGoogle(env.options);
  assert.deepEqual(receipt.mailboxes, [{ source_person_id: "empty", email: "empty@fixture.test" }]);
  assert.equal(env.calls.some(path => path.includes("one%40")), false);
});

function driveFixture() {
  const env = fixture();
  env.options.config.drive_items = ["one", "one", "two"].map((owner, index) => ({
    id: `doc-${index}`, worldfixture_document_id: `doc-${index}`, worldfixture_owner_id: owner,
    user_email: `${owner}@fixture.test`, name: `Document ${index}.md`, mime_type: "text/markdown",
    data: `# Héllo ${owner}\n\nExact content ${index}.\n`,
  }));
  return env;
}

test("Drive serves exact source content only to its declared owner and preserves reset IDs", async () => {
  const env = driveFixture(), receipt = await seedWorldGoogle(env.options);
  assert.equal(receipt.drive_items.length, 3);
  assert.ok(env.calls.some(url => url.includes("/drive/v3/files?") && url.includes("pageToken=")));
  const response = await env.options.fetchImpl("http://google.test/drive/v3/files/doc-0?alt=media", {
    headers: { authorization: `Bearer ${env.options.tokensByPerson.two}` },
  });
  assert.equal(response.status, 404, "another owner's Drive file must not be visible");
  const restored = driveFixture();
  restored.server.store.restore(env.server.store.snapshot());
  assert.deepEqual(await seedWorldGoogle({ ...restored.options, receipt,
    seedFromConfig() { assert.fail("Drive reset must only read"); } }), receipt);
});

test("Drive rejects missing, foreign and changed public content", async t => {
  for (const damage of ["missing", "foreign", "body", "metadata"]) await t.test(damage, async () => {
    const env = driveFixture(), fetchImpl = env.options.fetchImpl;
    await assert.rejects(seedWorldGoogle({ ...env.options, fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init), path = new URL(url);
      if (!path.pathname.startsWith("/drive/")) return response;
      if (path.searchParams.get("alt") === "media") return damage === "body" ? new Response("changed") : response;
      const data = await response.json();
      if (damage === "missing" && data.files?.length) data.files = [];
      if (damage === "foreign" && data.files?.length) data.files[0].id = "foreign";
      if (damage === "metadata" && data.id) data.name = "changed";
      return Response.json(data, { status: response.status });
    } }), /verification failed.*Drive/);
  });
});

test("Drive repeated pagination, HTTP failures and excluded owners fail verification", async () => {
  const env = driveFixture(), fetchImpl = env.options.fetchImpl;
  await assert.rejects(seedWorldGoogle({ ...env.options, fetchImpl: async (url, init) => {
    const response = await fetchImpl(url, init);
    if (new URL(url).pathname !== "/drive/v3/files") return response;
    const data = await response.json(); data.nextPageToken = "same";
    return Response.json(data);
  } }), /Drive pagination cursor did not advance/);
  const failed = driveFixture(), realFetch = failed.options.fetchImpl;
  await assert.rejects(seedWorldGoogle({ ...failed.options, fetchImpl: (url, init) =>
    new URL(url).pathname.startsWith("/drive/") ? Promise.resolve(new Response("down", { status: 503 })) : realFetch(url, init) }), /HTTP 503/);
  const absent = driveFixture();
  absent.options.config.drive_items[0].worldfixture_owner_id = "excluded";
  await assert.rejects(seedWorldGoogle(absent.options), /Unknown or mismatched.*excluded/);
  assert.equal(absent.mutations.length, 0);
});
