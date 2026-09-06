import { compareIdentities } from "./coupling-artifacts.mjs";

const rows = value => Array.isArray(value) ? value : [];
const id = (prefix, value) => `${prefix}_${String(value).replace(/[^a-zA-Z0-9]/g, "_")}`;
const objectId = value => value && typeof value === "object" ? value.id : value;
const seconds = day => typeof day === "string" && Number.isFinite(Date.parse(day)) ? Date.parse(day) / 1000 : null;

// Expectations come from source settlements. Projection and API records are
// compared separately so deleting both cannot erase the expected transaction.
export async function probeTransactions({ world, projection, list }) {
  const checks = [], coverage = [];
  const compare = (name, expected, actual) => checks.push({ check: `finance.transactions.${name}`, finding: 5,
    status: JSON.stringify(expected) === JSON.stringify(actual) ? "passed" : "failed", expected, actual });
  const identities = (name, expected, actual) => checks.push(compareIdentities({
    check: `finance.transactions.${name}`, expected, actual, finding: 5,
  }));
  const finance = world.finance ?? {};
  const invoices = [...rows(finance.resolved?.invoices), ...rows(finance.anchor_invoices)];
  const customerCurrency = row => rows(finance.customers).find(customer => customer.id === row.customer_id)?.currency;
  const currency = row => (row.currency
    ?? invoices.find(invoice => invoice.id === row.invoice_id)?.currency
    ?? customerCurrency(row) ?? finance.currency)?.toLowerCase();
  const source = {};
  for (const [kind, fields] of [["payments", ["customer_id", "invoice_id", "order_id", "amount_cents", "paid_on"]],
    ["refunds", ["payment_id", "amount_cents", "refunded_on"]]]) {
    const resolved = rows(finance.resolved?.[kind]);
    const authored = rows(finance[kind]);
    identities(`source.${kind}.unique`, resolved, [...new Map(resolved.map(row => [row.id, row])).values()]);
    const normalized = row => row ? [...fields.map(key => row[key] ?? null), currency(row)] : null;
    for (const row of authored) compare(`source.${kind}.${row.id}.resolved`, normalized(row), normalized(resolved.find(item => item.id === row.id)));
    source[kind] = [...new Map([...resolved, ...authored].map(row => [row.id, row])).values()];
  }
  const payments = source.payments, refunds = source.refunds;
  const projected = projection.transactions ?? {};
  identities("projection.payments", payments.map(row => ({ id: id("pi", row.id) })), rows(projected.payments));
  identities("projection.refunds", refunds.map(row => ({ id: id("re", row.id) })), rows(projected.refunds));
  const actual = {};
  for (const kind of ["payment_intents", "charges", "invoice_payments", "refunds"]) {
    try { actual[kind] = await list(`/v1/${kind}`); }
    catch (error) { checks.push({ check: `finance.transactions.api.${kind}`, status: "failed", finding: 5, detail: error.message }); }
  }
  const expectedIds = { payment_intents: payments.map(row => ({ id: id("pi", row.id) })),
    charges: payments.map(row => ({ id: id("ch", row.id) })),
    invoice_payments: payments.filter(row => row.invoice_id).map(row => ({ id: id("inpay", row.id) })),
    refunds: refunds.map(row => ({ id: id("re", row.id) })) };
  for (const [kind, expected] of Object.entries(expectedIds)) identities(`api.${kind}.identities`, expected, actual[kind] ?? []);
  for (const row of payments) {
    const pi = id("pi", row.id), charge = id("ch", row.id), created = seconds(row.paid_on);
    const customer = id("cus", row.customer_id), invoice = row.invoice_id ? id("in", row.invoice_id) : null;
    const refunded = refunds.filter(refund => refund.payment_id === row.id).reduce((sum, refund) => sum + refund.amount_cents, 0);
    const fields = value => value ? [value.amount, currency(value), value.created, objectId(value.customer), value.metadata?.worldfixture_payment_id] : null;
    const expected = [row.amount_cents, currency(row), created, customer, row.id];
    const projectedRow = rows(projected.payments).find(value => value.id === pi);
    compare(`payment.${row.id}.projection`, expected, fields(projectedRow));
    compare(`payment.${row.id}.projection-links`, [charge, invoice], projectedRow ? [projectedRow.charge, projectedRow.invoice ?? null] : null);
    const intent = actual.payment_intents?.find(value => value.id === pi);
    compare(`payment.${row.id}.intent`, expected, fields(intent));
    compare(`payment.${row.id}.intent-state`, ["succeeded", row.amount_cents, charge], intent ? [intent.status, intent.amount_received, objectId(intent.latest_charge)] : null);
    const charged = actual.charges?.find(value => value.id === charge);
    compare(`payment.${row.id}.charge`, expected, fields(charged));
    compare(`payment.${row.id}.charge-state`, [pi, invoice, true, refunded, refunded === row.amount_cents],
      charged ? [objectId(charged.payment_intent), objectId(charged.invoice), charged.paid, charged.amount_refunded, charged.refunded] : null);
    const origin = row.invoice_id ? rows(finance.resolved?.invoices).find(value => value.id === row.invoice_id)
      ?? rows(finance.anchor_invoices).find(value => value.id === row.invoice_id)
      : rows(world.commerce?.orders).find(value => value.id === row.order_id);
    const originDate = seconds(origin?.issued_on ?? origin?.placed_on);
    compare(`payment.${row.id}.date-bounds`, true, created !== null && originDate !== null && created >= originDate
      && (world.clock?.anchor ? created <= seconds(world.clock.anchor) : true));
    if (invoice) {
      const link = actual.invoice_payments?.find(value => value.id === id("inpay", row.id));
      compare(`payment.${row.id}.invoice-link`, [invoice, pi, row.amount_cents, currency(row), created, "paid"],
        link ? [objectId(link.invoice), objectId(link.payment?.payment_intent), link.amount_paid, currency(link), link.status_transitions?.paid_at, link.status] : null);
    }
    if (row.order_id) compare(`payment.${row.id}.order-link`, row.order_id, intent?.metadata?.worldfixture_order_id);
  }
  for (const row of refunds) {
    const expected = [id("pi", row.payment_id), row.amount_cents, currency(row), seconds(row.refunded_on), row.id, row.payment_id];
    const fields = value => value ? [objectId(value.payment_intent), value.amount, currency(value), value.created,
      value.metadata?.worldfixture_refund_id, value.metadata?.worldfixture_payment_id] : null;
    compare(`refund.${row.id}.projection`, expected, fields(rows(projected.refunds).find(value => value.id === id("re", row.id))));
    const served = actual.refunds?.find(value => value.id === id("re", row.id));
    compare(`refund.${row.id}.api`, expected, fields(served));
    compare(`refund.${row.id}.charge`, [id("ch", row.payment_id), "succeeded"], served ? [objectId(served.charge), served.status] : null);
    const payment = payments.find(payment => payment.id === row.payment_id);
    const refundDate = seconds(row.refunded_on), paymentDate = seconds(payment?.paid_on);
    compare(`refund.${row.id}.date-bounds`, true, refundDate !== null && paymentDate !== null && refundDate >= paymentDate
      && (world.clock?.anchor ? refundDate <= seconds(world.clock.anchor) : true));
  }
  const passed = checks.every(check => check.status === "passed");
  for (const kind of ["payments", "refunds"]) for (const prefix of ["finance", "finance.resolved"]) {
    if (prefix === "finance" && !Object.hasOwn(finance, kind)) continue;
    coverage.push({ collection: `${prefix}.${kind}`, provider: "stripe", status: passed ? "passed" : "failed",
      path: "GET /v1/payment_intents; GET /v1/charges; GET /v1/invoice_payments; GET /v1/refunds",
      detail: "Source IDs, dates, amounts, currencies, customer/invoice/order links, one charge per payment, and refund totals." });
  }
  return { checks, coverage };
}
