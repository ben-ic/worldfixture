import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { putS3Object, s3BucketDetails, s3Buckets } from "./provider-client.mjs";

test("example S3 lists and writes use the run signature and exact payload", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return new Response("<ListBucketResult><Key>file.txt</Key></ListBucketResult>", { headers: { etag: "test" } });
  });
  const bindings = { S3_BASE_URL: "http://localhost:4321", S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret", S3_REGION: "us-east-1" };
  await s3Buckets(bindings);
  await s3BucketDetails(bindings);
  await putS3Object(bindings, "bucket", "file.json", { text: "café" });
  assert.equal(requests.length, 5);
  for (const { init } of requests) {
    assert.match(init.headers.authorization, /Credential=test-access\/\d{8}\/us-east-1\/s3\/aws4_request/);
    assert.equal(init.headers.host, "localhost:4321");
    assert.equal(init.headers["x-amz-content-sha256"], createHash("sha256").update(init.body ?? "").digest("hex"));
  }
  assert.equal(requests[4].init.method, "PUT");
  assert.equal(requests[4].init.body, JSON.stringify({ text: "café" }, null, 2));
});
