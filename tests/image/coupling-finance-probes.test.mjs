import assert from "node:assert/strict";
import test from "node:test";
import { probeFinanceWorld, stripePages } from "./coupling-finance-probes.mjs";

function fixture() {
  const first = { id: "invoice.1", customer_id: "member.7", amount_cents: 1200, currency: "CHF", status: "paid", number: "1", description: "Previous month", issued_on: "2031-01-01", due_on: "2031-01-15" };
  const second = { id: "invoice.2", customer_id: "member.7", amount_cents: 1200, currency: "CHF", status: "overdue", number: "2", description: "Current month", issued_on: "2031-02-01", due_on: "2031-02-15" };
  const world = { clock: { anchor: "2031-02-20T00:00:00Z" }, people: [{ id: "person", email: "person@odd.test" }], finance: { currency: "CHF",
    customers: [{ id: "member.7", name: "Odd member", contact_id: "person", service: "Monthly Note", monthly_amount_cents: 1200 }],
    resolved: { invoices: [first, second], payments: [{ id: "payment-1", customer_id: "member.7", invoice_id: first.id, amount_cents: 1200, currency: "CHF", paid_on: "2031-01-12" }], refunds: [] }, anchor_invoices: [second] },
    commerce: { products: [{ id: "p.dot", name: "A bowl", summary: "Handmade bowl", price_cents: 2400, currency: "SEK" }] } };
  const projection = {
    customers: [{ id: "cus_member_7", name: "Odd member", email: "person@odd.test", worldfixture_customer_id: "member.7" }],
    products: [{ id: "prod_monthly_note", name: "Monthly Note", description: "Monthly Monthly Note subscription" }, { id: "prod_p_dot", name: "A bowl", description: "Handmade bowl" }],
    prices: [{ id: "price_member_7", product_name: "Monthly Note", currency: "chf", unit_amount: 1200, recurring: { interval: "month" } }, { id: "price_p_dot", product_name: "A bowl", currency: "sek", unit_amount: 2400 }],
    subscriptions: [{ id: "sub_member_7", customer: "cus_member_7", price: "price_member_7", status: "active" }],
    invoices: [{ id: "in_invoice_1", customer: "cus_member_7", amount_due: 1200, currency: "chf", status: "paid", number: "1", description: "Previous month", created: 1924992000, due_date: 1926201600,
      metadata: { worldfixture_invoice_id: "invoice.1", worldfixture_status: "paid" } },
    { id: "in_invoice_2", customer: "cus_member_7", amount_due: 1200, currency: "chf", status: "open", number: "2", description: "Current month", created: 1927670400, due_date: 1928880000,
      metadata: { worldfixture_invoice_id: "invoice.2", worldfixture_status: "overdue" } }],
  };
  const paidAt = Date.parse("2031-01-12") / 1000;
  const payment = { id: "pi_payment_1", charge: "ch_payment_1", invoice_payment: "inpay_payment_1", invoice: "in_invoice_1",
    customer: "cus_member_7", amount: 1200, currency: "chf", created: paidAt, metadata: { worldfixture_payment_id: "payment-1" } };
  projection.transactions = { payments: [payment], refunds: [] };
  const records = structuredClone(projection);
  records.payment_intents = [{ ...payment, status: "succeeded", amount_received: 1200, latest_charge: "ch_payment_1" }];
  records.charges = [{ ...payment, id: "ch_payment_1", payment_intent: payment.id, invoice: "in_invoice_1", paid: true, amount_refunded: 0, refunded: false }];
  records.invoice_payments = [{ id: "inpay_payment_1", invoice: "in_invoice_1", payment: { payment_intent: payment.id }, amount_paid: 1200, currency: "chf", status: "paid", status_transitions: { paid_at: paidAt } }];
  records.refunds = [];
  records.prices[0] = { ...records.prices[0], product: "prod_monthly_note", type: "recurring", recurring: { interval: "month", interval_count: 1 } };
  records.prices[1] = { ...records.prices[1], product: "prod_p_dot", type: "one_time", recurring: null };
  records.subscriptions[0] = { ...records.subscriptions[0], currency: "chf", items: { data: [{ id: "si_member_7", quantity: 1, price: records.prices[0] }], has_more: false } };
  records.invoices = records.invoices.map(invoice => ({ ...invoice, total: 1200, amount_paid: invoice.status === "paid" ? 1200 : 0, amount_remaining: invoice.status === "paid" ? 0 : 1200,
    status_transitions: { paid_at: invoice.status === "paid" ? paidAt : null },
    lines: { data: [], has_more: false, total_count: 2 } }));
  const calls = [];
  const bindings = { STRIPE_BASE_URL: "http://stripe.test", STRIPE_TOKEN: "stripe-private-value" };
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.headers.authorization, "Bearer stripe-private-value");
    const parsed = new URL(url); calls.push(parsed.pathname + parsed.search);
    let values;
    const invoiceId = parsed.pathname.match(/^\/v1\/invoices\/([^/]+)\/lines$/)?.[1];
    if (invoiceId) values = [{ id: `${invoiceId}-line-a`, invoice: invoiceId, amount: 700, currency: "chf" }, { id: `${invoiceId}-line-b`, invoice: invoiceId, amount: 500, currency: "chf" }];
    else if (parsed.pathname === "/v1/subscription_items") values = records.subscriptions[0].items.data;
    else values = records[parsed.pathname.split("/").at(-1)];
    if (!values) return respond({ error: { code: "resource_missing" } }, 404);
    // Deliberately return only one record on each page, regardless of limit.
    const start = parsed.searchParams.get("starting_after");
    const index = start ? values.findIndex(value => value.id === start) + 1 : 0;
    return respond({ data: values.slice(index, index + 1), has_more: index + 1 < values.length });
  };
  return { artifact: { world, projections: { stripe: projection } }, bindings, fetchImpl, records, calls, respond };
}

test("source history and anchor invoices are read once with complete lines and multiple currencies", async () => {
  const input = fixture();
  const result = await probeFinanceWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.ok(input.calls.some(path => path.includes("/invoices?") && path.includes("starting_after=in_invoice_1")));
  assert.ok(input.calls.some(path => path.includes("/in_invoice_1/lines?") && path.includes("starting_after=")));
  assert.ok(input.calls.some(path => path.includes("/subscriptions?status=all")));
  assert.equal(result.coverage.find(row => row.collection === "finance.resolved.invoices").status, "passed");
  assert.equal(JSON.stringify(result).includes("stripe-private-value"), false);
});

test("dropping a historical invoice from projection and API cannot erase source expectations", async () => {
  const input = fixture(); input.artifact.projections.stripe.invoices.shift(); input.records.invoices.shift();
  const result = await probeFinanceWorld(input);
  for (const name of ["projection.invoices.completeness", "api.invoices.identities", "invoice.invoice.1.read"]) {
    assert.equal(result.checks.find(check => check.check === `finance.stripe.${name}`).status, "failed");
  }
  assert.equal(result.coverage.find(row => row.collection === "finance.resolved.invoices").status, "failed");
});

test("wrong served currency, amount and customer relationships fail independently", async () => {
  const input = fixture();
  input.records.prices[0].currency = "usd";
  input.records.invoices[0].amount_due = 1199;
  input.records.subscriptions[0].customer = "cus_foreign";
  const result = await probeFinanceWorld(input);
  for (const name of ["price.price_member_7.fields", "invoice.invoice.1.fields", "subscription.sub_member_7.customer-link"]) {
    assert.equal(result.checks.find(check => check.check === `finance.stripe.${name}`).status, "failed");
  }
});

test("wrong projection currency fails even when served prices match the source", async () => {
  const input = fixture(); input.artifact.projections.stripe.prices[0].currency = "usd";
  const result = await probeFinanceWorld(input);
  assert.equal(result.checks.find(check => check.check === "finance.stripe.projection.price.price_member_7.fields").status, "failed");
  assert.equal(result.checks.find(check => check.check === "finance.stripe.price.price_member_7.fields").status, "passed");
});

test("foreign and missing price records fail complete identity comparisons", async () => {
  const input = fixture(); input.records.prices.pop(); input.records.prices.push({ id: "price_foreign" });
  const result = await probeFinanceWorld(input);
  const check = result.checks.find(check => check.check === "finance.stripe.api.prices.identities");
  assert.equal(check.status, "failed");
  assert.ok(check.detail.missing.some(record => record.id === "price_p_dot"));
  assert.ok(check.detail.unexpected.some(record => record.id === "price_foreign"));
});

test("subscription items marked incomplete are read through their paginated API", async () => {
  const input = fixture(); input.records.subscriptions[0].items.has_more = true;
  const result = await probeFinanceWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.ok(input.calls.some(path => path.startsWith("/v1/subscription_items?subscription=sub_member_7")));
});

test("a missing live endpoint is an assertion and an unknown declared reader is a gap", async () => {
  const input = fixture(), read = input.fetchImpl;
  input.artifact.projections.stripe.future_records = [];
  input.fetchImpl = (url, options) => new URL(url).pathname === "/v1/products"
    ? Promise.resolve(input.respond({ error: { code: "resource_missing" } }, 404)) : read(url, options);
  const result = await probeFinanceWorld(input);
  assert.equal(result.checks.find(check => check.check === "finance.stripe.api.products.read").failure_kind, "assertion");
  assert.equal(result.checks.find(check => check.check === "finance.stripe.reader.future_records").failure_kind, "reader_gap");
});

test("pagination refuses repeated records, missing identity and missing continuation metadata", async () => {
  await assert.rejects(stripePages(async () => ({ data: [{ id: "same" }], has_more: true })), /repeated record/);
  await assert.rejects(stripePages(async () => ({ data: [{}], has_more: true })), /omitted its identity/);
  await assert.rejects(stripePages(async () => ({ data: [] })), /omitted data or has_more/);
});

test("unserved catalog fields remain explicit product gaps despite matching names and prices", async () => {
  const input = fixture();
  const fields = { sku: "BOWL-01", status: "active", category: "ceramics", collection: "summer", launch_date: "2031-01-01" };
  Object.assign(input.artifact.world.commerce.products[0], fields);
  const result = await probeFinanceWorld(input);
  const gap = result.checks.find(check => check.check === "finance.stripe.catalog.p.dot.unserved-fields");
  assert.equal(gap.status, "failed");
  assert.equal(gap.failure_kind, "product_gap");
  assert.deepEqual(gap.expected, fields);
  assert.equal(result.checks.find(check => check.check === "finance.stripe.product.prod_p_dot.fields").status, "passed");
  const coverage = result.coverage.find(row => row.collection === "commerce.products");
  assert.equal(coverage.status, "failed");
  assert.equal(coverage.checked_fields.includes("sku"), false);
});

test("a recurring failure does not fail complete catalog field coverage", async () => {
  const input = fixture();
  input.records.prices[0].currency = "usd";
  input.artifact.projections.stripe.prices.shift();
  const result = await probeFinanceWorld(input);
  assert.equal(result.checks.find(check => check.check === "finance.stripe.price.price_member_7.fields").status, "failed");
  assert.equal(result.checks.find(check => check.check === "finance.stripe.projection.prices.completeness").status, "failed");
  assert.equal(result.coverage.find(row => row.collection === "commerce.products").status, "passed");
});

test("customer name and email assertions determine source customer coverage", async () => {
  for (const field of ["name", "email"]) {
    const input = fixture();
    input.records.customers[0][field] = "foreign";
    const result = await probeFinanceWorld(input);
    assert.equal(result.checks.find(check => check.check === "finance.stripe.api.customers.identities").status, "passed");
    assert.equal(result.checks.find(check => check.check === "finance.stripe.customer.member.7.fields").status, "failed");
    assert.equal(result.coverage.find(row => row.collection === "finance.customers").status, "failed");
  }
});

test("conflicting history and anchor copies fail both collections even when the chosen copy is served", async () => {
  const input = fixture();
  input.artifact.world.finance.anchor_invoices[0] = { ...input.artifact.world.finance.anchor_invoices[0], description: "Conflicting description" };
  input.artifact.projections.stripe.invoices[1].description = "Conflicting description";
  input.records.invoices[1].description = "Conflicting description";
  const result = await probeFinanceWorld(input);
  assert.equal(result.checks.find(check => check.check === "finance.stripe.source.invoice.invoice.2.duplicate-agreement").status, "failed");
  assert.equal(result.checks.find(check => check.check === "finance.stripe.invoice.invoice.2.fields").status, "passed");
  for (const collection of ["finance.resolved.invoices", "finance.anchor_invoices"]) {
    assert.equal(result.coverage.find(row => row.collection === collection).status, "failed");
  }
});

test("projection monthly and active seed defaults are accepted but missing recurring is not", async () => {
  const input = fixture();
  input.artifact.projections.stripe.prices[0].recurring = {};
  delete input.artifact.projections.stripe.subscriptions[0].status;
  let result = await probeFinanceWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  delete input.artifact.projections.stripe.prices[0].recurring;
  result = await probeFinanceWorld(input);
  assert.equal(result.checks.find(check => check.check === "finance.stripe.projection.price.price_member_7.fields").status, "failed");
});

test("missing payment dates, missing transactions, swapped charges and refund totals fail independently", async () => {
  for (const [name, change, expected] of [
    ["date", input => { delete input.records.payment_intents[0].created; }, "payment.payment-1.intent"],
    ["projection and API omission", input => { input.artifact.projections.stripe.transactions.payments = []; input.records.payment_intents = []; }, "projection.payments"],
    ["charge link", input => { input.records.charges[0].payment_intent = "pi_foreign"; }, "payment.payment-1.charge-state"],
    ["refund total", input => { input.records.charges[0].amount_refunded = 5; }, "payment.payment-1.charge-state"],
    ["future payment", input => { input.artifact.world.finance.resolved.payments[0].paid_on = "2031-03-01"; }, "payment.payment-1.date-bounds"],
    ["dropped authored payment", input => { input.artifact.world.finance.payments = [{ ...input.artifact.world.finance.resolved.payments[0], id: "authored-missing" }]; }, "source.payments.authored-missing.resolved"],
  ]) {
    const input = fixture(); change(input);
    const result = await probeFinanceWorld(input);
    assert.equal(result.checks.find(check => check.check === `finance.transactions.${expected}`)?.status, "failed", name);
    assert.equal(result.coverage.find(row => row.collection === "finance.resolved.payments").status, "failed", name);
  }
});

test("source refund identity, date, amount and payment link determine complete coverage", async () => {
  const input = fixture();
  const source = { id: "refund-source", payment_id: "payment-1", amount_cents: 400, currency: "CHF", refunded_on: "2031-01-20", status: "succeeded" };
  input.artifact.world.finance.refunds = [source];
  input.artifact.world.finance.resolved.refunds = [source];
  const refund = { id: "re_refund_source", payment_intent: "pi_payment_1", charge: "ch_payment_1", amount: 400,
    currency: "chf", created: Date.parse(source.refunded_on) / 1000, status: "succeeded", metadata: { worldfixture_refund_id: source.id, worldfixture_payment_id: source.payment_id } };
  input.artifact.projections.stripe.transactions.refunds = [structuredClone(refund)];
  input.records.refunds = [refund]; input.records.charges[0].amount_refunded = 400;
  const result = await probeFinanceWorld(input);
  assert.deepEqual(result.checks.filter(check => check.status === "failed"), []);
  assert.equal(result.coverage.find(row => row.collection === "finance.refunds").status, "passed");
  refund.payment_intent = "pi_foreign";
  const wrong = await probeFinanceWorld(input);
  assert.equal(wrong.checks.find(check => check.check === "finance.transactions.refund.refund-source.api").status, "failed");
  assert.equal(wrong.coverage.find(row => row.collection === "finance.refunds").status, "failed");
});

test("removing generated history from resolved source and provider cannot erase the declared monthly policy", async () => {
  const input = fixture();
  input.artifact.world.finance.history_months = 1;
  const historical = input.artifact.world.finance.resolved.invoices.shift();
  input.artifact.world.finance.resolved.payments = [];
  input.artifact.projections.stripe.invoices = input.artifact.projections.stripe.invoices.filter(row => row.metadata.worldfixture_invoice_id !== historical.id);
  input.records.invoices.shift();
  input.artifact.projections.stripe.transactions.payments = [];
  input.records.payment_intents = []; input.records.charges = []; input.records.invoice_payments = [];
  const result = await probeFinanceWorld(input);
  const check = result.checks.find(check => check.check === "finance.stripe.source.history-completeness");
  assert.equal(check.status, "failed");
  assert.ok(check.detail.missing.some(row => row.id === "inv-203101-member.7"));
});

function catalogFixture() {
  const input = fixture();
  // Canonical customer records alone do not select recurring billing. This
  // catalogue projection deliberately contains only products and prices.
  input.artifact.world.finance = {customers: [{id: 'customer-domain-only', name: 'Canonical customer'}]};
  input.artifact.projections.stripe = {products: [input.artifact.projections.stripe.products[1]], prices: [input.artifact.projections.stripe.prices[1]]};
  input.records.products = [input.records.products[1]]; input.records.prices = [input.records.prices[1]];
  return input;
}

test('catalog-only sections do not invent subscriptions, customers, invoices or settlement reads', async () => {
  const input = catalogFixture(), result = await probeFinanceWorld(input);
  assert.deepEqual(result.checks.filter(row => row.status === 'failed'), []);
  assert.ok(input.calls.every(path => /^\/v1\/(?:products|prices)\?/.test(path)));
  assert.equal(result.coverage.some(row => row.collection.startsWith('finance.')), false);
  input.artifact.projections.stripe.products = []; input.records.products = [];
  const missing = await probeFinanceWorld(input);
  assert.equal(missing.checks.find(row => row.check === 'finance.stripe.projection.products.completeness').status, 'failed');
  assert.equal(missing.checks.find(row => row.check === 'finance.stripe.api.products.identities').status, 'failed');
});

test('catalog fields beyond Stripe require passed domain evidence from the same probe run', async () => {
  for (const evidence of [[], [{collection: 'commerce.products', provider: 'domain', status: 'failed', path: '/v1/collections/commerce.products'}], [{collection: 'commerce.products', provider: 'domain', status: 'passed', path: null}], [{collection: 'commerce.products', provider: 'domain', status: 'passed', path: '/v1/collections/commerce.products'}]]) {
    const input = catalogFixture(); input.artifact.world.commerce.products[0].sku = 'AUTHORED-SKU';
    const result = await probeFinanceWorld({...input, domainCoverage: evidence});
    const field = result.checks.find(row => row.check === 'finance.stripe.catalog.p.dot.unserved-fields');
    const proved = evidence[0]?.status === 'passed' && Boolean(evidence[0]?.path);
    assert.equal(field.status, proved ? 'passed' : 'failed');
    assert.equal(result.checks.find(row => row.check === 'finance.stripe.provider.read').status, proved ? 'passed' : 'failed');
    if (proved) assert.equal(field.delegated_provider, 'domain');
  }
});

test('optional catalog projection collections are still read and foreign content fails', async () => {
  const input = catalogFixture(); input.artifact.projections.stripe.customers = [];
  const result = await probeFinanceWorld(input);
  assert.ok(input.calls.some(path => path.startsWith('/v1/customers?')));
  assert.equal(result.checks.find(row => row.check === 'finance.stripe.api.customers.identities').status, 'failed');
});
