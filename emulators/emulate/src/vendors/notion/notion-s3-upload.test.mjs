import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";

import { createNotionDomain, seedNotion } from "./domain.mjs";
import { createNotionObjectStore } from "./object-store.mjs";
import { NOTION_VERSION, registerRestRoutes } from "./rest.mjs";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function memoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async put({ bucket, key, bytes, contentType, owner }) {
      objects.set(`${bucket}/${key}`, { bytes: new Uint8Array(bytes), contentType, owner });
      return { etag: "test-etag" };
    },
    async get({ bucket, key }) { return objects.get(`${bucket}/${key}`) ?? null; },
    async delete({ bucket, key }) { objects.delete(`${bucket}/${key}`); },
  };
}

function fixture() {
  const objectStore = memoryObjectStore();
  const plugin = {
    name: "notion-s3-test",
    register(app, store, _webhooks, baseUrl) { registerRestRoutes(app, store, baseUrl, { objectStore }); },
  };
  const server = createServer(plugin, {
    baseUrl: "http://notion.worldfixture.test",
    tokens: { full: { login: "maya@example.test", id: 1, scopes: ["read:content", "write:content"] } },
  });
  seedNotion(server.store, server.baseUrl, {
    object_store: { bucket: "northstar-relay-documents", prefix: "notion/uploads" },
    users: [{ id: USER_ID, name: "Maya", email: "maya@example.test" }],
  });
  return { ...server, objectStore };
}

const jsonHeaders = { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION, "content-type": "application/json" };

test("the S3 adapter sends bytes to an opaque world object key", async () => {
  const requests = [];
  const adapter = createNotionObjectStore("http://127.0.0.1:61006", async (url, init = {}) => {
    requests.push({ url, init });
    return new Response(null, { status: 200, headers: { etag: "stored" } });
  }, { accessKeyId: "test-access", secretAccessKey: "test-secret", region: "us-east-1" });
  await adapter.put({
    bucket: "northstar-relay-documents", key: "notion/uploads/upload 1/notes.txt",
    bytes: new TextEncoder().encode("content"), contentType: "text/plain", owner: USER_ID,
  });
  assert.equal(requests[0].url, "http://127.0.0.1:61006/northstar-relay-documents/notion/uploads/upload%201/notes.txt");
  assert.equal(requests[0].init.method, "PUT");
  assert.match(requests[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access\//);
  assert.match(requests[0].init.headers.authorization, /x-amz-meta-worldfixture-owner/);
  assert.equal(requests[0].init.headers["x-amz-meta-worldfixture-owner"], USER_ID);
  await adapter.get({ bucket: "northstar-relay-documents", key: "notion/uploads/upload 1/notes.txt" });
  await adapter.delete({ bucket: "northstar-relay-documents", key: "notion/uploads/upload 1/notes.txt" });
  assert.deepEqual(requests.map(row => row.init.method), ["PUT", "GET", "DELETE"]);
  assert.ok(requests.every(row => /^AWS4-HMAC-SHA256 Credential=test-access\//.test(row.init.headers.authorization)));
});

async function createUpload(app, input) {
  const response = await app.request("/v1/file_uploads", { method: "POST", headers: jsonHeaders, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  return response.json();
}

async function sendPart(app, id, content, partNumber) {
  const form = new FormData();
  form.set("file", new Blob([content], { type: "text/plain" }), "part.txt");
  if (partNumber !== undefined) form.set("part_number", String(partNumber));
  return app.request(`/v1/file_uploads/${id}/send`, {
    method: "POST", headers: { Authorization: "Bearer full", "Notion-Version": NOTION_VERSION }, body: form,
  });
}

test("single-part Notion uploads store bytes only in the shared object store", async () => {
  const { app, store, baseUrl, objectStore } = fixture();
  const upload = await createUpload(app, { filename: "notes.txt", content_type: "text/plain" });
  const response = await sendPart(app, upload.id, "world data");
  assert.equal(response.status, 200);
  const completed = await response.json();
  assert.equal(completed.status, "uploaded");
  assert.equal(completed.content_length, 10);

  const domain = createNotionDomain(store, baseUrl);
  const storage = domain.fileUploadStorage(upload.id, domain.userByLogin("maya@example.test"));
  const object = objectStore.objects.get(`${storage.bucket}/${storage.key}`);
  assert.equal(new TextDecoder().decode(object.bytes), "world data");
  assert.equal(object.owner, USER_ID);
  assert.equal(Object.hasOwn(storage, "bytes"), false);
});

test("multi-part completion combines S3 part objects and removes the temporary parts", async () => {
  const { app, store, baseUrl, objectStore } = fixture();
  const upload = await createUpload(app, { mode: "multi_part", filename: "joined.txt", content_type: "text/plain", number_of_parts: 2 });
  assert.equal((await sendPart(app, upload.id, "first ", 1)).status, 200);
  assert.equal((await sendPart(app, upload.id, "second", 2)).status, 200);
  const response = await app.request(`/v1/file_uploads/${upload.id}/complete`, { method: "POST", headers: jsonHeaders, body: "{}" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "uploaded");

  const domain = createNotionDomain(store, baseUrl);
  const storage = domain.fileUploadStorage(upload.id, domain.userByLogin("maya@example.test"));
  assert.equal(new TextDecoder().decode(objectStore.objects.get(`${storage.bucket}/${storage.key}`).bytes), "first second");
  assert.equal([...objectStore.objects.keys()].some((key) => key.includes(".parts/")), false);
});

test("MCP text attachments use the same object and can read it back", async () => {
  const { store, baseUrl, objectStore } = fixture();
  const domain = createNotionDomain(store, baseUrl, { objectStore });
  const actor = domain.userByLogin("maya@example.test");
  const attachment = await domain.mcpCreateAttachment({ filename: "agent.txt", content_type: "text/plain", content: "agent content" }, actor);
  const downloaded = await domain.mcpDownloadAttachment({ file_upload_id: attachment.file_upload.id }, actor);
  assert.equal(downloaded.content, "agent content");
  assert.equal(objectStore.objects.size, 1);
});
