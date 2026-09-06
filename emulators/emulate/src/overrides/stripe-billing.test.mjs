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

// Closes: `Number(query("limit") ?? 10) || 10` made `limit=0` and `limit=abc`
// both mean ten. Measured on the live listener before the fix --
// `GET /v1/invoices?limit=0` answered 200 with ten invoices.
test("an out-of-range or non-integer limit is refused rather than silently made 10", async () => {
  const { app } = fixture();
  for (let index = 0; index < 3; index += 1) {
    await request(app, "/v1/invoices", "POST", { customer: "cus_example" });
  }

  for (const [query, message] of [
    ["limit=0", "This value must be greater than or equal to 1."],
    ["limit=abc", "Invalid integer: abc"],
    ["limit=101", "This value must be less than or equal to 100."],
  ]) {
    const refused = await request(app, `/v1/invoices?${query}`);
    assert.equal(refused.response.status, 400, query);
    assert.equal(refused.value.error.type, "invalid_request_error");
    assert.equal(refused.value.error.message, message);
  }

  // The valid range still works, including the `limit=100` the Stripe Workbench
  // sends, and an absent limit still defaults to ten.
  assert.equal((await request(app, "/v1/invoices?limit=1")).value.data.length, 1);
  assert.equal((await request(app, "/v1/invoices?limit=100")).value.data.length, 3);
  assert.equal((await request(app, "/v1/invoices")).response.status, 200);
});

// Closes: an unknown `starting_after` resolved to index 0 through
// `Math.max(0, findIndex(...) + 1)`, so the emulator re-served page one with
// `has_more: true` and a client paging until `has_more` went false never
// terminated. Measured: `?limit=2&starting_after=in_doesnotexist` returned 200
// and the same rows as `?limit=2`.
test("an unknown starting_after cursor is refused rather than re-serving page one", async () => {
  const { app } = fixture();
  for (let index = 0; index < 5; index += 1) {
    await request(app, "/v1/invoices", "POST", { customer: "cus_example" });
  }

  const page1 = await request(app, "/v1/invoices?limit=2");
  assert.equal(page1.value.data.length, 2);
  assert.equal(page1.value.has_more, true);

  const bogus = await request(app, "/v1/invoices?limit=2&starting_after=in_doesnotexist");
  assert.equal(bogus.response.status, 400);
  assert.equal(bogus.value.error.code, "resource_missing");
  assert.equal(bogus.value.error.message, "No such object: 'in_doesnotexist'");

  // A real cursor still advances, and paging to exhaustion terminates.
  const page2 = await request(app, `/v1/invoices?limit=2&starting_after=${page1.value.data.at(-1).id}`);
  assert.equal(page2.response.status, 200);
  const page1Ids = page1.value.data.map((row) => row.id);
  assert.ok(page2.value.data.every((row) => !page1Ids.includes(row.id)), "page two repeated page one");

  const seen = [];
  let after;
  for (let page = 0; page < 10; page += 1) {
    const listed = await request(app, `/v1/invoices?limit=2${after ? `&starting_after=${after}` : ""}`);
    seen.push(...listed.value.data.map((row) => row.id));
    if (!listed.value.has_more) break;
    after = listed.value.data.at(-1).id;
  }
  assert.equal(new Set(seen).size, 5);
});

// Closes: the "due_date and days_until_due are only valid for send_invoice"
// guard tested truthiness, so a JSON body saying `"days_until_due": 0` -- due
// today -- put a `0` on the right of the `||`, the guard did not fire, and a
// `charge_automatically` invoice was created instead of the 400 Stripe answers.
// A form-encoded body was unaffected, because `"0"` is truthy, so the same
// request meant two different things depending on how it was encoded.
test("days_until_due zero is refused on a charge_automatically invoice, in either encoding", async () => {
  const { app } = fixture();

  const json = await app.request("/v1/invoices", {
    method: "POST",
    headers: { authorization: "Bearer sk_test_worldfixture", "content-type": "application/json" },
    body: JSON.stringify({ customer: "cus_example", collection_method: "charge_automatically", days_until_due: 0 }),
  });
  assert.equal(json.status, 400);
  assert.match((await json.json()).error.message, /only valid for send_invoice/);

  const form = await request(app, "/v1/invoices", "POST", {
    customer: "cus_example", collection_method: "charge_automatically", days_until_due: "0",
  });
  assert.equal(form.response.status, 400);

  // And `days_until_due: 0` on a send_invoice invoice still means due today.
  const dueToday = await request(app, "/v1/invoices", "POST", {
    customer: "cus_example", collection_method: "send_invoice", days_until_due: "0",
  });
  assert.equal(dueToday.response.status, 200);
  assert.equal(dueToday.value.due_date, dueToday.value.created);
});

function recurringFixture() {
  const config = {
    customers: [{ id: 'cus_authored', name: 'Authored buyer', email: 'buyer@authored.test' }],
    products: [{ id: 'prod_schedule', name: 'Authored schedule' }, { id: 'prod_single', name: 'Authored single purchase' }],
    prices: [
      { id: 'price_year', product_name: 'Authored schedule', currency: 'sek', unit_amount: 240000, recurring: { interval: 'year', interval_count: 2 } },
      { id: 'price_week', product_name: 'Authored schedule', currency: 'sek', unit_amount: 900, recurring: { interval: 'week', interval_count: 3, usage_type: 'metered', trial_period_days: 7 } },
      { id: 'price_day', product_name: 'Authored schedule', currency: 'sek', unit_amount: 200, recurring: { interval: 'day' } },
      { id: 'price_single', product_name: 'Authored single purchase', currency: 'sek', unit_amount: 5000 },
    ],
    subscriptions: ['year', 'week', 'day'].map(interval => ({ id: `sub_${interval}`, customer: 'cus_authored', price: `price_${interval}` })),
  };
  const server = createServer(extendStripePlugin(stripePlugin), { tokens: { sk_test_worldfixture: { login: 'billing', id: 1, scopes: [] } } });
  seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
  seedStripeBilling(server.store, config);
  return { ...server, config };
}

test('source recurrence is identical in paginated prices, single-price reads and nested subscription price/plan', async () => {
  const { app, config } = recurringFixture();
  const seen = [];
  let cursor;
  for (;;) {
    const page = await request(app, `/v1/prices?limit=1${cursor ? `&starting_after=${cursor}` : ''}`);
    assert.equal(page.response.status, 200);
    seen.push(...page.value.data);
    if (!page.value.has_more) break;
    cursor = page.value.data.at(-1).id;
    assert.ok(seen.length <= config.prices.length, 'Price pagination repeated a page');
  }
  assert.deepEqual(seen.map(price => price.id).sort(), config.prices.map(price => price.id).sort());
  for (const source of config.prices) {
    const expected = source.recurring ? { interval: source.recurring.interval, interval_count: source.recurring.interval_count ?? 1, trial_period_days: source.recurring.trial_period_days ?? null, usage_type: source.recurring.usage_type ?? 'licensed' } : null;
    const price = await request(app, `/v1/prices/${source.id}`);
    assert.deepEqual(price.value.recurring, expected);
    assert.deepEqual(seen.find(row => row.id === source.id).recurring, expected);
    assert.equal(price.value.currency, 'sek');
    if (expected) {
      const sub = await request(app, `/v1/subscriptions/sub_${source.recurring.interval}`);
      const item = sub.value.items.data[0];
      assert.deepEqual(item.price.recurring, expected);
      for (const key of ['interval', 'interval_count', 'trial_period_days', 'usage_type']) assert.equal(item.plan[key], expected[key]);
    } else assert.equal(price.value.type, 'one_time');
  }
});

test('recurrence response keeps native product filtering, product expansion, errors, and serialized reset state', async () => {
  const { app, store } = recurringFixture();
  const filtered = await request(app, '/v1/prices?product=prod_single');
  assert.deepEqual(filtered.value.data.map(price => price.id), ['price_single']);
  assert.equal(filtered.value.data[0].recurring, null);
  const expanded = await request(app, '/v1/prices/price_year?expand[]=product');
  assert.equal(expanded.value.product.id, 'prod_schedule');
  assert.equal(expanded.value.recurring.interval, 'year');
  const missing = await request(app, '/v1/prices/price_missing');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.value.error.code, 'resource_missing');
  assert.equal(Object.hasOwn(missing.value, 'recurring'), false);
  const before = (await request(app, '/v1/prices/price_week')).value;
  store.restore(JSON.parse(JSON.stringify(store.snapshot())));
  assert.deepEqual((await request(app, '/v1/prices/price_week')).value, before);
});

test('malformed authored recurrence fails before any seeded price is changed', async () => {
  for (const recurring of [{ interval: 'quarter' }, { interval: 'month', interval_count: 0 }, { interval: 'month', interval_count: '2' }, { interval: 'year', usage_type: 'unknown' }]) {
    const config = { products: [{ id: 'prod_authored', name: 'Authored product' }], prices: [
      { id: 'price_valid', product_name: 'Authored product', currency: 'sek', unit_amount: 1000, recurring: { interval: 'year' } },
      { id: 'price_invalid', product_name: 'Authored product', currency: 'sek', unit_amount: 2000, recurring },
    ] };
    const server = createServer(extendStripePlugin(stripePlugin), { tokens: { sk_test_worldfixture: { login: 'billing', id: 1, scopes: [] } } });
    seedFromConfig(server.store, server.baseUrl, config, server.webhooks);
    assert.throws(() => seedStripeBilling(server.store, config), /price price_invalid has invalid recurring fields/);
    assert.equal((await request(server.app, '/v1/prices/price_valid')).value.type, 'one_time');
  }
});
