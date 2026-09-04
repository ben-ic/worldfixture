import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createServer } from "@emulators/core";
import { seedFromConfig, stripePlugin } from "@emulators/stripe";
import Stripe from "stripe";
import { extendStripePlugin, seedStripeBilling } from "./stripe-billing.mjs";

const CONTRACT = JSON.parse(readFileSync(new URL("../../contracts/stripe/billing-2026-08-26.contract.json", import.meta.url)));

function fixture() {
  const config = {
    customers: [{ id: "cus_example", email: "buyer@example.test", name: "Example Buyer" }],
    products: [{ id: "prod_pro", name: "Pro", description: "Pro plan" }],
    prices: [{ id: "price_pro", product_name: "Pro", currency: "usd", unit_amount: 2500,
      recurring: { interval: "month" }, worldfixture_customer_id: "example" }],
    subscriptions: [{ id: "sub_example", customer: "cus_example", price: "price_pro", status: "active" }],
    invoices: [],
  };
  const server = createServer(extendStripePlugin(stripePlugin), {
    tokens: { sk_test_worldfixture: { login: "sk_test_admin", id: 1, scopes: [] } },
  });
  seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
  seedStripeBilling(server.store, config);
  assert.equal(server.store.collection("stripe.customers").all().length, 1);
  return server;
}

async function request(app, path, method = "GET", fields) {
  const response = await app.request(path, { method, headers: {
    authorization: "Bearer sk_test_worldfixture",
    ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}),
  }, body: fields ? new URLSearchParams(fields) : undefined });
  return { response, value: await response.json() };
}

test("Stripe billing uses Stripe request paths, fields, response fields, and state transitions", async () => {
  const { app } = fixture();

  const created = await request(app, "/v1/invoices", "POST", {
    customer: "cus_example", collection_method: "send_invoice", days_until_due: "30", description: "September service",
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.value.object, "invoice");
  assert.equal(created.value.status, "draft");
  assert.deepEqual(Object.keys(created.value).sort(), CONTRACT.schemas.invoice.properties);

  const item = await request(app, "/v1/invoiceitems", "POST", {
    customer: "cus_example", invoice: created.value.id, amount: "12345", currency: "usd", description: "Service charge",
  });
  assert.equal(item.response.status, 200);
  assert.deepEqual(Object.keys(item.value).sort(), CONTRACT.schemas.invoiceitem.properties);

  const retrieved = await request(app, `/v1/invoices/${created.value.id}`);
  assert.equal(retrieved.value.amount_due, 12345);
  assert.equal(retrieved.value.lines.data[0].object, "line_item");
  assert.deepEqual(Object.keys(retrieved.value.lines.data[0]).sort(), CONTRACT.schemas.line_item.properties);
  assert.equal(retrieved.value.lines.total_count, 1);

  const finalized = await request(app, `/v1/invoices/${created.value.id}/finalize`, "POST", {});
  assert.equal(finalized.value.status, "open");
  assert.ok(finalized.value.number);
  assert.ok(finalized.value.status_transitions.finalized_at);

  const paid = await request(app, `/v1/invoices/${created.value.id}/pay`, "POST", { payment_method: "pm_card_visa" });
  assert.equal(paid.value.status, "paid");
  assert.equal(paid.value.amount_paid, 12345);
  assert.equal(paid.value.amount_remaining, 0);

  const intents = await request(app, "/v1/payment_intents?limit=100");
  const charges = await request(app, "/v1/charges?limit=100");
  assert.equal(intents.value.data.at(-1).status, "succeeded");
  assert.equal(charges.value.data.at(-1).status, "succeeded");
  assert.equal(charges.value.data.at(-1).amount, 12345);
});

test("Stripe subscriptions use nested Stripe fields and remain readable after cancellation", async () => {
  const { app } = fixture();
  const listed = await request(app, "/v1/subscriptions?status=all&limit=100");
  assert.equal(listed.value.data.length, 1);
  assert.deepEqual(Object.keys(listed.value.data[0]).sort(), CONTRACT.schemas.subscription.properties);
  assert.equal(listed.value.data[0].items.data[0].price.id, "price_pro");

  const canceled = await request(app, "/v1/subscriptions/sub_example", "DELETE", {});
  assert.equal(canceled.value.status, "canceled");
  assert.equal(canceled.value.cancellation_details.reason, "cancellation_requested");

  const retrieved = await request(app, "/v1/subscriptions/sub_example");
  assert.equal(retrieved.value.status, "canceled");
  assert.equal(retrieved.value.id, "sub_example");
});

test("Stripe SDK 22.6.1 uses the supported billing calls without an adapter", async () => {
  const server = fixture();
  const requests = [];
  const httpClient = Stripe.createFetchHttpClient((url, init) => {
    requests.push({ url: String(url), method: init?.method, body: init?.body });
    return server.app.request(url, init);
  });
  const stripe = new Stripe("sk_test_worldfixture", { apiVersion: "2026-08-26.dahlia",
    host: "stripe.worldfixture.test", protocol: "http", httpClient, maxNetworkRetries: 0 });

  const invoice = await stripe.invoices.create({ customer: "cus_example", collection_method: "send_invoice", days_until_due: 30 });
  const item = await stripe.invoiceItems.create({ customer: "cus_example", invoice: invoice.id, pricing: { price: "price_pro" } });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
  const paid = await stripe.invoices.pay(invoice.id, { payment_method: "pm_card_visa" });
  const canceled = await stripe.subscriptions.cancel("sub_example");

  assert.equal(item.amount, 2500);
  assert.equal(finalized.status, "open");
  assert.equal(paid.status, "paid");
  assert.equal(canceled.status, "canceled");
  assert.deepEqual(requests.map(({ method }) => method), ["POST", "POST", "POST", "POST", "DELETE"]);
  assert.match(String(requests[1].body), /pricing\[price\]=price_pro/);
});

test("Stripe SDK 22.6.1 runs every API flow used by the Stripe Workbench", async () => {
  const server = fixture();
  const stripe = new Stripe("sk_test_worldfixture", { apiVersion: "2026-08-26.dahlia",
    host: "stripe.worldfixture.test", protocol: "http",
    httpClient: Stripe.createFetchHttpClient((url, init) => server.app.request(url, init)), maxNetworkRetries: 0 });

  const customers = await stripe.customers.list({ limit: 100 });
  const products = await stripe.products.list({ limit: 100 });
  const prices = await stripe.prices.list({ limit: 100 });
  const createdPayment = await stripe.paymentIntents.create({ amount: 5000, currency: "usd",
    customer: customers.data[0].id, description: "Workbench payment", payment_method: "pm_card_visa" });
  const confirmedPayment = await stripe.paymentIntents.confirm(createdPayment.id, { payment_method: "pm_card_visa" });
  const payments = await stripe.paymentIntents.list({ limit: 100 });
  const charges = await stripe.charges.list({ limit: 100 });
  const subscriptions = await stripe.subscriptions.list({ limit: 100, status: "all" });
  const invoices = await stripe.invoices.list({ limit: 100 });

  assert.equal(customers.data[0].id, "cus_example");
  assert.equal(products.data[0].id, "prod_pro");
  assert.equal(prices.data[0].id, "price_pro");
  assert.equal(confirmedPayment.status, "succeeded");
  assert.equal(payments.data[0].id, createdPayment.id);
  assert.equal(charges.data[0].payment_intent, createdPayment.id);
  assert.equal(subscriptions.data[0].id, "sub_example");
  assert.equal(invoices.data.length, 0);
});

test("Stripe billing emits the documented provider events from the shared mutation path", async () => {
  const { app, webhooks } = fixture();
  webhooks.register({ url: "http://127.0.0.1:1/stripe-hook", events: ["*"], active: true, owner: "stripe" });
  const created = await request(app, "/v1/invoices", "POST", { customer: "cus_example" });
  await request(app, "/v1/invoiceitems", "POST", { customer: "cus_example", invoice: created.value.id, amount: "1000", currency: "usd" });
  await request(app, `/v1/invoices/${created.value.id}/finalize`, "POST", {});
  await request(app, `/v1/invoices/${created.value.id}/pay`, "POST", {});
  await request(app, "/v1/subscriptions/sub_example", "DELETE", {});
  assert.deepEqual(webhooks.getDeliveries().map(({ event }) => event), [
    "invoice.created", "invoice.finalized", "payment_intent.succeeded", "charge.succeeded",
    "invoice.paid", "invoice.payment_succeeded", "customer.subscription.deleted",
  ]);
  assert.equal(webhooks.getDeliveries()[4].payload.data.object.status, "paid");
});

test("Stripe billing returns a Stripe error envelope for an unknown resource", async () => {
  const { app } = fixture();
  const missing = await request(app, "/v1/invoices/in_missing");
  assert.equal(missing.response.status, 404);
  assert.deepEqual(Object.keys(missing.value), ["error"]);
  assert.equal(missing.value.error.type, "invalid_request_error");
  assert.equal(missing.value.error.code, "resource_missing");
});
