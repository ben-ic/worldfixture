import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { join } from "node:path";

import {
  sanitizeNotionInspection,
  sanitizePublicBindings,
  selectNotionWebhookReveal,
  startWorkbench,
  workbenchWebhookSecretRevealEnabled,
} from "./workbench.mjs";

const ROOT = join(import.meta.dirname, "../..");

test("Workbench browser bindings contain addresses but no credentials", () => {
  assert.deepEqual(sanitizePublicBindings({
    NOTION_BASE_URL: "http://127.0.0.1:4716",
    NOTION_ADMIN_BASE_URL: "http://127.0.0.1:4716",
    IMAP_HOST_PORT: "127.0.0.1:1143",
    IMAP_USERNAME: "maya@example.test",
    SITE_BASE_URL: "http://127.0.0.1:8080",
    NOTION_TOKEN: "notion-rest-secret",
    NOTION_ADMIN_TOKEN: "notion-admin-secret",
    IMAP_PASSWORD: "mail-secret",
    AWS_ACCESS_KEY: "access-key",
  }), {
    NOTION_BASE_URL: "http://127.0.0.1:4716",
    NOTION_ADMIN_BASE_URL: "http://127.0.0.1:4716",
    IMAP_HOST_PORT: "127.0.0.1:1143",
    IMAP_USERNAME: "maya@example.test",
    SITE_BASE_URL: "http://127.0.0.1:8080",
  });
});

test("Notion inspection state hides webhook secrets and full signatures", () => {
  const result = sanitizeNotionInspection({
    webhook_subscriptions: [{ notion_id: "subscription-1", status: "pending", verification_token: "verify-secret" }],
    webhook_verification_deliveries: [{ notion_id: "verification-1", raw_body: '{"verification_token":"verify-secret"}' }],
    webhook_deliveries: [{ notion_id: "delivery-1", signature: "sha256=1234567890abcdef1234567890abcdef", headers: { "X-Notion-Signature": "sha256=1234567890abcdef1234567890abcdef", "Content-Type": "application/json" } }],
  });
  assert.equal(result.webhook_subscriptions[0].verification_token, undefined);
  assert.equal(result.webhook_verification_deliveries, undefined);
  assert.equal(result.webhook_deliveries[0].signature, undefined);
  assert.equal(result.webhook_deliveries[0].headers["X-Notion-Signature"], undefined);
  assert.equal(result.webhook_deliveries[0].headers["Content-Type"], "application/json");
  assert.match(result.webhook_deliveries[0].signature_fingerprint, /^sha256=/);
  assert.doesNotMatch(JSON.stringify(result), /verify-secret|1234567890abcdef1234567890abcdef/);
});

test("webhook value reveal is an explicit environment switch", () => {
  assert.equal(workbenchWebhookSecretRevealEnabled(undefined), false);
  assert.equal(workbenchWebhookSecretRevealEnabled("0"), false);
  assert.equal(workbenchWebhookSecretRevealEnabled("true"), false);
  assert.equal(workbenchWebhookSecretRevealEnabled("1"), true);
});

test("webhook reveal returns only the selected verification token or captured request", () => {
  const inspection = {
    webhook_subscriptions: [
      { notion_id: "subscription-1", verification_token: "verify-secret", url: "https://example.test/notion" },
    ],
    webhook_verification_deliveries: [
      { notion_id: "verification-1", raw_body: '{"verification_token":"verify-secret"}', payload: { verification_token: "verify-secret" }, headers: { "X-Notion-Signature": "sha256=setup" }, status: "captured" },
    ],
    webhook_deliveries: [
      { notion_id: "delivery-1", raw_body: '{"type":"page.created"}', payload: { type: "page.created" }, headers: { "X-Notion-Signature": "sha256=event" }, status: "captured" },
    ],
  };

  assert.deepEqual(selectNotionWebhookReveal(inspection, { kind: "verification_token", id: "subscription-1" }), {
    kind: "verification_token", id: "subscription-1", verification_token: "verify-secret",
  });
  assert.deepEqual(selectNotionWebhookReveal(inspection, { kind: "delivery", id: "delivery-1" }), {
    kind: "delivery", id: "delivery-1", headers: { "X-Notion-Signature": "sha256=event" },
    raw_body: '{"type":"page.created"}', payload: { type: "page.created" },
  });
  assert.equal(selectNotionWebhookReveal(inspection, { kind: "delivery", id: "missing" }), null);
  assert.equal(selectNotionWebhookReveal(inspection, { kind: "unsupported", id: "delivery-1" }), null);
});

test("Workbench enforces the reveal switch and sends no-store reveal responses", async () => {
  const provider = createServer((request, response) => {
    assert.equal(request.url, "/__worldfixture/notion-admin");
    assert.equal(request.headers.authorization, "Bearer notion-token");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      webhook_subscriptions: [{ notion_id: "subscription-1", verification_token: "verify-secret" }],
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const state = { prepare: () => ({ get: () => ({ seq: 0 }) }) };
  const instance = { state, applicationBindings: { NOTION_BASE_URL: providerUrl, NOTION_TOKEN: "notion-token" }, bindings: () => ({}) };
  const options = { artifactPath: join(ROOT, "dist/business.saas-company.v3"), stateDir: ROOT };
  const disabled = await startWorkbench(instance, { ...options, revealWebhookSecrets: false });
  const enabled = await startWorkbench(instance, { ...options, revealWebhookSecrets: true });
  try {
    const refused = await fetch(`${disabled.url}/api/inspect/notion/webhook-value`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "verification_token", id: "subscription-1" }),
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get("cache-control"), "no-store");

    const accepted = await fetch(`${enabled.url}/api/inspect/notion/webhook-value`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "verification_token", id: "subscription-1" }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("cache-control"), "no-store");
    assert.equal((await accepted.json()).result.verification_token, "verify-secret");
  } finally {
    await disabled.close();
    await enabled.close();
    await new Promise((resolve) => provider.close(resolve));
  }
});
