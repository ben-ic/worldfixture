// Explicit historical settlements enter through the normal provider seed hook.
// An absent transactions key adds no historical records; public routes remain available.
import { randomBytes } from "node:crypto";
import { getStripeStore } from "@emulators/stripe";

const epoch = row => row.created ?? Math.floor(new Date(row.created_at).getTime() / 1000);
const fail = message => { throw new Error(`Stripe transactions: ${message}`); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const currency = value => {
  requireValue(typeof value === "string" && /^[a-z]{3}$/i.test(value), "currency must be an explicit three-letter code");
  return value.toLowerCase();
};
const amount = value => requireValue(Number.isSafeInteger(value) && value > 0, "amount must be a positive safe integer");
const metadata = value => {
  requireValue(value === undefined || (value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === "string")), "metadata must contain strings");
  return { ...value };
};
const refundsFor = store => store.collection("stripe.refunds", ["stripe_id", "charge_id", "payment_intent_id"]);

function invoicePayments(store) {
  // Runtime invoice pay already creates a PaymentIntent with metadata.invoice.
  // Derive its public link without inserting records during a read.
  return getStripeStore(store).paymentIntents.all().filter(row => row.status === "succeeded" && row.metadata?.invoice)
    .map(row => ({ id: row.invoice_payment_id ?? `inpay_${row.stripe_id.slice(3)}`, object: "invoice_payment",
      amount_paid: row.amount, amount_requested: row.amount, currency: row.currency, created: epoch(row),
      invoice: row.metadata.invoice, is_default: false, livemode: false,
      payment: { type: "payment_intent", payment_intent: row.stripe_id }, status: "paid",
      status_transitions: { paid_at: epoch(row), canceled_at: null } }));
}

function formatRefund(row) {
  return { id: row.stripe_id, object: "refund", amount: row.amount, currency: row.currency,
    created: epoch(row), charge: row.charge_id, payment_intent: row.payment_intent_id,
    status: "succeeded", reason: row.reason ?? null, metadata: row.metadata ?? {},
    balance_transaction: null, receipt_number: null };
}

export function seedStripeTransactions(store, config = {}) {
  if (!Object.hasOwn(config, "transactions")) return { enabled: false, payments: 0, refunds: 0 };
  const input = config.transactions;
  requireValue(input && typeof input === "object" && !Array.isArray(input), "transactions must be an object");
  requireValue(Array.isArray(input.payments) && Array.isArray(input.refunds), "payments and refunds must be explicit arrays");
  const stripe = getStripeStore(store);
  const invoices = store.collection("stripe.invoices", ["stripe_id", "customer_id", "status"]);
  const refunds = refundsFor(store);
  const ids = new Set([...stripe.paymentIntents.all(), ...stripe.charges.all(), ...refunds.all()]
    .map(row => row.stripe_id).concat(invoicePayments(store).map(row => row.id)));
  function id(value, prefix) {
    requireValue(typeof value === "string" && value.startsWith(`${prefix}_`) && value.length > prefix.length + 1,
      `an explicit ${prefix}_ ID is required`);
    requireValue(!ids.has(value), `duplicate ID ${value}`);
    ids.add(value);
    return value;
  }
  function common(row) {
    requireValue(row && typeof row === "object" && !Array.isArray(row), "each transaction must be an object");
    amount(row.amount);
    requireValue(Number.isSafeInteger(row.created) && row.created >= 0, "created must be explicit Unix seconds");
    return { amount: row.amount, currency: currency(row.currency), created: row.created, metadata: metadata(row.metadata) };
  }
  const paidByInvoice = new Map();
  const sourceIds = new Set();
  const payments = input.payments.map(row => {
    const fields = common(row);
    requireValue(row.status === undefined || row.status === "succeeded", "only explicit succeeded settlements can be seeded");
    const intentId = id(row.id, "pi");
    const chargeId = id(row.charge, "ch");
    requireValue(stripe.customers.findOneBy("stripe_id", row.customer), `unknown customer ${row.customer}`);
    if (fields.metadata.worldfixture_payment_id) {
      requireValue(!sourceIds.has(fields.metadata.worldfixture_payment_id), `duplicate source payment ${fields.metadata.worldfixture_payment_id}`);
      sourceIds.add(fields.metadata.worldfixture_payment_id);
    }
    let invoicePaymentId = null;
    if (row.invoice !== undefined) {
      const invoice = invoices.findOneBy("stripe_id", row.invoice);
      requireValue(invoice, `unknown invoice ${row.invoice}`);
      requireValue(invoice.customer_id === row.customer, `invoice ${row.invoice} customer mismatch`);
      requireValue(currency(invoice.currency) === fields.currency, `invoice ${row.invoice} currency mismatch`);
      requireValue(["paid", "open"].includes(invoice.status), `invoice ${row.invoice} cannot receive a settlement in state ${invoice.status}`);
      requireValue(row.created >= invoice.created, `payment ${intentId} predates its invoice`);
      requireValue(!fields.metadata.invoice || fields.metadata.invoice === row.invoice, `payment ${intentId} invoice metadata mismatch`);
      fields.metadata.invoice = row.invoice;
      invoicePaymentId = id(row.invoice_payment, "inpay");
      const total = (paidByInvoice.get(row.invoice) ?? 0) + fields.amount;
      requireValue(Number.isSafeInteger(total) && total <= invoice.amount_due, `invoice ${row.invoice} is overpaid`);
      paidByInvoice.set(row.invoice, total);
    } else {
      requireValue(row.invoice_payment === undefined && fields.metadata.invoice === undefined,
        `payment ${intentId} has an invoice link without an explicit invoice`);
    }
    return { ...fields, stripe_id: intentId, charge_id: chargeId, invoice_payment_id: invoicePaymentId,
      customer_id: row.customer, description: row.description ?? null,
      payment_method: row.payment_method ?? null, status: "succeeded" };
  });
  // A fully paid source invoice cannot silently omit its settlement under the
  // explicit contract. Partial payments remain valid for an open invoice.
  for (const invoice of invoices.all()) {
    const paid = paidByInvoice.get(invoice.stripe_id) ?? 0;
    if (invoice.status === "paid") requireValue(paid === invoice.amount_due, `paid invoice ${invoice.stripe_id} has unmatched settlements`);
    if (invoice.status === "open" && paid > 0) requireValue(paid < invoice.amount_due, `fully settled invoice ${invoice.stripe_id} must be paid`);
  }
  const byIntent = new Map(payments.map(row => [row.stripe_id, row]));
  const refunded = new Map();
  const refundSourceIds = new Set();
  const refundRows = input.refunds.map(row => {
    const fields = common(row);
    requireValue(row.status === undefined || row.status === "succeeded", "only succeeded refunds can be seeded");
    requireValue(row.reason === undefined || ["duplicate", "fraudulent", "requested_by_customer"].includes(row.reason), "invalid refund reason");
    const refundId = id(row.id, "re");
    if (fields.metadata.worldfixture_refund_id) {
      requireValue(!refundSourceIds.has(fields.metadata.worldfixture_refund_id), `duplicate source refund ${fields.metadata.worldfixture_refund_id}`);
      refundSourceIds.add(fields.metadata.worldfixture_refund_id);
    }
    const payment = byIntent.get(row.payment_intent);
    requireValue(payment, `refund ${refundId} has an unknown payment ${row.payment_intent}`);
    requireValue(fields.currency === payment.currency, `refund ${refundId} currency mismatch`);
    requireValue(fields.created >= payment.created, `refund ${refundId} predates its payment`);
    const total = (refunded.get(payment.stripe_id) ?? 0) + fields.amount;
    requireValue(Number.isSafeInteger(total) && total <= payment.amount, `refunds exceed payment ${payment.stripe_id}`);
    refunded.set(payment.stripe_id, total);
    return { ...fields, stripe_id: refundId, charge_id: payment.charge_id, payment_intent_id: payment.stripe_id,
      reason: row.reason ?? null };
  });
  // No records or lifecycle flag change until the complete input passes.
  for (const payment of payments) {
    stripe.paymentIntents.insert(payment);
    stripe.charges.insert({ ...payment, stripe_id: payment.charge_id, payment_intent_id: payment.stripe_id });
  }
  for (const refund of refundRows) refunds.insert(refund);
  for (const [invoiceId, paid] of paidByInvoice) {
    const invoice = invoices.findOneBy("stripe_id", invoiceId);
    const lastPayment = Math.max(...payments.filter(row => row.metadata.invoice === invoiceId).map(row => row.created));
    invoices.update(invoice.id, { amount_paid: paid, status_transitions: { ...invoice.status_transitions,
      paid_at: invoice.status === "paid" ? lastPayment : null } });
  }
  return { enabled: true, payments: payments.length, refunds: refundRows.length };
}

function error(c, message, code = "resource_missing", status = 400) {
  return c.json({ error: { type: "invalid_request_error", code, message } }, status);
}

function list(c, rows, path) {
  const limit = Number(c.req.query("limit") ?? 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(c, "limit must be an integer between 1 and 100", "parameter_invalid_integer");
  const after = c.req.query("starting_after");
  const before = c.req.query("ending_before");
  if (after !== undefined && before !== undefined) return error(c, "Specify only one pagination cursor");
  rows = [...rows].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  let start = 0;
  let end = rows.length;
  if (after !== undefined) {
    start = rows.findIndex(row => row.id === after) + 1;
    if (!start) return error(c, `No such object: '${after}'`);
  }
  if (before !== undefined) {
    end = rows.findIndex(row => row.id === before);
    if (end < 0) return error(c, `No such object: '${before}'`);
    start = Math.max(0, end - limit);
  }
  const data = rows.slice(start, Math.min(end, start + limit));
  return c.json({ object: "list", url: path, data, has_more: before !== undefined ? start > 0 : start + data.length < end });
}

async function bodyOf(c) {
  if (c.req.header("content-type")?.includes("application/json")) return c.req.json();
  const body = {};
  for (const [key, value] of new URLSearchParams(await c.req.text())) {
    const match = /^metadata\[([^\]]+)\]$/.exec(key);
    if (match) (body.metadata ??= {})[match[1]] = value;
    else body[key] = value;
  }
  return body;
}

export function extendStripeTransactionsPlugin(upstream) {
  return { ...upstream, register(app, store, webhooks, ...args) {
    const stripe = getStripeStore(store);
    const refunds = refundsFor(store);
    // Enrich upstream responses rather than replace existing response contracts.
    app.use("*", async (c, next) => {
      function enrich(row) {
        if (!row || typeof row !== "object") return row;
        if (row.object === "list") return { ...row, data: row.data.map(enrich) };
        if (row.object === "invoice") {
          const rows = invoicePayments(store).filter(payment => payment.invoice === row.id);
          return { ...row, payments: { object: "list", data: rows.slice(0, 10), has_more: rows.length > 10,
            total_count: rows.length, url: `/v1/invoice_payments?invoice=${encodeURIComponent(row.id)}` } };
        }
        const collection = row.object === "payment_intent" ? stripe.paymentIntents : row.object === "charge" ? stripe.charges : null;
        const stored = collection?.findOneBy("stripe_id", row.id);
        if (!stored) return row;
        if (row.object === "payment_intent") return { ...row, created: epoch(stored),
          amount_received: stored.status === "succeeded" ? stored.amount : 0,
          latest_charge: stripe.charges.findOneBy("payment_intent_id", stored.stripe_id)?.stripe_id ?? null };
        const chargeRefunds = refunds.findBy("charge_id", row.id).map(formatRefund);
        const amountRefunded = chargeRefunds.reduce((sum, refund) => sum + refund.amount, 0);
        return { ...row, created: epoch(stored), paid: stored.status === "succeeded", invoice: stored.metadata?.invoice ?? null,
          amount_refunded: amountRefunded, refunded: amountRefunded === stored.amount,
          refunds: { object: "list", data: chargeRefunds.slice(0, 10), has_more: chargeRefunds.length > 10,
            url: `/v1/refunds?charge=${encodeURIComponent(row.id)}` } };
      }
      // The pinned core Context returns Responses directly; it has no c.res.
      const json = c.json;
      c.json = function(value, ...options) { return json.call(this, enrich(value), ...options); };
      try { await next(); } finally { c.json = json; }
    });
    app.get("/v1/invoice_payments", (c) => {
      let rows = invoicePayments(store);
      if (c.req.query("invoice")) rows = rows.filter(row => row.invoice === c.req.query("invoice"));
      if (c.req.query("status")) rows = rows.filter(row => row.status === c.req.query("status"));
      if (c.req.query("payment[type]")) rows = rows.filter(row => row.payment.type === c.req.query("payment[type]"));
      if (c.req.query("payment[payment_intent]")) rows = rows.filter(row => row.payment.payment_intent === c.req.query("payment[payment_intent]"));
      return list(c, rows, "/v1/invoice_payments");
    });
    app.get("/v1/invoice_payments/:id", (c) => {
      const row = invoicePayments(store).find(item => item.id === c.req.param("id"));
      return row ? c.json(row) : error(c, `No such invoice payment: '${c.req.param("id")}'`, "resource_missing", 404);
    });
    app.get("/v1/refunds", (c) => {
      let rows = refunds.all();
      if (c.req.query("charge")) rows = rows.filter(row => row.charge_id === c.req.query("charge"));
      if (c.req.query("payment_intent")) rows = rows.filter(row => row.payment_intent_id === c.req.query("payment_intent"));
      return list(c, rows.map(formatRefund), "/v1/refunds");
    });
    app.get("/v1/refunds/:id", (c) => {
      const row = refunds.findOneBy("stripe_id", c.req.param("id"));
      return row ? c.json(formatRefund(row)) : error(c, `No such refund: '${c.req.param("id")}'`, "resource_missing", 404);
    });
    app.post("/v1/refunds", async (c) => {
      let body;
      try { body = await bodyOf(c); } catch { return error(c, "Invalid request body"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return error(c, "Invalid request body");
      if (Boolean(body.charge) === Boolean(body.payment_intent)) return error(c, "Supply one charge or payment_intent");
      const charge = body.charge ? stripe.charges.findOneBy("stripe_id", body.charge)
        : stripe.charges.findOneBy("payment_intent_id", body.payment_intent);
      if (!charge) return error(c, "No such charge or payment_intent");
      if (charge.status !== "succeeded") return error(c, "Only a succeeded charge can be refunded");
      const refunded = refunds.findBy("charge_id", charge.stripe_id).reduce((sum, row) => sum + row.amount, 0);
      if (body.amount !== undefined && !["string", "number"].includes(typeof body.amount)) return error(c, "amount must be an integer", "parameter_invalid_integer");
      const value = body.amount === undefined ? charge.amount - refunded : Number(body.amount);
      try { amount(value); metadata(body.metadata); } catch (cause) { return error(c, cause.message, "parameter_invalid_integer"); }
      if (value > charge.amount - refunded) return error(c, "Refund amount exceeds the remaining charge amount", "charge_already_refunded");
      if (body.currency !== undefined && String(body.currency).toLowerCase() !== charge.currency) return error(c, "Refund currency does not match charge");
      if (body.reason !== undefined && !["duplicate", "fraudulent", "requested_by_customer"].includes(body.reason)) return error(c, "Invalid refund reason");
      const row = refunds.insert({ stripe_id: `re_${randomBytes(12).toString("hex")}`, amount: value,
        currency: charge.currency, created: Math.floor(Date.now() / 1000), charge_id: charge.stripe_id,
        payment_intent_id: charge.payment_intent_id, metadata: body.metadata ?? {}, reason: body.reason ?? null });
      const result = formatRefund(row);
      await webhooks.dispatch("refund.created", undefined, { type: "refund.created", data: { object: result } }, "stripe");
      return c.json(result);
    });
    upstream.register(app, store, webhooks, ...args);
  } };
}
