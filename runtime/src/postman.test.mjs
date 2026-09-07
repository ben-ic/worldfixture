import assert from "node:assert/strict";
import test from "node:test";

import { postmanCollection } from "./postman.mjs";

const bindings = {
  WORKBENCH_URL: "http://127.0.0.1:58842",
  SLACK_BASE_URL: "http://127.0.0.1:58831", SLACK_TOKEN: "slack-token",
  GOOGLE_BASE_URL: "http://127.0.0.1:58833", GOOGLE_TOKEN: "google-token", GOOGLE_CLIENT_ID: "local-google", GOOGLE_CLIENT_SECRET: "local-google-secret",
  S3_BASE_URL: "http://127.0.0.1:58847", S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret", S3_REGION: "eu-west-2", S3_BUCKET: "documents",
};

test("Postman collection uses the active run and includes every route for selected HTTP surfaces", () => {
  const result = postmanCollection({ world: { id: "business.saas-company", version: "v3", title: "Northstar Relay" }, bindings,
    artifactPath: new URL("../../dist/business.saas-company.v3", import.meta.url).pathname });
  assert.equal(result.info.schema, "https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
  assert.deepEqual(result.item.map(item => item.name), ["WorldFixture", "Google", "Slack", "S3"]);
  assert.equal(result.item.find(item => item.name === "Google").item.length, 70);
  assert.equal(result.item.find(item => item.name === "Slack").item.length, 70);
  assert.equal(result.item.find(item => item.name === "World website API"), undefined);
  assert.equal(result.variable.find(item => item.key === "WORKBENCH_URL").value, "http://127.0.0.1:58842");
  assert.equal(result.variable.find(item => item.key === "SLACK_TOKEN").value, "slack-token");
  assert.match(JSON.stringify(result), /\{\{WORKBENCH_URL\}\}\/slack\/api\/auth\.test/);
  assert.match(JSON.stringify(result), /\{\{WORKBENCH_URL\}\}\/gmail\/v1\/users\/\{\{userId\}\}\/messages/);
  const oauth = result.item.find(item => item.name === "Google").item[0];
  assert.equal(oauth.name, "OAuth 2.0 — get a user token");
  assert.equal(oauth.request.auth.type, "oauth2");
  assert.match(JSON.stringify(oauth.request.auth), /oauth\.pstmn\.io\/v1\/browser-callback/);
  assert.equal(result.variable.find(item => item.key === "GOOGLE_CLIENT_ID").value, "local-google");
  assert.match(JSON.stringify(result), /\{\{WORKBENCH_URL\}\}\/slack\/api\/chat\.postMessage/);
  assert.match(JSON.stringify(result), /\{\{S3_BASE_URL\}\}\/\{\{S3_BUCKET\}\}/);
  assert.doesNotMatch(JSON.stringify(result), /GitHub/);
});

test("Postman collection includes every API operation declared by the world", () => {
  const result = postmanCollection({ world: { id: "business.saas-company", version: "v3" },
    bindings: { WORKBENCH_URL: "http://127.0.0.1:4715", SITE_BASE_URL: "http://127.0.0.1:4714" },
    artifactPath: new URL("../../dist/business.saas-company.v3", import.meta.url).pathname });
  const site = result.item.find(item => item.name === "World website API");
  assert.deepEqual(site.item.map(item => item.request.url), [
    "{{WORKBENCH_URL}}/site/openapi.json",
    "{{WORKBENCH_URL}}/site/api/v1/company",
    "{{WORKBENCH_URL}}/site/api/v1/status",
    "{{WORKBENCH_URL}}/site/api/v1/stories",
  ]);
});

test("Postman collection can use the address of an unmanaged Workbench", () => {
  const result = postmanCollection({ world: { id: "custom", version: "v1" }, bindings: {}, workbenchUrl: "http://127.0.0.1:4715" });
  assert.equal(result.variable.find(item => item.key === "WORKBENCH_URL").value, "http://127.0.0.1:4715");
});
