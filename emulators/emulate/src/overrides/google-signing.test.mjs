import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleSigningOverride } from "./google-signing.mjs";

const jwksRequest = new Request("http://google.test/oauth2/v3/certs");
const inner = () => new Response("not used", { status: 404 });

test("a restored signing key serves the exact accepted JWKS", async () => {
  const first = await createGoogleSigningOverride();
  const accepted = await first(inner)(jwksRequest).then((response) => response.text());

  const restored = await createGoogleSigningOverride({
    privateJwk: first.privateJwk,
  });
  const afterReset = await restored(inner)(jwksRequest).then((response) => response.text());

  assert.equal(afterReset, accepted);
  assert.ok(first.privateJwk.d, "the saved JWK contains the private key");
  assert.equal(JSON.parse(afterReset).keys[0].d, undefined, "the public JWKS does not expose it");
});

test("the signing wrapper preserves the OAuth access token", async () => {
  const wrap = await createGoogleSigningOverride();
  const request = new Request("http://google.test/oauth2/token", { method: "POST" });
  const response = await wrap(() => Response.json({ access_token: "google_oauth_token", token_type: "Bearer" }))(request);

  assert.equal((await response.json()).access_token, "google_oauth_token");
});
