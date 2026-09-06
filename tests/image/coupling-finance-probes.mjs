import { compareIdentities } from "./coupling-artifacts.mjs";
import { probeTransactions } from "./coupling-transaction-probes.mjs";

const array = value => Array.isArray(value) ? value : [];
const fragment = value => String(value).replace(/[^a-zA-Z0-9]/g, "_");
const objectId = value => typeof value === "object" && value ? value.id : value;
const currency = value => typeof value === "string" ? value.toLowerCase() : null;
const sorted = values => [...values].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const seconds = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Math.floor(Date.parse(value) / 1000) : null;

export async function stripePages(read) {
  const records = [], cursors = new Set(), ids = new Set();
  let cursor;
  for (;;) {
    const result = await read(cursor);
    if (!Array.isArray(result.data) || typeof result.has_more !== "boolean") throw new Error("Stripe list omitted data or has_more");
    for (const record of result.data) {
      if (typeof record.id !== "string" || !record.id) throw new Error("Stripe list record omitted its identity");
      if (ids.has(record.id)) throw new Error(`Stripe pagination repeated record ${record.id}`);
      ids.add(record.id); records.push(record);
    }
    if (!result.has_more) return records;
    const next = result.data.at(-1)?.id;
    if (!next) throw new Error("Stripe list has_more has no last identity");
    if (cursors.has(next)) throw new Error("Stripe pagination repeated its cursor");
    cursors.add(next); cursor = next;
    if (cursors.size > 10000) throw new Error("Stripe pagination exceeded the safety bound");
  }
}

export async function probeFinanceWorld({ artifact, bindings, fetchImpl = fetch, domainCoverage = [] }) {
  const checks = [], responses = [], coverage = [];
  const world = artifact.world, projection = artifact.projections?.stripe ?? {};
  const finance = world.finance ?? {}, billing = Object.hasOwn(finance, "resolved"), customers = billing ? array(finance.customers) : [], catalog = array(world.commerce?.products);
  const people = new Map(array(world.people).map(person => [person.id, person]));
  const recurring = customers.filter(customer => (customer.billing_mode ?? "recurring_monthly") === "recurring_monthly");
  const plans = sorted(new Set(recurring.map(customer => customer.service)));
  const knownCollections = ["customers", "products", "prices", "subscriptions", "invoices"].filter(key => billing || ["products", "prices"].includes(key) || Object.hasOwn(projection, key));
  const add = (name, passed, detail = {}) => checks.push({ check: `finance.stripe.${name}`, status: passed ? "passed" : "failed", ...detail });
  const compare = (name, expected, actual, finding = 13) => add(name, equal(expected, actual), { expected, actual, finding });
  const identities = (name, expected, actual, finding = 13) => checks.push(compareIdentities({ check: `finance.stripe.${name}`, expected, actual, finding }));
  const redact = value => {
    if (typeof value === "string") return bindings.STRIPE_TOKEN ? value.replaceAll(bindings.STRIPE_TOKEN, "[redacted]") : value;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /secret|token|password|authorization/i.test(key) ? "[redacted]" : redact(item)]));
    return value;
  };
  const run = async (name, action) => {
    try { const result = await action(); add(name, true); return result; }
    catch (error) { add(name, false, { failure_kind: "assertion", detail: redact(error.message ?? String(error)) }); return null; }
  };
  const invoicesById = new Map(), invoiceConflicts = new Set();
  for (const invoice of billing ? [...array(finance.resolved?.invoices), ...array(finance.anchor_invoices)] : []) {
    const earlier = invoicesById.get(invoice.id);
    if (earlier) {
      const fields = record => [record.customer_id, record.amount_cents, record.currency, record.status, record.number, record.description, record.issued_on, record.due_on];
      compare(`source.invoice.${invoice.id}.duplicate-agreement`, fields(earlier), fields(invoice));
      if (!equal(fields(earlier), fields(invoice))) invoiceConflicts.add(invoice.id);
    }
    invoicesById.set(invoice.id, invoice);
  }
  const invoices = [...invoicesById.values()];
  if (billing && Number.isInteger(finance.history_months) && finance.history_months >= 0 && world.clock?.anchor) {
    const origin = new Date(world.clock.rebase?.finance_history?.origin_anchor ?? world.clock.anchor);
    const anchorIds = new Set(array(finance.anchor_invoices).map(row => row.id));
    const expectedIds = [...anchorIds];
    for (let offset = finance.history_months; offset > 0; offset -= 1) {
      const month = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() - offset, 1));
      const yearMonth = `${month.getUTCFullYear()}${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
      for (const customer of recurring) {
        const invoiceId = `inv-${yearMonth}-${customer.id}`;
        if (!anchorIds.has(invoiceId)) expectedIds.push(invoiceId);
      }
    }
    identities("source.history-completeness", expectedIds.map(id => ({ id })), array(finance.resolved?.invoices), 5);
  }
  const expected = {
    customers: customers.map(record => ({ id: `cus_${fragment(record.id)}`, source: record })),
    products: [...plans.map(plan => ({ id: `prod_${fragment(plan).toLowerCase()}`, name: plan, description: `Monthly ${plan} subscription` })),
      ...catalog.map(record => ({ id: `prod_${fragment(record.id)}`, name: record.name, description: record.summary ?? record.name, source: record }))],
    prices: [...recurring.map(record => ({ id: `price_${fragment(record.id)}`, product: `prod_${fragment(record.service).toLowerCase()}`,
      product_name: record.service, currency: currency(record.currency ?? finance.currency), amount: record.monthly_amount_cents, interval: "month", source: record })),
      ...catalog.map(record => ({ id: `price_${fragment(record.id)}`, product: `prod_${fragment(record.id)}`, product_name: record.name,
        currency: currency(record.currency ?? finance.currency), amount: record.price_cents, interval: null, source: record }))],
    subscriptions: recurring.map(record => ({ id: `sub_${fragment(record.id)}`, customer: `cus_${fragment(record.id)}`, price: `price_${fragment(record.id)}`,
      product: `prod_${fragment(record.service).toLowerCase()}`, currency: currency(record.currency ?? finance.currency), amount: record.monthly_amount_cents, source: record })),
    invoices: invoices.map(record => ({ id: `in_${fragment(record.id)}`, source: record })),
  };
  const catalogProductIds = new Set(catalog.map(record => `prod_${fragment(record.id)}`));
  const catalogPriceIds = new Set(catalog.map(record => `price_${fragment(record.id)}`));
  const catalogFields = new Set(["id", "name", "summary", "price_cents", "currency"]);
  const domainCatalog = domainCoverage.some(row => row.collection === "commerce.products" && row.provider === "domain" && row.status === "passed" && typeof row.path === "string" && row.path);
  for (const product of catalog) {
    const unsupported = Object.keys(product).filter(key => !catalogFields.has(key));
    if (unsupported.length) add(`catalog.${product.id}.unserved-fields`, domainCatalog, { finding: 24, ...(domainCatalog ? {delegated_provider: "domain", scope: "verified full domain record"} : {failure_kind: "product_gap"}),
      expected: Object.fromEntries(unsupported.map(key => [key, product[key]])), actual: domainCatalog ? {provider: "domain", collection: "commerce.products", status: "passed"} : null,
      detail: domainCatalog ? "These fields were checked by the current run domain API reader. Stripe serves identity, name, summary, currency, and price only." : "Stripe's current compiler/API mapping covers catalog identity, name, summary, currency, and price only. No verified live consumer exists for these remaining authored product fields; no metadata mapping is assumed." });
  }
  for (const key of knownCollections) {
    add(`source.${key}.identity-mapping`, new Set(expected[key].map(record => record.id)).size === expected[key].length,
      { expected: expected[key].length, actual: new Set(expected[key].map(record => record.id)).size, detail: "Source-to-Stripe identity mapping must be unambiguous." });
    identities(`projection.${key}.completeness`, expected[key], array(projection[key]));
  }
  for (const [key, value] of Object.entries(projection)) if (Array.isArray(value) && !knownCollections.includes(key)) {
    add(`reader.${key}`, false, { failure_kind: "reader_gap", detail: `No extended finance reader is defined for ${value.length} declared ${key} records.` });
  }
  // Check projection fields against source before reading the API. Byte-valid
  // projections can still lose an invoice or apply the wrong currency.
  const invoiceFields = record => ({ customer: `cus_${fragment(record.customer_id)}`, amount_due: record.amount_cents,
    currency: currency(record.currency ?? finance.currency), status: record.status === "overdue" ? "open" : record.status,
    number: record.number, description: record.description ?? null, created: seconds(record.issued_on), due_date: seconds(record.due_on) });
  for (const record of expected.invoices) {
    const projected = array(projection.invoices).find(item => item.id === record.id);
    const wanted = invoiceFields(record.source);
    compare(`projection.invoice.${record.source.id}.fields`, wanted, projected ? Object.fromEntries(Object.keys(wanted).map(key => [key, projected[key]])) : null);
  }
  for (const record of expected.prices) {
    add(`source.price.${record.id}.amount-currency`, Number.isSafeInteger(record.amount) && record.amount >= 0 && /^[a-z]{3}$/.test(record.currency ?? ""),
      { expected: "An authored currency and nonnegative integer amount", actual: { currency: record.currency, amount: record.amount } });
    const projected = array(projection.prices).find(item => item.id === record.id);
    // seedStripeBilling uses presence of recurring to select recurring prices;
    // formatPrice supplies a monthly interval. An empty object is a legitimate
    // monthly seed default, while an absent recurring field means one-time.
    const projectedInterval = projected?.recurring ? projected.recurring.interval ?? "month" : null;
    compare(`projection.price.${record.id}.fields`, [record.product_name, record.currency, record.amount, record.interval], projected
      ? [projected.product_name, currency(projected.currency), projected.unit_amount, projectedInterval] : null);
  }
  for (const record of expected.subscriptions) {
    const projected = array(projection.subscriptions).find(item => item.id === record.id);
    compare(`projection.subscription.${record.id}.fields`, [record.customer, record.price, "active"], projected ? [projected.customer, projected.price, projected.status ?? "active"] : null);
  }
  if (!bindings.STRIPE_BASE_URL || !bindings.STRIPE_TOKEN) {
    add("provider.read", false, { failure_kind: "assertion", detail: "Missing STRIPE_BASE_URL or this run's STRIPE_TOKEN" });
    return { checks, responses, coverage };
  }
  async function request(path) {
    const response = await fetchImpl(`${bindings.STRIPE_BASE_URL.replace(/\/$/, "")}${path}`, { method: "GET",
      headers: { authorization: `Bearer ${bindings.STRIPE_TOKEN}` }, signal: AbortSignal.timeout(30000) });
    const raw = await response.text();
    let body; try { body = JSON.parse(raw); } catch { body = raw; }
    responses.push({ provider: "stripe", path, status: response.status, body: redact(body) });
    if (!response.ok || body?.error) throw new Error(`${path} returned HTTP ${response.status}${body?.error?.code ? ` (${body.error.code})` : ""}`);
    if (!body || typeof body !== "object") throw new Error(`${path} returned invalid JSON`);
    return body;
  }
  const list = path => stripePages(cursor => request(`${path}${path.includes("?") ? "&" : "?"}limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`));
  const served = {};
  for (const key of knownCollections) {
    served[key] = await run(`api.${key}.read`, () => list(`/v1/${key}${key === "subscriptions" ? "?status=all" : ""}`));
    if (served[key]) identities(`api.${key}.identities`, expected[key], served[key]);
  }
  // Keep catalog projection/API evidence separate from subscription-plan data.
  // Overall list identity checks above still report foreign or missing records.
  for (const [key, ids] of [["products", catalogProductIds], ["prices", catalogPriceIds]]) {
    const source = expected[key].filter(record => ids.has(record.id));
    identities(`catalog.projection.${key}.identities`, source, array(projection[key]).filter(record => ids.has(record.id)));
    if (served[key]) identities(`catalog.api.${key}.identities`, source, served[key].filter(record => ids.has(record.id)));
  }
  for (const record of expected.customers) {
    const actual = served.customers?.find(item => item.id === record.id);
    compare(`customer.${record.source.id}.fields`, [record.source.name, people.get(record.source.contact_id)?.email], actual ? [actual.name, actual.email] : null);
  }
  for (const record of expected.products) {
    const actual = served.products?.find(item => item.id === record.id);
    compare(`product.${record.id}.fields`, [record.name, record.description], actual ? [actual.name, actual.description] : null);
  }
  for (const record of expected.prices) {
    const actual = served.prices?.find(item => item.id === record.id);
    compare(`price.${record.id}.fields`, { product: record.product, currency: record.currency, amount: record.amount,
      type: record.interval ? "recurring" : "one_time", interval: record.interval }, actual ? { product: objectId(actual.product), currency: currency(actual.currency), amount: actual.unit_amount,
      type: actual.type, interval: actual.recurring?.interval ?? null } : null);
    add(`price.${record.id}.product-link`, !!actual && !!served.products?.some(product => product.id === objectId(actual.product)), { expected: record.product, actual: actual ? objectId(actual.product) : null });
    if (record.interval) compare(`price.${record.id}.interval-count`, 1, actual?.recurring?.interval_count);
  }
  for (const record of expected.subscriptions) await run(`subscription.${record.id}.read`, async () => {
    const actual = served.subscriptions?.find(item => item.id === record.id);
    if (!actual) throw new Error(`Missing source subscription ${record.id}`);
    compare(`subscription.${record.id}.fields`, [record.customer, record.currency, "active"], [objectId(actual.customer), currency(actual.currency), actual.status]);
    let items;
    if (typeof actual.items?.has_more !== "boolean" || !Array.isArray(actual.items?.data)) throw new Error(`Subscription ${record.id} omitted complete items metadata`);
    if (actual.items.has_more) items = await list(`/v1/subscription_items?subscription=${encodeURIComponent(record.id)}`);
    else items = actual.items.data;
    compare(`subscription.${record.id}.prices`, [record.price], items.map(item => objectId(item.price)));
    compare(`subscription.${record.id}.quantities`, [1], items.map(item => item.quantity));
    const price = items[0]?.price;
    if (typeof price === "object") compare(`subscription.${record.id}.price-fields`, [record.product, record.currency, record.amount], [objectId(price.product), currency(price.currency), price.unit_amount]);
    else add(`subscription.${record.id}.price-link`, !!served.prices?.some(price => price.id === record.price), { expected: record.price, actual: price });
    add(`subscription.${record.id}.customer-link`, !!served.customers?.some(customer => customer.id === objectId(actual.customer)), { expected: record.customer, actual: objectId(actual.customer) });
  });
  const invoiceResults = new Map();
  for (const record of expected.invoices) {
    const before = checks.length;
    await run(`invoice.${record.source.id}.read`, async () => {
      const actual = served.invoices?.find(item => item.id === record.id);
      if (!actual) throw new Error(`Missing source invoice ${record.source.id}`);
      const wanted = invoiceFields(record.source);
      const fields = Object.fromEntries(Object.keys(wanted).map(key => [key, key === "customer" ? objectId(actual[key]) : actual[key]]));
      compare(`invoice.${record.source.id}.fields`, wanted, fields);
      compare(`invoice.${record.source.id}.source-id`, record.source.id, actual.metadata?.worldfixture_invoice_id);
      compare(`invoice.${record.source.id}.source-status`, record.source.status, actual.metadata?.worldfixture_status);
      const payments = array(finance.resolved?.payments).filter(payment => payment.invoice_id === record.source.id);
      compare(`invoice.${record.source.id}.payment-currencies`, [], payments.filter(payment => currency(payment.currency ?? finance.currency) !== wanted.currency)
        .map(payment => ({ id: payment.id, currency: payment.currency ?? finance.currency })));
      add(`invoice.${record.source.id}.payment-amounts`, payments.every(payment => Number.isSafeInteger(payment.amount_cents) && payment.amount_cents >= 0),
        { expected: "Nonnegative integer payment amounts", actual: payments.map(payment => ({ id: payment.id, amount: payment.amount_cents })) });
      const paid = payments.reduce((sum, payment) => sum + payment.amount_cents, 0);
      if (record.source.status === "paid") compare(`invoice.${record.source.id}.source-settled`, record.source.amount_cents, paid, 5);
      compare(`invoice.${record.source.id}.paid-at`, record.source.status === "paid" && payments.length
        ? Math.max(...payments.map(payment => seconds(payment.paid_on))) : null, actual.status_transitions?.paid_at ?? null, 5);
      compare(`invoice.${record.source.id}.totals`, [record.source.amount_cents, paid, Math.max(0, record.source.amount_cents - paid)], [actual.total, actual.amount_paid, actual.amount_remaining]);
      add(`invoice.${record.source.id}.customer-link`, !!served.customers?.some(customer => customer.id === objectId(actual.customer)), { expected: wanted.customer, actual: objectId(actual.customer) });
      const lines = await list(`/v1/invoices/${encodeURIComponent(record.id)}/lines`);
      compare(`invoice.${record.source.id}.line-total`, record.source.amount_cents, lines.reduce((sum, line) => sum + line.amount, 0));
      compare(`invoice.${record.source.id}.line-currencies`, [], lines.filter(line => currency(line.currency) !== wanted.currency).map(line => ({ id: line.id, currency: line.currency })));
      compare(`invoice.${record.source.id}.line-parents`, [], lines.filter(line => objectId(line.invoice) !== record.id).map(line => ({ id: line.id, invoice: line.invoice })));
      // Lines generated from one canonical invoice do not have authored line IDs.
      // Record API IDs in evidence, but use the authored amount for reconciliation.
      if (lines.length === 1) compare(`invoice.${record.source.id}.line-description`, record.source.description ?? null, lines[0].description);
      if (actual.lines?.has_more === false && typeof actual.lines.total_count === "number") compare(`invoice.${record.source.id}.line-count`, actual.lines.total_count, lines.length);
      if (record.source.amount_cents !== 0) add(`invoice.${record.source.id}.line-presence`, lines.length > 0, { expected: "At least one line for a nonzero invoice", actual: lines.length });
    });
    invoiceResults.set(record.source.id, !invoiceConflicts.has(record.source.id) && checks.slice(before).every(check => check.status === "passed"));
  }
  if (billing || Object.hasOwn(projection, "invoices")) for (const [collection, rows] of [["finance.resolved.invoices", array(finance.resolved?.invoices)], ["finance.anchor_invoices", array(finance.anchor_invoices)]]) {
    const pass = !!served.invoices && rows.every(record => invoiceResults.get(record.id) === true)
      && checks.find(check => check.check === "finance.stripe.source.history-completeness")?.status !== "failed"
      && checks.find(check => check.check === "finance.stripe.api.invoices.identities")?.status === "passed";
    coverage.push({ collection, provider: "stripe", path: "GET /v1/invoices; GET /v1/invoices/:id/lines", status: pass ? "passed" : "failed",
      detail: "Complete source invoice identities, amounts, currencies, status, dates, customer links, and line totals; source union includes history and anchor records once." });
  }
  const customerChecks = checks.filter(check => ["finance.stripe.customer.", "finance.stripe.api.customers.", "finance.stripe.projection.customers.", "finance.stripe.source.customers."].some(prefix => check.check.startsWith(prefix)));
  if (billing || Object.hasOwn(projection, "customers")) coverage.push({ collection: "finance.customers", provider: "stripe", path: "GET /v1/customers", status: !!served.customers && customerChecks.every(check => check.status === "passed") ? "passed" : "failed",
    detail: "Complete source customer identities, names and contact email relationships. Recurring terms are checked separately through prices and subscriptions." });
  const catalogChecks = checks.filter(check => check.check.startsWith("finance.stripe.catalog.")
    || [...catalogProductIds].some(id => check.check.startsWith(`finance.stripe.product.${id}.`))
    || [...catalogPriceIds].some(id => [`finance.stripe.price.${id}.`, `finance.stripe.source.price.${id}.`, `finance.stripe.projection.price.${id}.`].some(prefix => check.check.startsWith(prefix))));
  coverage.push({ collection: "commerce.products", provider: "stripe", path: "GET /v1/products; GET /v1/prices", status: !!served.products && !!served.prices
    && catalogChecks.every(check => check.status === "passed") ? "passed" : "failed",
    checked_fields: [...catalogFields],
    detail: "Catalog identity, name, summary and one-time price/currency only. Other authored fields require passed current-run domain evidence or remain an explicit product_gap. Unrelated recurring checks cannot determine catalog coverage. Does not prove commerce order operations." });
  if (billing || Object.hasOwn(projection, "transactions")) {
    const transactions = await probeTransactions({ world, projection, list });
    checks.push(...transactions.checks);
    coverage.push(...transactions.coverage);
  }
  const failed = checks.filter(check => check.status === "failed");
  const onlyCommerceGaps = failed.length > 0 && failed.every(check => check.failure_kind === "product_gap" && check.finding === 24);
  add("provider.read", failed.length === 0, {
    ...(onlyCommerceGaps ? { failure_kind: "product_gap", finding: 24 } : {}),
    detail: "Read-only source-backed billing checks; amounts are reconciled per currency and recurring prices remain separate from payment volume.",
  });
  return redact({ checks, responses, coverage });
}
