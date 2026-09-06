import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer } from "@emulators/core";
import { stripePlugin, seedFromConfig } from "@emulators/stripe";
import Stripe from "stripe";
import { extendStripePlugin, seedStripeBilling } from "../overrides/stripe-billing.mjs";
import { extendStripeTransactionsPlugin } from "../overrides/stripe-transactions.mjs";
import { extendStripeWebhooksPlugin, seedStripeWebhooks, STRIPE_WEBHOOK_API_VERSION } from "./stripe.mjs";

const official = JSON.parse(readFileSync(new URL("../../contracts/stripe/webhooks-2026-08-26.contract.json", import.meta.url), "utf8"));
function checkFieldInventory(object) {
  const schema = official.schemas[object.object];
  assert.ok(schema, object.object);
  for (const key of schema.required) assert.ok(Object.hasOwn(object, key), `${object.object}.${key} is required`);
  for (const key of Object.keys(object)) assert.ok(schema.properties.includes(key), `${object.object}.${key} is not in the pinned schema`);
}

async function fixture(t, receiver = () => 200) {
  const received = [];
  const listener = createHttpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const item = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
    received.push(item);
    res.writeHead(await receiver(item, received.length)); res.end();
  });
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const server = createServer(extendStripeWebhooksPlugin(extendStripeTransactionsPlugin(extendStripePlugin(stripePlugin)), { retryDelaysMs: [10, 10], timeoutMs: 100 }));
  t.after(async () => { server.webhooks.closeStripeWebhooks(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); });
  const sdk = new Stripe("sk_test_worldfixture", { apiVersion: STRIPE_WEBHOOK_API_VERSION,
    httpClient: Stripe.createFetchHttpClient((url, init) => server.app.request(url, init)), maxNetworkRetries: 0 });
  return { ...server, sdk, received, url: `http://127.0.0.1:${listener.address().port}/stripe` };
}

test("Stripe sends native Event POSTs that the official SDK verifies against raw bytes", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  const endpoint = await sdk.webhookEndpoints.create({ url, enabled_events: ["customer.created", "customer.updated"] });
  assert.match(endpoint.id, /^we_/); assert.match(endpoint.secret, /^whsec_/);
  assert.equal(endpoint.object, "webhook_endpoint");
  checkFieldInventory(JSON.parse(JSON.stringify(endpoint)));
  const customer = await sdk.customers.create({ name: "Zoë 東京", metadata: { key: "é" } }, { idempotencyKey: "create-customer-1" });
  await sdk.customers.update(customer.id, { name: "Changed" });
  await webhooks.flushStripeWebhooks();
  assert.equal(received.length, 2);
  const event = sdk.webhooks.constructEvent(received[0].body, received[0].headers["stripe-signature"], endpoint.secret);
  assert.equal(received[0].method, "POST");
  assert.match(received[0].headers["content-type"], /^application\/json/);
  assert.equal(received[0].headers["x-github-event"], undefined);
  assert.equal(event.object, "event"); assert.match(event.id, /^evt_/);
  checkFieldInventory(event); checkFieldInventory(event.data.object);
  assert.equal(event.api_version, STRIPE_WEBHOOK_API_VERSION);
  assert.equal(event.livemode, false); assert.equal(event.pending_webhooks, 1);
  assert.ok(Number.isInteger(event.created)); assert.match(event.request.id, /^req_/);
  assert.equal(event.request.id, customer.lastResponse.requestId);
  assert.equal(event.request.idempotency_key, "create-customer-1");
  assert.deepEqual(event.data.object, JSON.parse(JSON.stringify(customer)));
  assert.throws(() => sdk.webhooks.constructEvent(received[0].body + " ", received[0].headers["stripe-signature"], endpoint.secret));
  assert.throws(() => sdk.webhooks.constructEvent(received[0].body, received[0].headers["stripe-signature"], "whsec_wrong"));
  const updated = JSON.parse(received[1].body);
  assert.deepEqual(updated.data.previous_attributes, { name: "Zoë 東京" });
  assert.equal(updated.data.object.name, "Changed");
  const fetched = await sdk.events.retrieve(event.id);
  assert.equal(fetched.pending_webhooks, 0); assert.deepEqual(fetched.data, event.data);
  assert.equal((await sdk.events.list({ type: "customer.created" })).data[0].id, event.id);
  assert.equal((await sdk.webhookEndpoints.retrieve(endpoint.id)).secret, undefined);
  assert.equal((await sdk.webhookEndpoints.list()).data[0].secret, undefined);
});

test("Stripe endpoint filters, updates, disable and delete control external delivery", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  const endpoint = await sdk.webhookEndpoints.create({ url, enabled_events: ["product.created"] });
  await sdk.customers.create({ name: "Filtered" });
  await webhooks.flushStripeWebhooks(); assert.equal(received.length, 0);
  await sdk.webhookEndpoints.update(endpoint.id, { enabled_events: ["customer.created"] });
  await sdk.customers.create({ name: "Sent" });
  await webhooks.flushStripeWebhooks(); assert.equal(received.length, 1);
  await sdk.webhookEndpoints.update(endpoint.id, { disabled: true });
  await sdk.customers.create({ name: "Disabled" });
  await webhooks.flushStripeWebhooks(); assert.equal(received.length, 1);
  assert.equal((await sdk.webhookEndpoints.del(endpoint.id)).deleted, true);
  await sdk.customers.create({ name: "Deleted" });
  await webhooks.flushStripeWebhooks(); assert.equal(received.length, 1);
  await assert.rejects(sdk.webhookEndpoints.retrieve(endpoint.id), /No such webhook_endpoint/);
  await assert.rejects(sdk.webhookEndpoints.create({ url, enabled_events: ["*"], api_version: "2020-08-27" }), /Only API version/);
});

test("Stripe retries failed POSTs with a stable event and stops after success", async t => {
  const { sdk, webhooks, received, url } = await fixture(t, (_item, count) => count < 3 ? 503 : 204);
  const endpoint = await sdk.webhookEndpoints.create({ url, enabled_events: ["customer.created"] });
  await sdk.customers.create({ name: "Retry" });
  await webhooks.flushStripeWebhooks();
  assert.equal(received.length, 3);
  assert.equal(new Set(received.map(item => item.body)).size, 1);
  for (const item of received) sdk.webhooks.constructEvent(item.body, item.headers["stripe-signature"], endpoint.secret);
  assert.deepEqual(webhooks.getDeliveries().map(row => row.status_code), [503, 503, 204]);
});

test("Stripe does not follow webhook redirects", async t => {
  const { sdk, webhooks, received, url } = await fixture(t, () => 302);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["customer.created"] });
  await sdk.customers.create({ name: "Redirect" }); await webhooks.flushStripeWebhooks();
  assert.equal(received.length, 3);
  assert.ok(webhooks.getDeliveries().every(row => row.status_code === 302 && !row.success));
});

test("Stripe sends seeded subscriptions and restores endpoint and event records", async t => {
  const { store, sdk, webhooks, received, url } = await fixture(t);
  seedStripeWebhooks(store, webhooks, { webhooks: [{ id: "we_seed", url, events: ["customer.created"], secret: "whsec_seed" }] });
  const snapshot = store.snapshot();
  await sdk.webhookEndpoints.del("we_seed"); store.restore(snapshot);
  await sdk.customers.create({ name: "Restored" }); await webhooks.flushStripeWebhooks();
  assert.equal(received.length, 1);
  sdk.webhooks.constructEvent(received[0].body, received[0].headers["stripe-signature"], "whsec_seed");
  assert.equal((await sdk.webhookEndpoints.retrieve("we_seed")).status, "enabled");
});

test("Stripe billing, invoice-item and refund mutations send their real resource snapshots", async t => {
  const { store, sdk, webhooks, received, url } = await fixture(t);
  const config = { customers: [{ id: "cus_bill", name: "Buyer" }] };
  seedFromConfig(store, "http://localhost", config); seedStripeBilling(store, config);
  const endpoint = await sdk.webhookEndpoints.create({ url, enabled_events: ["*"] });
  const invoice = await sdk.invoices.create({ customer: "cus_bill" });
  const item = await sdk.invoiceItems.create({ customer: "cus_bill", invoice: invoice.id, amount: 1234, currency: "usd" });
  await sdk.invoices.finalizeInvoice(invoice.id);
  await sdk.invoices.pay(invoice.id);
  const charges = await sdk.charges.list();
  const refund = await sdk.refunds.create({ charge: charges.data[0].id, amount: 234 });
  await webhooks.flushStripeWebhooks();
  const events = received.map(row => sdk.webhooks.constructEvent(row.body, row.headers["stripe-signature"], endpoint.secret));
  for (const type of ["invoice.created", "invoiceitem.created", "invoice.finalized", "payment_intent.succeeded", "charge.succeeded", "invoice.paid", "invoice.payment_succeeded", "refund.created", "charge.refunded"]) {
    assert.ok(events.some(event => event.type === type), type);
  }
  assert.equal(events.find(event => event.type === "invoiceitem.created").data.object.id, item.id);
  assert.equal(events.find(event => event.type === "invoice.paid").data.object.amount_paid, 1234);
  assert.equal(events.find(event => event.type === "refund.created").data.object.id, refund.id);
  assert.equal(events.find(event => event.type === "charge.refunded").data.object.amount_refunded, 234);
});

test("a slow Stripe receiver does not block an API write and clear stops retries", async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { sdk, webhooks, received, url } = await fixture(t, () => held);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["*"] });
  const customer = await sdk.customers.create({ name: "Async" });
  assert.equal(customer.name, "Async");
  webhooks.clear(); release(503);
  await webhooks.flushStripeWebhooks();
  assert.ok(received.length <= 1); assert.equal(webhooks.getDeliveries().length, 0);
});

test("Stripe endpoint metadata merges and supports removal through official SDK forms", async t => {
  const { sdk, url } = await fixture(t);
  const endpoint = await sdk.webhookEndpoints.create({ url, enabled_events: ["customer.created"],
    metadata: { keep: "yes", remove: "old" }, api_version: STRIPE_WEBHOOK_API_VERSION });
  assert.equal(endpoint.api_version, official.api_version);
  assert.deepEqual((await sdk.webhookEndpoints.update(endpoint.id, { metadata: { add: "new", remove: "" } })).metadata,
    { keep: "yes", add: "new" });
  assert.deepEqual((await sdk.webhookEndpoints.update(endpoint.id, { metadata: "" })).metadata, {});
  await assert.rejects(sdk.webhookEndpoints.create({ url, enabled_events: ["invented.created"] }), /Invalid enabled_events/);
  await assert.rejects(sdk.webhookEndpoints.update(endpoint.id, { api_version: STRIPE_WEBHOOK_API_VERSION }), /unknown parameter/);
});

test("Stripe event list supports documented filters and the adjacent previous page", async t => {
  const { sdk, webhooks } = await fixture(t);
  for (let index = 0; index < 6; index++) {
    const customer = await sdk.customers.create({ name: String(index) });
    if (index === 0) await sdk.customers.update(customer.id, { name: "updated" });
  }
  await webhooks.flushStripeWebhooks();
  const all = (await sdk.events.list({ limit: 100 })).data;
  assert.equal((await sdk.events.list({ type: "customer.*" })).data.length, 7);
  assert.deepEqual((await sdk.events.list({ types: ["customer.updated"] })).data.map(event => event.type), ["customer.updated"]);
  assert.equal((await sdk.events.list({ type: "customerX*" })).data.length, 0);
  assert.equal((await sdk.events.list({ delivery_success: false })).data.length, 0);
  assert.equal((await sdk.events.list({ delivery_success: true })).data.length, 7);
  assert.equal((await sdk.events.list({ created: { gt: all[0].created } })).data.length, 0);
  assert.equal((await sdk.events.list({ created: { gte: all.at(-1).created } })).data.length, 7);
  const page = await sdk.events.list({ ending_before: all[5].id, limit: 2 });
  assert.deepEqual(page.data.map(event => event.id), all.slice(3, 5).map(event => event.id));
  assert.equal(page.has_more, true);
  await assert.rejects(sdk.events.list({ type: "customer.created", types: ["customer.updated"] }), /only one/);
});

test("Stripe updated snapshots include only changed nested fields and remain immutable", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["customer.updated"] });
  const customer = await sdk.customers.create({ metadata: { stable: "same", changed: "before" } });
  await sdk.customers.update(customer.id, { metadata: { stable: "same", changed: "after" } });
  await sdk.customers.update(customer.id, { name: "later" });
  await webhooks.flushStripeWebhooks();
  const event = JSON.parse(received[0].body);
  assert.deepEqual(event.data.previous_attributes, { metadata: { changed: "before" } });
  assert.equal(event.data.object.name, null);
  assert.deepEqual((await sdk.events.retrieve(event.id)).data, event.data);
});

test("Stripe direct payment snapshots include required charge fields and payment links", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["*"] });
  const intent = await sdk.paymentIntents.create({ amount: 1200, currency: "usd", payment_method: "pm_card_visa" });
  const confirmed = await sdk.paymentIntents.confirm(intent.id);
  await webhooks.flushStripeWebhooks();
  const events = received.map(item => JSON.parse(item.body));
  const charge = events.find(event => event.type === "charge.succeeded").data.object;
  const payment = events.find(event => event.type === "payment_intent.succeeded").data.object;
  checkFieldInventory(charge); checkFieldInventory(payment);
  assert.equal(charge.payment_intent, intent.id);
  assert.equal(charge.amount_captured, 1200); assert.equal(charge.captured, true);
  assert.equal(payment.latest_charge, charge.id); assert.equal(payment.amount_received, 1200);
  assert.equal(confirmed.latest_charge, charge.id);
});

test("Stripe customer deletion keeps the Customer snapshot separate from the deletion response", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["customer.deleted"] });
  const customer = await sdk.customers.create({ name: "Deleted customer" });
  assert.equal((await sdk.customers.del(customer.id)).deleted, true);
  await webhooks.flushStripeWebhooks();
  const snapshot = JSON.parse(received[0].body).data.object;
  checkFieldInventory(snapshot);
  assert.equal(snapshot.name, "Deleted customer");
  assert.equal(snapshot.deleted, undefined);
});

test("Stripe catalog and Checkout snapshots include required fields for the local default branch", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["*"] });
  const product = await sdk.products.create({ name: "Local product" });
  const price = await sdk.prices.create({ product: product.id, currency: "usd", unit_amount: 1500 });
  const session = await sdk.checkout.sessions.create({ mode: "payment", line_items: [{ price: price.id, quantity: 1 }],
    success_url: "https://example.com/success", cancel_url: "https://example.com/cancel" });
  await sdk.checkout.sessions.expire(session.id);
  await webhooks.flushStripeWebhooks();
  const snapshots = received.map(item => JSON.parse(item.body).data.object);
  for (const snapshot of snapshots) checkFieldInventory(snapshot);
  const productSnapshot = snapshots.find(item => item.object === "product");
  assert.deepEqual(productSnapshot.images, []); assert.deepEqual(productSnapshot.marketing_features, []);
  assert.equal(productSnapshot.updated, productSnapshot.created);
  assert.equal(snapshots.find(item => item.object === "price").billing_scheme, "per_unit");
  const checkout = snapshots.find(item => item.object === "checkout.session");
  assert.equal(checkout.expires_at, checkout.created + 86400);
  assert.deepEqual(checkout.payment_method_types, ["card"]);
  assert.equal(checkout.automatic_tax.enabled, false);
});

test("Stripe out-of-band invoice payment emits invoice.paid without a payment attempt event", async t => {
  const { sdk, webhooks, received, url } = await fixture(t);
  await sdk.webhookEndpoints.create({ url, enabled_events: ["*"] });
  const customer = await sdk.customers.create({ name: "External payment" });
  const invoice = await sdk.invoices.create({ customer: customer.id });
  await sdk.invoiceItems.create({ invoice: invoice.id, customer: customer.id, amount: 1500, currency: "usd" });
  await sdk.invoices.finalizeInvoice(invoice.id);
  await sdk.invoices.pay(invoice.id, { paid_out_of_band: true });
  await webhooks.flushStripeWebhooks();
  const types = received.map(item => JSON.parse(item.body).type);
  assert.ok(types.includes("invoice.paid"));
  for (const type of ["invoice.payment_succeeded", "payment_intent.succeeded", "charge.succeeded"]) assert.ok(!types.includes(type), type);
});
