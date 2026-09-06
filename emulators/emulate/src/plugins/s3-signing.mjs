// Shared by the composer and runtime; included in both standalone distributions.
import { createHash, createHmac } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function bodyBytes(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("S3 signing requires a string or complete byte buffer body");
}

export function signS3Request(target, init = {}, { accessKeyId, secretAccessKey, region, date = new Date() } = {}) {
  if (![accessKeyId, secretAccessKey, region].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("S3 requests require this run's access key, secret key, and region");
  }
  const url = new URL(target);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid S3 HTTP endpoint");
  const method = (init.method ?? "GET").toUpperCase();
  const payloadHash = hash(bodyBytes(init.body));
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = timestamp.slice(0, 8);
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.set("host", url.host);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", timestamp);
  const entries = [...headers].map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")]).sort(([a], [b]) => compare(a, b));
  const names = entries.map(([name]) => name).join(";");
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join("");
  // S3 preserves repeated slashes and percent-encoded object-key bytes.
  const path = url.pathname.split("/").map(segment => encode(decodeURIComponent(segment))).join("/");
  const query = [...url.searchParams].map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak, av], [bk, bv]) => compare(ak, bk) || compare(av, bv)).map(([key, value]) => `${key}=${value}`).join("&");
  const scope = `${day}/${region}/s3/aws4_request`;
  const canonical = [method, path, query, canonicalHeaders, names, payloadHash].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = hmac(signingKey, ["AWS4-HMAC-SHA256", timestamp, scope, hash(canonical)].join("\n")).toString("hex");
  headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names},Signature=${signature}`);
  return { ...init, method, headers: Object.fromEntries(headers) };
}

export function s3Fetch(target, init, bindings, fetchImpl = globalThis.fetch) {
  return fetchImpl(target, signS3Request(target, init, {
    accessKeyId: bindings?.S3_ACCESS_KEY_ID,
    secretAccessKey: bindings?.S3_SECRET_ACCESS_KEY,
    region: bindings?.S3_REGION,
  }));
}
