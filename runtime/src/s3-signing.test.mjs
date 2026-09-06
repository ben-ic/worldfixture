import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { s3Fetch, signS3Request } from "./s3-signing.mjs";

// AWS's published SigV4 S3 examples, independent of this implementation:
// https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1", date: new Date("2013-05-24T00:00:00Z") };
const signature = options => options.headers.authorization.split("Signature=")[1];

test("S3 GET and PUT signatures match the published AWS test vectors", () => {
  const get = signS3Request("https://examplebucket.s3.amazonaws.com/test.txt", { headers: { Range: "bytes=0-9" } }, credentials);
  assert.equal(signature(get), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  const put = signS3Request("https://examplebucket.s3.amazonaws.com/test$file.text", {
    method: "PUT", body: "Welcome to Amazon S3.", headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
  }, credentials);
  assert.equal(signature(put), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("S3 query signing sorts encoded parameters and preserves empty values", () => {
  const first = signS3Request("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2", {}, credentials);
  assert.equal(signature(first), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  const empty = signS3Request("https://examplebucket.s3.amazonaws.com/?lifecycle", {}, credentials);
  assert.equal(signature(empty), "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  assert.equal(signature(signS3Request("https://s3.test/a%20b/%E2%82%AC?z=+&a=%2B&a=", {}, credentials)),
    signature(signS3Request("https://s3.test/a%20b/%E2%82%AC?a=&z=%20&a=%2B", {}, credentials)));
});

test("S3 signing hashes the exact byte slice and signs object metadata", () => {
  const bytes = new Uint8Array([0, 255, 1, 2]).subarray(1, 3);
  const init = { method: "PUT", body: bytes, headers: { "x-amz-meta-owner": "person-1", "content-type": "application/octet-stream" } };
  const signed = signS3Request("http://localhost:61006/bucket/key", init, credentials);
  assert.equal(signed.body, bytes);
  assert.equal(signed.headers["x-amz-content-sha256"], createHash("sha256").update(bytes).digest("hex"));
  assert.match(signed.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-owner/);
  assert.deepEqual(init.headers, { "x-amz-meta-owner": "person-1", "content-type": "application/octet-stream" });
});

test("S3 refuses missing credentials before any network call", () => {
  let called = false;
  assert.throws(() => s3Fetch("http://s3.test/bucket", {}, {}, () => { called = true; }), /require this run/);
  assert.equal(called, false);
  assert.throws(() => signS3Request("http://s3.test/", { body: new ReadableStream() }, credentials), /complete byte buffer/);
});
