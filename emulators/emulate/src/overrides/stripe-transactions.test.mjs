import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "@emulators/core";
import { seedFromConfig, stripePlugin } from "@emulators/stripe";
import Stripe from "stripe";
import { extendStripePlugin, seedStripeBilling } from "./stripe-billing.mjs";
import { extendStripeTransactionsPlugin, seedStripeTransactions } from "./stripe-transactions.mjs";
import { VENDORS } from "../registry.mjs";

const CREATED = 1700000000;
function config() {
  return { customers: [{ id: "cus_buyer", email: "buyer@example.test", name: "Buyer" }],
    invoices: [{ id: "in_paid", customer: "cus_buyer", currency: "eur", amount_due: 1200,
      status: "paid", created: CREATED - 86400, due_date: CREATED },
    { id: "in_partial", customer: "cus_buyer", currency: "gbp", amount_due: 500,
      status: "open", created: CREATED - 86400, due_date: CREATED }],
    transactions: { payments: [
      { id: "pi_first", charge: "ch_first", invoice_payment: "inpay_first", invoice: "in_paid",
        customer: "cus_buyer", amount: 500, currency: "EUR", created: CREATED,
        metadata: { worldfixture_payment_id: "payment-first", worldfixture_invoice_id: "invoice-paid" } },
      { id: "pi_second", charge: "ch_second", invoice_payment: "inpay_second", invoice: "in_paid",
        customer: "cus_buyer", amount: 700, currency: "eur", created: CREATED + 10,
        metadata: { worldfixture_payment_id: "payment-second" } },
      { id: "pi_partial", charge: "ch_partial", invoice_payment: "inpay_partial", invoice: "in_partial",
        customer: "cus_buyer", amount: 200, currency: "gbp", created: CREATED + 20 },
      { id: "pi_order", charge: "ch_order", customer: "cus_buyer", amount: 600, currency: "cad", created: CREATED + 30,
        metadata: { worldfixture_order_id: "order-authored", worldfixture_payment_id: "payment-order" } },
    ], refunds: [{ id: "re_historical", payment_intent: "pi_first", amount: 100, currency: "EUR", created: CREATED + 50,
      metadata: { worldfixture_refund_id: "refund-authored" } }] } };
}

function fixture(input = config(), seed = true) {
  const server = createServer(extendStripeTransactionsPlugin(extendStripePlugin(stripePlugin)), {
    tokens: { sk_test_transactions: { login: "billing", id: 1, scopes: [] } },
  });
  const events = [];
  server.webhooks.dispatch = async (...event) => events.push(event);
  seedFromConfig(server.store, server.baseUrl, input, server.webhooks);
  seedStripeBilling(server.store, input);
  if (seed) seedStripeTransactions(server.store, input);
  const stripe = new Stripe("sk_test_transactions", { host: "stripe.example.test", protocol: "http", maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient((url, init) => server.app.request(url, init)) });
  return { ...server, stripe, events };
}

async function request(app, path, method = "GET", fields) {
  const response = await app.request(path, { method, headers: { authorization: "Bearer sk_test_transactions",
    ...(fields ? { "content-type": "application/json" } : {}) }, body: fields ? JSON.stringify(fields) : undefined });
  return { status: response.status, body: await response.json() };
}

test("normal seed preserves settlement IDs, currencies, dates and API links without historical events", async () => {
  const { stripe, events } = fixture();
  assert.deepEqual(events, []);
  const intent = await stripe.paymentIntents.retrieve("pi_first");
  assert.equal(intent.created, CREATED);
  assert.equal(intent.currency, "eur");
  assert.equal(intent.amount_received, 500);
  assert.equal(intent.latest_charge, "ch_first");
  assert.equal(intent.metadata.worldfixture_payment_id, "payment-first");
  const charge = await stripe.charges.retrieve("ch_first");
  assert.equal(charge.created, CREATED);
  assert.equal(charge.invoice, "in_paid");
  assert.equal(charge.payment_intent, "pi_first");
  assert.equal(charge.amount_refunded, 100);
  assert.equal(charge.refunded, false);
  const invoice = await stripe.invoices.retrieve("in_paid");
  assert.equal(invoice.amount_paid, 1200);
  assert.equal(invoice.status_transitions.paid_at, CREATED + 10);
  assert.deepEqual(invoice.payments.data.map(row => row.id), ["inpay_first", "inpay_second"]);
  const link = await stripe.invoicePayments.retrieve("inpay_first");
  assert.equal(link.invoice, "in_paid");
  assert.deepEqual(link.payment, { type: "payment_intent", payment_intent: "pi_first" });
  assert.equal(link.created, CREATED);
  assert.equal(link.status_transitions.paid_at, CREATED);
  const partial = await stripe.invoices.retrieve("in_partial");
  assert.equal(partial.amount_paid, 200);
  assert.equal(partial.amount_remaining, 300);
  assert.equal(partial.status, "open");
  const refund = await stripe.refunds.retrieve("re_historical");
  assert.equal(refund.created, CREATED + 50);
  assert.equal(refund.currency, "eur");
  assert.equal(refund.metadata.worldfixture_refund_id, "refund-authored");
  assert.equal((await stripe.paymentIntents.list({ limit: 100 })).data.length, 4);
  assert.equal((await stripe.charges.list({ limit: 100 })).data.length, 4);
  assert.equal((await stripe.invoicePayments.list({ limit: 100 })).data.length, 3);
  assert.deepEqual(events, []);
});

test("public partial refunds use the charge currency, cap the cumulative amount, and emit only current events", async () => {
  const { stripe, app, events } = fixture();
  const refund = await stripe.refunds.create({ payment_intent: "pi_first", amount: 150, metadata: { case: "return" } });
  assert.equal(refund.currency, "eur");
  assert.equal(refund.charge, "ch_first");
  assert.ok(refund.created >= Math.floor(Date.now() / 1000) - 5);
  assert.equal((await stripe.charges.retrieve("ch_first")).amount_refunded, 250);
  assert.deepEqual(events.map(row => row[0]), ["refund.created"]);
  const invalid = await request(app, "/v1/refunds", "POST", { charge: "ch_first", amount: 251 });
  assert.equal(invalid.status, 400);
  const wrongCurrency = await request(app, "/v1/refunds", "POST", { charge: "ch_first", amount: 100, currency: "usd" });
  assert.equal(wrongCurrency.status, 400);
  const final = await stripe.refunds.create({ charge: "ch_first" });
  assert.equal(final.amount, 250);
  assert.equal((await stripe.charges.retrieve("ch_first")).refunded, true);
  assert.equal((await request(app, "/v1/refunds", "POST", { charge: "ch_first", amount: 1 })).status, 400);
  assert.equal((await stripe.paymentIntents.retrieve("pi_first")).amount_received, 500);
  assert.equal((await stripe.invoices.retrieve("in_paid")).amount_paid, 1200);
});

test("pagination and filters expose every invoice payment and refund without repeating a missing cursor", async () => {
  const { stripe, app } = fixture();
  const first = await stripe.invoicePayments.list({ invoice: "in_paid", limit: 1 });
  assert.equal(first.data[0].id, "inpay_second");
  assert.equal(first.has_more, true);
  const second = await stripe.invoicePayments.list({ invoice: "in_paid", limit: 1, starting_after: first.data[0].id });
  assert.equal(second.data[0].id, "inpay_first");
  assert.equal(second.has_more, false);
  assert.equal((await stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: "pi_partial" } })).data.length, 1);
  assert.equal((await stripe.invoicePayments.list({ invoice: "in_absent" })).data.length, 0);
  await stripe.refunds.create({ charge: "ch_order", amount: 100 });
  const refunds = await stripe.refunds.list({ limit: 1 });
  assert.equal(refunds.has_more, true);
  const next = await stripe.refunds.list({ limit: 1, starting_after: refunds.data[0].id });
  assert.equal(next.data[0].id, "re_historical");
  assert.equal(next.has_more, false);
  assert.equal((await stripe.refunds.list({ payment_intent: "pi_order" })).data.length, 1);
  for (const path of ["/v1/invoice_payments", "/v1/refunds"]) {
    for (const query of ["limit=0", "limit=101", "limit=abc", "starting_after=missing", "ending_before=missing"]) {
      assert.equal((await request(app, `${path}?${query}`)).status, 400, `${path}?${query}`);
    }
    assert.equal((await request(app, `${path}/missing`)).status, 404);
  }
});

test("invalid explicit history is refused before any transaction insert", async () => {
  const cases = [
    ["duplicate provider ID", c => { c.transactions.payments[1].id = "pi_first"; }, /duplicate ID/],
    ["duplicate source ID", c => { c.transactions.payments[1].metadata.worldfixture_payment_id = "payment-first"; }, /duplicate source/],
    ["duplicate charge ID", c => { c.transactions.payments[1].charge = "ch_first"; }, /duplicate ID/],
    ["duplicate link ID", c => { c.transactions.payments[1].invoice_payment = "inpay_first"; }, /duplicate ID/],
    ["duplicate refund ID", c => { c.transactions.refunds.push({ ...c.transactions.refunds[0] }); }, /duplicate ID/],
    ["duplicate source refund ID", c => { c.transactions.refunds.push({ ...c.transactions.refunds[0], id: "re_another" }); }, /duplicate source refund/],
    ["unknown customer", c => { c.transactions.payments[0].customer = "cus_foreign"; }, /unknown customer/],
    ["invoice customer mismatch", c => { c.customers.push({ id: "cus_other" }); c.transactions.payments[0].customer = "cus_other"; }, /customer mismatch/],
    ["unknown invoice", c => { c.transactions.payments[0].invoice = "in_foreign"; }, /unknown invoice/],
    ["missing date", c => { delete c.transactions.payments[0].created; }, /created/],
    ["missing currency", c => { delete c.transactions.payments[0].currency; }, /currency/],
    ["invoice currency mismatch", c => { c.transactions.payments[0].currency = "usd"; }, /currency mismatch/],
    ["payment predates invoice", c => { c.transactions.payments[0].created = 1; }, /predates/],
    ["overpaid invoice", c => { c.transactions.payments[0].amount = 600; }, /overpaid/],
    ["paid invoice missing settlement", c => { c.transactions.payments.splice(0, 1); }, /unmatched settlements/],
    ["canceled settlement", c => { c.transactions.payments[0].status = "canceled"; }, /only explicit succeeded/],
    ["void invoice", c => { c.invoices[0].status = "void"; }, /cannot receive/],
    ["unknown refund payment", c => { c.transactions.refunds[0].payment_intent = "pi_foreign"; }, /unknown payment/],
    ["refund currency", c => { c.transactions.refunds[0].currency = "usd"; }, /currency mismatch/],
    ["refund predates payment", c => { c.transactions.refunds[0].created = CREATED - 1; }, /predates/],
    ["cumulative refund overflow", c => { c.transactions.refunds.push({ ...c.transactions.refunds[0], id: "re_extra", amount: 401, metadata: {} }); }, /refunds exceed/],
    ["fraction amount", c => { c.transactions.payments[0].amount = 1.5; }, /positive safe integer/],
    ["unsafe amount", c => { c.transactions.payments[0].amount = Number.MAX_SAFE_INTEGER + 1; }, /positive safe integer/],
    ["implicit refund list", c => { delete c.transactions.refunds; }, /explicit arrays/],
  ];
  for (const [label, change, pattern] of cases) {
    const input = config();
    change(input);
    const { app, store, events } = fixture(input, false);
    assert.throws(() => seedStripeTransactions(store, input), pattern, label);
    assert.equal((await request(app, "/v1/payment_intents")).body.data.length, 0, label);
    assert.equal((await request(app, "/v1/charges")).body.data.length, 0, label);
    assert.deepEqual((await request(app, "/v1/refunds")).body.data, [], label);
    assert.deepEqual(events, [], label);
  }
});

test("existing IDs and repeated history are refused without changing prior API records", async () => {
  const { store, stripe, app } = fixture();
  const before = await request(app, "/v1/payment_intents?limit=100");
  assert.throws(() => seedStripeTransactions(store, config()), /duplicate ID/);
  assert.deepEqual(await request(app, "/v1/payment_intents?limit=100"), before);
  assert.equal((await stripe.refunds.list()).data.length, 1);
});

test("absent transaction configuration keeps empty public lists; explicit empty lists enable current lifecycle", async () => {
  const input = { customers: [{ id: "cus_buyer" }], invoices: [] };
  const legacy = fixture(input);
  assert.deepEqual(seedStripeTransactions(legacy.store, input), { enabled: false, payments: 0, refunds: 0 });
  for (const path of ["/v1/refunds", "/v1/invoice_payments"]) {
    const result = await request(legacy.app, path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { object: "list", url: path, data: [], has_more: false });
    assert.equal((await request(legacy.app, `${path}/missing`)).status, 404);
    assert.equal((await request(legacy.app, `${path}?starting_after=missing`)).status, 400);
  }
  const { stripe } = fixture({ ...input, transactions: { payments: [], refunds: [] } });
  const invoice = await stripe.invoices.create({ customer: "cus_buyer", currency: "gbp" });
  await stripe.invoiceItems.create({ customer: "cus_buyer", invoice: invoice.id, amount: 400, currency: "gbp" });
  await stripe.invoices.finalizeInvoice(invoice.id);
  const paid = await stripe.invoices.pay(invoice.id);
  assert.equal(paid.payments.data.length, 1);
  const link = paid.payments.data[0];
  assert.equal(link.currency, "gbp");
  assert.equal((await stripe.invoicePayments.retrieve(link.id)).invoice, invoice.id);
  const refund = await stripe.refunds.create({ payment_intent: link.payment.payment_intent, amount: 100 });
  assert.equal(refund.currency, "gbp");
});

test("catalog-only normal registry seed exposes empty transactions and accepts a current payment and refund", async () => {
  const loaded = await VENDORS.stripe.load();
  const server = createServer(loaded.plugin, { tokens: { sk_test_transactions: { login: "billing", id: 1 } } });
  const input = { products: [{ id: "prod_only", name: "Only product" }],
    prices: [{ id: "price_only", product_name: "Only product", currency: "nzd", unit_amount: 5612 }] };
  const seed = () => loaded.seedFromConfig(server.store, server.baseUrl, input, server.webhooks);
  seed();
  const stripe = new Stripe("sk_test_transactions", { host: "stripe.example.test", protocol: "http", maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient((url, init) => server.app.request(url, init)) });
  for (const collection of ["paymentIntents", "charges", "refunds", "invoicePayments"]) {
    const result = await stripe[collection].list();
    assert.deepEqual(result.data, [], collection);
    assert.equal(result.has_more, false, collection);
  }
  const customer = await stripe.customers.create({ email: "current@example.test" });
  const intent = await stripe.paymentIntents.create({ customer: customer.id, amount: 5612, currency: "nzd" });
  await stripe.paymentIntents.confirm(intent.id, { payment_method: "pm_card_visa" });
  const refund = await stripe.refunds.create({ payment_intent: intent.id, amount: 112 });
  assert.equal(refund.currency, "nzd");
  assert.equal((await stripe.refunds.list()).data[0].id, refund.id);
  assert.equal((await stripe.charges.list()).data[0].amount_refunded, 112);
  server.store.reset();
  seed();
  assert.deepEqual((await stripe.refunds.list()).data, []);
  assert.deepEqual((await stripe.paymentIntents.list()).data, []);
  assert.deepEqual((await stripe.products.list()).data.map(row => row.id), ["prod_only"]);
});

test("reset and normal reseed restore only authored transactions, with no historical events", async () => {
  const { app, store, webhooks, baseUrl, stripe, events } = fixture();
  const baseline = await request(app, "/v1/refunds?limit=100");
  await stripe.refunds.create({ charge: "ch_order", amount: 100 });
  assert.equal((await stripe.refunds.list()).data.length, 2);
  store.reset();
  assert.deepEqual((await request(app, "/v1/refunds")).body.data, []);
  events.length = 0;
  seedFromConfig(store, baseUrl, config(), webhooks);
  seedStripeBilling(store, config());
  seedStripeTransactions(store, config());
  assert.deepEqual(await request(app, "/v1/refunds?limit=100"), baseline);
  assert.equal((await stripe.charges.retrieve("ch_order")).amount_refunded, 0);
  assert.equal((await stripe.invoicePayments.list()).data.length, 3);
  assert.deepEqual(events, []);
});

test("malformed public refunds do not change successful charge totals", async () => {
  const { app, stripe } = fixture();
  for (const body of [
    { charge: "ch_order", amount: true }, { charge: "ch_order", amount: -1 },
    { charge: "ch_order", amount: 1.5 }, { charge: "ch_order", amount: 0 },
    { charge: "ch_order", amount: 10, metadata: { value: 12 } },
    { charge: "ch_order", reason: "invented" }, { charge: "ch_missing" },
    { charge: "ch_order", payment_intent: "pi_order" }, {},
  ]) {
    assert.equal((await request(app, "/v1/refunds", "POST", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await stripe.charges.retrieve("ch_order")).amount_refunded, 0);
  assert.equal((await stripe.refunds.list()).data.length, 1);
});
