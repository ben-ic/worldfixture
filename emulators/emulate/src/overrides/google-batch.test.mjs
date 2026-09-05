import assert from "node:assert/strict";
import test from "node:test";

import { wrapGoogleBatch } from "./google-batch.mjs";

function request(parts, boundary = "batch_boundary") {
  const body = [
    ...parts.map((target) =>
      `--${boundary}\r\nContent-Type: application/http\r\n\r\nGET ${target}\r\n\r\n`,
    ),
    `--${boundary}--`,
  ].join("");
  return new Request("http://google.test/batch/gmail/v1", {
    method: "POST",
    headers: {
      authorization: "Bearer seeded-token",
      "content-type": `multipart/mixed; boundary=${boundary}`,
    },
    body,
  });
}

test("Gmail batch dispatches relative GETs and returns multipart responses", async () => {
  const seen = [];
  const fetch = wrapGoogleBatch(async (inner) => {
    seen.push({ url: inner.url, authorization: inner.headers.get("authorization") });
    return Response.json({ id: new URL(inner.url).pathname.split("/").at(-1) });
  });

  const response = await fetch(request([
    "/gmail/v1/users/me/messages/a",
    "/gmail/v1/users/me/messages/b?format=metadata",
  ]));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^multipart\/mixed; boundary=/);
  const body = await response.text();
  assert.match(body, /HTTP\/1\.1 200 OK/);
  assert.match(body, /{"id":"a"}/);
  assert.match(body, /{"id":"b"}/);
  assert.deepEqual(seen, [
    { url: "http://google.test/gmail/v1/users/me/messages/a", authorization: "Bearer seeded-token" },
    { url: "http://google.test/gmail/v1/users/me/messages/b?format=metadata", authorization: "Bearer seeded-token" },
  ]);
});

test("Gmail batch rejects absolute and non-Gmail inner requests", async () => {
  const fetch = wrapGoogleBatch(() => assert.fail("inner handler must not run"));
  for (const target of ["https://example.com/", "/oauth2/token"]) {
    const response = await fetch(request([target]));
    assert.equal(response.status, 400);
  }
});

test("Gmail batch rejects more than 100 requests", async () => {
  const fetch = wrapGoogleBatch(() => assert.fail("inner handler must not run"));
  const targets = Array.from({ length: 101 }, (_, index) => `/gmail/v1/users/me/messages/${index}`);
  assert.equal((await fetch(request(targets))).status, 400);
});

// Closes: the sub-response status line was built with `response.statusText ||
// "OK"`, and Hono leaves `statusText` an empty string on everything it builds --
// so EVERY part said `OK` whatever its code. Measured against the running
// fixture: a batch asking for a message that does not exist came back as
// `HTTP/1.1 404 OK`.
test("a failing batch part carries its own reason phrase, not OK", async () => {
  const fetch = wrapGoogleBatch(async (inner) => {
    const id = new URL(inner.url).pathname.split("/").at(-1);
    if (id === "missing") return Response.json({ error: { code: 404 } }, { status: 404 });
    if (id === "forbidden") return Response.json({ error: { code: 403 } }, { status: 403 });
    return Response.json({ id });
  });

  const body = await (await fetch(request([
    "/gmail/v1/users/me/messages/ok",
    "/gmail/v1/users/me/messages/missing",
    "/gmail/v1/users/me/messages/forbidden",
  ]))).text();

  const statusLines = body.split("\r\n").filter((line) => line.startsWith("HTTP/1.1"));
  assert.deepEqual(statusLines, ["HTTP/1.1 200 OK", "HTTP/1.1 404 Not Found", "HTTP/1.1 403 Forbidden"]);
});

// A code with no canonical phrase gets an empty one, which HTTP allows. Borrowing
// somebody else's phrase is what caused the bug in the first place.
test("an unlisted status code gets an empty reason phrase rather than a wrong one", async () => {
  const fetch = wrapGoogleBatch(async () => new Response("{}", { status: 418 }));
  const body = await (await fetch(request(["/gmail/v1/users/me/messages/teapot"]))).text();
  assert.ok(body.includes("HTTP/1.1 418 \r\n"), body.split("\r\n").filter((l) => l.startsWith("HTTP")).join("|"));
});
