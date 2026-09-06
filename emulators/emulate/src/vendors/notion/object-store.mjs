import { signS3Request } from "../../plugins/s3-signing.mjs";

function objectUrl(baseUrl, bucket, key) {
  const path = String(key).split("/").map(encodeURIComponent).join("/");
  return `${String(baseUrl).replace(/\/$/, "")}/${encodeURIComponent(bucket)}/${path}`;
}

function storageError(operation, response) {
  const error = new Error(`The object store refused ${operation} with HTTP ${response.status}.`);
  error.code = "internal_server_error";
  error.status = response.status;
  return error;
}

export function createNotionObjectStore(baseUrl, fetchImpl = globalThis.fetch, credentials = {
  accessKeyId: process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_ACCESS_KEY_ID,
  secretAccessKey: process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_SECRET_ACCESS_KEY,
  region: process.env.WORLDFIXTURE_NOTION_OBJECT_STORE_REGION,
}) {
  const request = (url, init = {}) => fetchImpl(url, signS3Request(url, init, credentials));
  const available = typeof baseUrl === "string" && baseUrl.length > 0;
  const requireStore = () => {
    if (available) return;
    const error = new Error("The Notion File Upload profile needs its object-store capability.");
    error.code = "not_implemented";
    throw error;
  };

  return {
    available,
    async put({ bucket, key, bytes, contentType, owner }) {
      requireStore();
      const response = await request(objectUrl(baseUrl, bucket, key), {
        method: "PUT",
        headers: {
          "content-type": contentType || "application/octet-stream",
          ...(owner ? { "x-amz-meta-worldfixture-owner": owner } : {}),
        },
        body: bytes,
      });
      if (!response.ok) throw storageError("PutObject", response);
      return { etag: response.headers.get("etag") };
    },
    async get({ bucket, key }) {
      requireStore();
      const response = await request(objectUrl(baseUrl, bucket, key));
      if (response.status === 404) return null;
      if (!response.ok) throw storageError("GetObject", response);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
      };
    },
    async delete({ bucket, key }) {
      requireStore();
      const response = await request(objectUrl(baseUrl, bucket, key), { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw storageError("DeleteObject", response);
    },
  };
}

export { objectUrl };
