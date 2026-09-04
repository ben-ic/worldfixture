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
