import { randomBytes } from "node:crypto";
import { getStripeStore } from "@emulators/stripe";

const now = () => Math.floor(Date.now() / 1000);
const stripeId = (prefix) => `${prefix}_${randomBytes(12).toString("base64url").slice(0, 24)}`;
const asBoolean = (value) => value === true || value === "true" || value === "1";

async function stripeBody(c) {
  const contentType = c.req.header("Content-Type") ?? "";
  const raw = await c.req.text();
  if (!raw) return {};
  if (contentType.includes("application/json")) return JSON.parse(raw);
  const result = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const parts = key.replaceAll("]", "").split("[");
    let target = result;
    for (let index = 0; index < parts.length - 1; index += 1) {
      target[parts[index]] ??= /^\d+$/.test(parts[index + 1]) ? [] : {};
      target = target[parts[index]];
    }
    target[parts.at(-1)] = value;
  }
  return result;
}

function error(c, status, message, code = "resource_missing") {
  return c.json({ error: { type: "invalid_request_error", message, code } }, status);
}

// PAGINATION IS VALIDATED, NOT COERCED. Both parameters used to be guessed at,
// and both guesses were wrong in a way the caller could not see.
//
// `Number(query("limit") ?? 10) || 10` reads as "default to 10". It is also what
// happens for `limit=0` and for `limit=abc`, because `0 || 10` and `NaN || 10`
// are both 10. Measured against the live listener before this was written:
// `GET /v1/invoices?limit=0` answered with ten invoices and `has_more: true`,
// and so did `?limit=abc`. Stripe refuses both. `??` alone would not have fixed
// it either -- it would have turned `limit=0` into a silent one-row page.
//
// `starting_after` was the worse half. An id the collection does not contain
// gives `findIndex` -1, `-1 + 1` is 0, and `Math.max(0, 0)` is 0, so an unknown
// or expired cursor silently re-served page one. Measured:
// `?limit=2&starting_after=in_doesnotexist` returned 200 with the same two
// invoices as `?limit=2` and `has_more: true`, so a client paging until
// `has_more` goes false walks the first page forever and never terminates.
// Stripe answers 400 `resource_missing` for a cursor it cannot resolve.
function list(c, values, path, formatter) {
  const rawLimit = c.req.query("limit");
  let limit = 10;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit)) return error(c, 400, `Invalid integer: ${rawLimit}`, "parameter_invalid_integer");
    if (limit < 1) return error(c, 400, "This value must be greater than or equal to 1.", "parameter_invalid_integer");
    if (limit > 100) return error(c, 400, "This value must be less than or equal to 100.", "parameter_invalid_integer");
  }

  const startingAfter = c.req.query("starting_after");
  let start = 0;
  if (startingAfter !== undefined) {
    start = values.findIndex((item) => item.stripe_id === startingAfter) + 1;
    if (start === 0) return error(c, 400, `No such object: '${startingAfter}'`);
  }

  const data = values.slice(start, start + limit).map(formatter);
  return c.json({ object: "list", url: path, has_more: start + limit < values.length, data });
}

function invoiceStore(store) {
  return {
    invoices: store.collection("stripe.invoices", ["stripe_id", "customer_id", "status"]),
    invoiceItems: store.collection("stripe.invoice_items", ["stripe_id", "customer_id", "invoice_id"]),
    subscriptions: store.collection("stripe.subscriptions", ["stripe_id", "customer_id", "status"]),
  };
}

function formatPrice(price) {
  if (!price) return null;
  return { id: price.stripe_id, object: "price", active: price.active, billing_scheme: "per_unit", created: Math.floor(new Date(price.created_at).getTime() / 1000),
    currency: price.currency, custom_unit_amount: null, livemode: false, lookup_key: null, metadata: price.metadata ?? {}, nickname: null,
    product: price.product_id, recurring: price.type === "recurring" ? { interval: "month", interval_count: 1, trial_period_days: null, usage_type: "licensed" } : null,
    tax_behavior: "unspecified", tiers_mode: null, transform_quantity: null, type: price.type,
    unit_amount: price.unit_amount, unit_amount_decimal: String(price.unit_amount) };
}

function formatInvoiceItem(item, prices) {
  const price = item.price_id ? prices?.findOneBy("stripe_id", item.price_id) : null;
  return { id: item.stripe_id, object: "invoiceitem", amount: item.amount, currency: item.currency,
    customer: item.customer_id, customer_account: null, date: item.created, description: item.description,
    discountable: true, discounts: [], frozen_fields: null, invoice: item.invoice_id, livemode: false, metadata: item.metadata ?? {},
    net_amount: item.amount, parent: null, period: { start: item.created, end: item.created },
    pricing: { price_details: price ? { price: price.stripe_id, product: price.product_id } : { price: null, product: null },
      type: "price_details", unit_amount_decimal: String(item.amount) }, proration: false, proration_details: { credited_items: null }, quantity: 1,
    quantity_decimal: "1", tax_rates: [], test_clock: null };
}

function formatInvoiceLine(item, prices) {
  const invoiceItem = formatInvoiceItem(item, prices);
  return { id: `il_${item.stripe_id.slice(3)}`, object: "line_item", amount: item.amount, currency: item.currency,
    description: item.description, discount_amounts: [], discountable: true, discounts: [], invoice: item.invoice_id,
    livemode: false, metadata: item.metadata ?? {}, parent: { invoice_item_details: { invoice_item: item.stripe_id, proration: false,
      proration_details: { credited_items: null }, subscription: null }, type: "invoice_item_details" }, period: invoiceItem.period,
    pretax_credit_amounts: [], pricing: invoiceItem.pricing, quantity: 1, quantity_decimal: "1", subscription: null,
    subtotal: item.amount, taxes: [] };
}

function formatInvoice(invoice, items, stripe) {
  const customer = stripe?.customers.findOneBy("stripe_id", invoice.customer_id);
  const lines = items.filter((item) => item.invoice_id === invoice.stripe_id).map((item) => formatInvoiceLine(item, stripe?.prices));
  const remaining = Math.max(0, invoice.amount_due - invoice.amount_paid);
  return { id: invoice.stripe_id, object: "invoice", account_country: "US", account_name: "WorldFixture",
    account_tax_ids: null, amount_due: invoice.amount_due, amount_overpaid: 0, amount_paid: invoice.amount_paid,
    amount_paid_off_stripe: 0, amount_remaining: remaining, amount_shipping: 0, application: null,
    attempt_count: invoice.attempt_count ?? 0, attempted: invoice.attempted ?? false, auto_advance: invoice.auto_advance ?? false,
    automatic_tax: { enabled: false, liability: null, status: null }, automatically_finalizes_at: null,
    billing_reason: invoice.billing_reason ?? "manual", collection_method: invoice.collection_method, confirmation_secret: null,
    created: invoice.created, currency: invoice.currency, custom_fields: null, customer: invoice.customer_id,
    customer_account: null, customer_address: null, customer_email: customer?.email ?? null, customer_name: customer?.name ?? null,
    customer_phone: null, customer_shipping: null, customer_tax_exempt: "none", customer_tax_ids: [],
    default_payment_method: null, default_source: null, default_tax_rates: [], description: invoice.description,
    discounts: [], due_date: invoice.collection_method === "send_invoice" ? invoice.due_date : null, effective_at: null,
    ending_balance: invoice.status === "draft" ? null : 0, footer: null, from_invoice: null,
    hosted_invoice_url: null, invoice_pdf: null, issuer: { type: "self" }, last_finalization_error: null,
    latest_revision: null, lines: { object: "list", data: lines, has_more: false, total_count: lines.length,
      url: `/v1/invoices/${invoice.stripe_id}/lines` }, livemode: false, metadata: invoice.metadata ?? {},
    next_payment_attempt: null, number: invoice.number, on_behalf_of: null, parent: null,
    payment_settings: { default_mandate: null, payment_method_options: null, payment_method_types: null },
    payments: { object: "list", data: [], has_more: false, total_count: 0, url: "/v1/invoice_payments" },
    period_end: invoice.created, period_start: invoice.created, post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0, receipt_number: null, rendering: null, shipping_cost: null,
    shipping_details: null, starting_balance: 0, statement_descriptor: null, status: invoice.status,
    status_transitions: invoice.status_transitions ?? { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    subtotal: invoice.amount_due, subtotal_excluding_tax: invoice.amount_due, test_clock: null, threshold_reason: null, total: invoice.amount_due,
    total_discount_amounts: [], total_excluding_tax: invoice.amount_due, total_pretax_credit_amounts: [], total_taxes: [],
    webhooks_delivered_at: invoice.created };
}

function formatPaymentIntent(paymentIntent) {
  return { id: paymentIntent.stripe_id, object: "payment_intent", amount: paymentIntent.amount,
    currency: paymentIntent.currency, status: paymentIntent.status, customer: paymentIntent.customer_id,
    description: paymentIntent.description, payment_method: paymentIntent.payment_method,
    metadata: paymentIntent.metadata ?? {}, created: Math.floor(new Date(paymentIntent.created_at).getTime() / 1000), livemode: false };
}

function formatCharge(charge) {
  return { id: charge.stripe_id, object: "charge", amount: charge.amount, currency: charge.currency,
    status: charge.status, customer: charge.customer_id, payment_intent: charge.payment_intent_id,
    description: charge.description, metadata: charge.metadata ?? {},
    created: Math.floor(new Date(charge.created_at).getTime() / 1000), livemode: false };
}

function formatSubscription(subscription, prices) {
  const price = prices.findOneBy("stripe_id", subscription.price_id);
  const formattedPrice = formatPrice(price);
  const plan = price ? { id: price.stripe_id, object: "plan", active: price.active, amount: price.unit_amount,
    amount_decimal: String(price.unit_amount), billing_scheme: "per_unit", created: formattedPrice.created,
    currency: price.currency, discounts: null, interval: "month", interval_count: 1, livemode: false,
    metadata: price.metadata ?? {}, meter: null, nickname: null, product: price.product_id, tiers_mode: null,
    transform_usage: null, trial_period_days: null, usage_type: "licensed" } : null;
  const item = { id: `si_${subscription.stripe_id.slice(4)}`, object: "subscription_item", billing_thresholds: null,
    created: subscription.created, current_period_end: subscription.current_period_end,
    current_period_start: subscription.current_period_start, discounts: [], metadata: {}, plan,
    price: formattedPrice, quantity: 1, subscription: subscription.stripe_id, tax_rates: [] };
  return { id: subscription.stripe_id, object: "subscription", application: null, application_fee_percent: null,
    automatic_tax: { enabled: false, liability: null }, billing_cycle_anchor: subscription.current_period_start,
    billing_cycle_anchor_config: null, billing_mode: { flexible: null, type: "classic", updated_at: null }, billing_schedules: [],
    billing_thresholds: null, cancel_at: subscription.cancel_at ?? null, cancel_at_period_end: subscription.cancel_at_period_end,
    canceled_at: subscription.canceled_at, cancellation_details: subscription.cancellation_details ?? { comment: null, feedback: null, reason: null },
    collection_method: "charge_automatically", created: subscription.created, currency: price?.currency ?? "usd",
    customer: subscription.customer_id, customer_account: null, days_until_due: null, default_payment_method: null,
    default_source: null, default_tax_rates: [], description: null, discounts: null,
    ended_at: subscription.status === "canceled" ? subscription.canceled_at : null, invoice_settings: { issuer: { type: "self" } },
    items: { object: "list", data: [item], has_more: false, total_count: 1,
      url: `/v1/subscription_items?subscription=${subscription.stripe_id}` }, latest_invoice: subscription.latest_invoice ?? null,
    livemode: false, managed_payments: null, metadata: subscription.metadata ?? {}, next_pending_invoice_item_invoice: null,
    on_behalf_of: null, pause_collection: null, payment_settings: { payment_method_options: null,
      payment_method_types: null, save_default_payment_method: "off" }, pending_invoice_item_interval: null,
    pending_setup_intent: null, pending_update: null, presentment_details: null, schedule: null, start_date: subscription.created,
    status: subscription.status, test_clock: null, transfer_data: null, trial_end: null,
    trial_settings: { end_behavior: { missing_payment_method: "create_invoice" } }, trial_start: null };
}

export function registerStripeBilling(app, store, webhooks) {
  const billing = invoiceStore(store);
  const stripe = getStripeStore(store);

  app.post("/v1/invoiceitems", async (c) => {
    const body = await stripeBody(c);
    if (!stripe.customers.findOneBy("stripe_id", body.customer)) return error(c, 404, `No such customer: '${body.customer}'`);
    const priceId = body.pricing?.price ?? body.price ?? null;
    const price = priceId ? stripe.prices.findOneBy("stripe_id", priceId) : null;
    if (priceId && !price) return error(c, 404, `No such price: '${priceId}'`);
    const amount = Number(body.amount ?? price?.unit_amount);
    if (!Number.isInteger(amount)) return error(c, 400, "The amount must be an integer in cents.", "parameter_invalid_integer");
    const targetInvoice = body.invoice ? billing.invoices.findOneBy("stripe_id", body.invoice) : null;
    if (body.invoice && !targetInvoice) return error(c, 404, `No such invoice: '${body.invoice}'`);
    if (targetInvoice && targetInvoice.status !== "draft") return error(c, 400, "Invoice items can only be added to a draft invoice.", "invoice_not_editable");
    const item = billing.invoiceItems.insert({ stripe_id: stripeId("ii"), customer_id: body.customer,
      invoice_id: body.invoice ?? null, amount, currency: String(body.currency ?? price?.currency ?? "usd").toLowerCase(),
      description: body.description ?? null, price_id: priceId,
      metadata: body.metadata ?? {}, created: now() });
    if (item.invoice_id) {
      const invoice = billing.invoices.findOneBy("stripe_id", item.invoice_id);
      billing.invoices.update(invoice.id, { amount_due: invoice.amount_due + amount });
    }
    return c.json(formatInvoiceItem(item, stripe.prices));
  });
  app.get("/v1/invoiceitems", (c) => {
    let values = billing.invoiceItems.all();
    if (c.req.query("customer")) values = values.filter((item) => item.customer_id === c.req.query("customer"));
    if (c.req.query("invoice")) values = values.filter((item) => item.invoice_id === c.req.query("invoice"));
    if (c.req.query("pending") === "true") values = values.filter((item) => !item.invoice_id);
    return list(c, values, "/v1/invoiceitems", (item) => formatInvoiceItem(item, stripe.prices));
  });
  app.get("/v1/invoiceitems/:id", (c) => {
    const item = billing.invoiceItems.findOneBy("stripe_id", c.req.param("id"));
    return item ? c.json(formatInvoiceItem(item, stripe.prices)) : error(c, 404, `No such invoiceitem: '${c.req.param("id")}'`);
  });
  app.delete("/v1/invoiceitems/:id", (c) => {
    const item = billing.invoiceItems.findOneBy("stripe_id", c.req.param("id"));
    if (!item) return error(c, 404, `No such invoiceitem: '${c.req.param("id")}'`);
    const invoice = item.invoice_id ? billing.invoices.findOneBy("stripe_id", item.invoice_id) : null;
    if (invoice && invoice.status !== "draft") return error(c, 400, "Invoice items can only be deleted from a draft invoice.", "invoice_not_editable");
    if (invoice) billing.invoices.update(invoice.id, { amount_due: invoice.amount_due - item.amount });
    billing.invoiceItems.delete(item.id);
    return c.json({ id: item.stripe_id, object: "invoiceitem", deleted: true });
  });

  app.post("/v1/invoices", async (c) => {
    const body = await stripeBody(c);
    if (!stripe.customers.findOneBy("stripe_id", body.customer)) return error(c, 404, `No such customer: '${body.customer}'`);
    const created = now();
    const collectionMethod = body.collection_method ?? "charge_automatically";
    // PRESENCE, not truthiness. `stripeBody` also parses JSON, and a JSON body
    // saying `"days_until_due": 0` -- due today -- put a `0` on the right of the
    // old `||`, so the guard did not fire and a `charge_automatically` invoice was
    // created with `due_date: null` instead of the 400 Stripe answers. A
    // form-encoded body was unaffected, because `"0"` is truthy, which is exactly
    // the kind of difference between two encodings of the same request that a
    // fixture must not have.
    if (collectionMethod === "charge_automatically" && (body.due_date !== undefined || body.days_until_due !== undefined)) {
      return error(c, 400, "The due_date and days_until_due fields are only valid for send_invoice invoices.", "parameter_invalid_integer");
    }
    const dueDate = collectionMethod === "send_invoice"
      ? (body.due_date !== undefined ? Number(body.due_date) : created + Number(body.days_until_due ?? 30) * 86400)
      : null;
    const invoice = billing.invoices.insert({ stripe_id: stripeId("in"), number: null, customer_id: body.customer,
      description: body.description ?? null, currency: String(body.currency ?? "usd").toLowerCase(), status: "draft",
      collection_method: collectionMethod, created, due_date: dueDate, auto_advance: asBoolean(body.auto_advance),
      amount_due: 0, amount_paid: 0, attempt_count: 0, attempted: false,
      status_transitions: { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null }, metadata: body.metadata ?? {} });
    if (body.pending_invoice_items_behavior === "include") {
      for (const pending of billing.invoiceItems.findBy("customer_id", body.customer).filter((item) => !item.invoice_id)) {
        billing.invoiceItems.update(pending.id, { invoice_id: invoice.stripe_id });
        invoice.amount_due += pending.amount;
      }
    }
    billing.invoices.update(invoice.id, { amount_due: invoice.amount_due });
    await webhooks.dispatch("invoice.created", undefined, { type: "invoice.created", data: { object: formatInvoice(invoice, billing.invoiceItems.all(), stripe) } }, "stripe");
    return c.json(formatInvoice(invoice, billing.invoiceItems.all(), stripe));
  });

  app.get("/v1/invoices", (c) => {
    let values = billing.invoices.all();
    if (c.req.query("customer")) values = values.filter((item) => item.customer_id === c.req.query("customer"));
    if (c.req.query("status")) values = values.filter((item) => item.status === c.req.query("status"));
    return list(c, values, "/v1/invoices", (invoice) => formatInvoice(invoice, billing.invoiceItems.all(), stripe));
  });
  app.get("/v1/invoices/:id", (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    return invoice ? c.json(formatInvoice(invoice, billing.invoiceItems.all(), stripe)) : error(c, 404, `No such invoice: '${c.req.param("id")}'`);
  });
  app.post("/v1/invoices/:id", async (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return error(c, 404, `No such invoice: '${c.req.param("id")}'`);
    if (invoice.status !== "draft") return error(c, 400, "Only a draft invoice can be updated.", "invoice_not_editable");
    const body = await stripeBody(c);
    const updated = billing.invoices.update(invoice.id, { description: body.description ?? invoice.description,
      auto_advance: body.auto_advance === undefined ? invoice.auto_advance : asBoolean(body.auto_advance),
      due_date: body.due_date === undefined ? invoice.due_date : Number(body.due_date),
      metadata: body.metadata ?? invoice.metadata });
    await webhooks.dispatch("invoice.updated", undefined, { type: "invoice.updated", data: { object: formatInvoice(updated, billing.invoiceItems.all(), stripe) } }, "stripe");
    return c.json(formatInvoice(updated, billing.invoiceItems.all(), stripe));
  });
  app.delete("/v1/invoices/:id", (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return error(c, 404, `No such invoice: '${c.req.param("id")}'`);
    if (invoice.status !== "draft") return error(c, 400, "Only a draft invoice can be deleted.", "invoice_not_editable");
    for (const item of billing.invoiceItems.findBy("invoice_id", invoice.stripe_id)) billing.invoiceItems.delete(item.id);
    billing.invoices.delete(invoice.id);
    return c.json({ id: invoice.stripe_id, object: "invoice", deleted: true });
  });
  app.get("/v1/invoices/:id/lines", (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return error(c, 404, `No such invoice: '${c.req.param("id")}'`);
    return list(c, billing.invoiceItems.findBy("invoice_id", invoice.stripe_id), `/v1/invoices/${invoice.stripe_id}/lines`, (item) => formatInvoiceLine(item, stripe.prices));
  });
  app.post("/v1/invoices/:id/finalize", async (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return error(c, 404, `No such invoice: '${c.req.param("id")}'`);
    if (invoice.status !== "draft") return error(c, 400, "Only a draft invoice can be finalized.", "invoice_not_editable");
    const timestamp = now();
    const updated = billing.invoices.update(invoice.id, { status: "open", number: invoice.number ?? `WF-${String(invoice.id).padStart(6, "0")}`,
      status_transitions: { ...invoice.status_transitions, finalized_at: timestamp } });
    await webhooks.dispatch("invoice.finalized", undefined, { type: "invoice.finalized", data: { object: formatInvoice(updated, billing.invoiceItems.all(), stripe) } }, "stripe");
    return c.json(formatInvoice(updated, billing.invoiceItems.all(), stripe));
  });
  app.post("/v1/invoices/:id/pay", async (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return error(c, 404, `No such invoice: '${c.req.param("id")}'`);
    if (invoice.status !== "open") return error(c, 400, "Only an open invoice can be paid.", "invoice_payment_state_invalid");
    const body = await stripeBody(c);
    let paymentIntent = null;
    if (!asBoolean(body.paid_out_of_band)) {
      paymentIntent = stripe.paymentIntents.insert({ stripe_id: stripeId("pi"), amount: invoice.amount_due,
        currency: invoice.currency, status: "succeeded", customer_id: invoice.customer_id,
        description: invoice.description, payment_method: body.payment_method ?? "pm_card_visa", metadata: { invoice: invoice.stripe_id } });
      const charge = stripe.charges.insert({ stripe_id: stripeId("ch"), amount: invoice.amount_due, currency: invoice.currency,
        status: "succeeded", customer_id: invoice.customer_id, payment_intent_id: paymentIntent.stripe_id,
        description: invoice.description, metadata: { invoice: invoice.stripe_id } });
      await webhooks.dispatch("payment_intent.succeeded", undefined,
        { type: "payment_intent.succeeded", data: { object: formatPaymentIntent(paymentIntent) } }, "stripe");
      await webhooks.dispatch("charge.succeeded", undefined,
        { type: "charge.succeeded", data: { object: formatCharge(charge) } }, "stripe");
    }
    const timestamp = now();
    const updated = billing.invoices.update(invoice.id, { status: "paid", amount_paid: invoice.amount_due,
      attempt_count: 1, attempted: true, status_transitions: { ...invoice.status_transitions, paid_at: timestamp } });
    await webhooks.dispatch("invoice.paid", undefined, { type: "invoice.paid", data: { object: formatInvoice(updated, billing.invoiceItems.all(), stripe) } }, "stripe");
    await webhooks.dispatch("invoice.payment_succeeded", undefined,
      { type: "invoice.payment_succeeded", data: { object: formatInvoice(updated, billing.invoiceItems.all(), stripe) } }, "stripe");
    return c.json(formatInvoice(updated, billing.invoiceItems.all(), stripe));
  });
  app.post("/v1/invoices/:id/void", async (c) => {
    const invoice = billing.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return error(c, 404, `No such invoice: '${c.req.param("id")}'`);
    if (invoice.status !== "open") return error(c, 400, "Only an open invoice can be voided.", "invoice_not_editable");
    const updated = billing.invoices.update(invoice.id, { status: "void", status_transitions: { ...invoice.status_transitions, voided_at: now() } });
    await webhooks.dispatch("invoice.voided", undefined, { type: "invoice.voided", data: { object: formatInvoice(updated, billing.invoiceItems.all(), stripe) } }, "stripe");
    return c.json(formatInvoice(updated, billing.invoiceItems.all(), stripe));
  });

  app.post("/v1/subscriptions", async (c) => {
    const body = await stripeBody(c);
    if (!stripe.customers.findOneBy("stripe_id", body.customer)) return error(c, 404, `No such customer: '${body.customer}'`);
    const priceId = body.items?.[0]?.price ?? body.price;
    if (!stripe.prices.findOneBy("stripe_id", priceId)) return error(c, 404, `No such price: '${priceId}'`);
    const created = now();
    const subscription = billing.subscriptions.insert({ stripe_id: stripeId("sub"), customer_id: body.customer,
      price_id: priceId, status: "active", cancel_at_period_end: false, canceled_at: null,
      current_period_start: created, current_period_end: created + 30 * 86400, created, metadata: body.metadata ?? {} });
    await webhooks.dispatch("customer.subscription.created", undefined, { type: "customer.subscription.created", data: { object: formatSubscription(subscription, stripe.prices) } }, "stripe");
    return c.json(formatSubscription(subscription, stripe.prices));
  });
  app.get("/v1/subscriptions", (c) => {
    let values = billing.subscriptions.all();
    if (c.req.query("customer")) values = values.filter((item) => item.customer_id === c.req.query("customer"));
    if (c.req.query("status") && c.req.query("status") !== "all") values = values.filter((item) => item.status === c.req.query("status"));
    return list(c, values, "/v1/subscriptions", (subscription) => formatSubscription(subscription, stripe.prices));
  });
  app.get("/v1/subscriptions/:id", (c) => {
    const subscription = billing.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    return subscription ? c.json(formatSubscription(subscription, stripe.prices)) : error(c, 404, `No such subscription: '${c.req.param("id")}'`);
  });
  app.post("/v1/subscriptions/:id", async (c) => {
    const subscription = billing.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!subscription) return error(c, 404, `No such subscription: '${c.req.param("id")}'`);
    const body = await stripeBody(c);
    const cancelAtPeriodEnd = body.cancel_at_period_end === undefined ? subscription.cancel_at_period_end : asBoolean(body.cancel_at_period_end);
    const priceId = body.items?.[0]?.price ?? subscription.price_id;
    if (!stripe.prices.findOneBy("stripe_id", priceId)) return error(c, 404, `No such price: '${priceId}'`);
    const updated = billing.subscriptions.update(subscription.id, { cancel_at_period_end: cancelAtPeriodEnd,
      cancel_at: cancelAtPeriodEnd ? subscription.current_period_end : null, price_id: priceId,
      metadata: body.metadata ?? subscription.metadata });
    await webhooks.dispatch("customer.subscription.updated", undefined, { type: "customer.subscription.updated", data: { object: formatSubscription(updated, stripe.prices) } }, "stripe");
    return c.json(formatSubscription(updated, stripe.prices));
  });
  app.delete("/v1/subscriptions/:id", async (c) => {
    const subscription = billing.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!subscription) return error(c, 404, `No such subscription: '${c.req.param("id")}'`);
    const timestamp = now();
    const updated = billing.subscriptions.update(subscription.id, { status: "canceled", canceled_at: timestamp,
      ended_at: timestamp, cancel_at_period_end: false,
      cancellation_details: { comment: null, feedback: null, reason: "cancellation_requested" } });
    await webhooks.dispatch("customer.subscription.deleted", undefined, { type: "customer.subscription.deleted", data: { object: formatSubscription(updated, stripe.prices) } }, "stripe");
    return c.json(formatSubscription(updated, stripe.prices));
  });
}

export function seedStripeBilling(store, config = {}) {
  const billing = invoiceStore(store);
  const stripe = getStripeStore(store);
  if (Array.isArray(config.customers)) {
    const declaredIds = new Set(config.customers.map((customer) => customer.id).filter(Boolean));
    const declaredEmails = new Set(config.customers.map((customer) => customer.email).filter(Boolean));
    for (const customer of stripe.customers.all()) {
      if (!declaredIds.has(customer.stripe_id) && !declaredEmails.has(customer.email)) stripe.customers.delete(customer.id);
    }
  }
  for (const source of config.prices ?? []) {
    const price = source.id ? stripe.prices.findOneBy("stripe_id", source.id) : null;
    if (price && source.recurring) stripe.prices.update(price.id, { type: "recurring", metadata: { ...price.metadata, worldfixture_customer_id: source.worldfixture_customer_id } });
  }
  for (const source of config.subscriptions ?? []) {
    billing.subscriptions.insert({ stripe_id: source.id ?? stripeId("sub"), customer_id: source.customer,
      price_id: source.price, status: source.status ?? "active", cancel_at_period_end: false, canceled_at: null,
      cancel_at: null, current_period_start: source.current_period_start ?? now(), current_period_end: source.current_period_end ?? now() + 30 * 86400,
      created: source.created ?? now(), metadata: source.metadata ?? {} });
  }
  for (const source of config.invoices ?? []) {
    const invoice = billing.invoices.insert({ stripe_id: source.id ?? stripeId("in"), number: source.number ?? null,
      customer_id: source.customer, description: source.description ?? null, currency: String(source.currency ?? "usd").toLowerCase(),
      status: source.status ?? "draft", collection_method: source.collection_method ?? "send_invoice",
      created: source.created ?? now(), due_date: source.due_date ?? null, amount_due: source.amount_due ?? 0,
      amount_paid: source.status === "paid" ? source.amount_due ?? 0 : 0, attempt_count: source.status === "paid" ? 1 : 0,
      attempted: source.status === "paid", auto_advance: false,
      status_transitions: { finalized_at: source.status === "draft" ? null : source.created ?? now(), marked_uncollectible_at: null,
        paid_at: source.status === "paid" ? source.created ?? now() : null, voided_at: source.status === "void" ? source.created ?? now() : null },
      metadata: source.metadata ?? {} });
    billing.invoiceItems.insert({ stripe_id: stripeId("ii"), customer_id: source.customer, invoice_id: invoice.stripe_id,
      amount: source.amount_due ?? 0, currency: invoice.currency, description: invoice.description, price_id: null, created: invoice.created });
  }
}

export function extendStripePlugin(upstream) {
  return { ...upstream, register(app, store, webhooks, baseUrl, tokenMap) {
    upstream.register(app, store, webhooks, baseUrl, tokenMap);
    registerStripeBilling(app, store, webhooks);
  } };
}
