// Stripe charge units differ from ISO display units for ISK, UGX and MGA.
// Protocol reference: https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const API_TWO_DECIMAL = new Set(['ISK', 'UGX', 'HUF', 'TWD']);
export function currencyCode(value) {
  if (typeof value !== 'string' || !/^[a-z]{3}$/i.test(value)) throw new Error('A three-letter currency is required.');
  return value.toUpperCase();
}
export function minorDigits(currency) {
  const code = currencyCode(currency);
  if (ZERO_DECIMAL.has(code)) return 0;
  if (API_TWO_DECIMAL.has(code)) return 2;
  return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
}
export function minorInteger(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error('The amount is not an exact integer in minor units.');
}
export function formatMinorUnits(value, currency, locale) {
  try {
    const code = currencyCode(currency), digits = minorDigits(code), amount = minorInteger(value);
    const magnitude = amount < 0n ? -amount : amount, scale = 10n ** BigInt(digits);
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(magnitude / scale);
    const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.';
    const fraction = digits ? `${decimal}${String(magnitude % scale).padStart(digits, '0')}` : '';
    return `${code} ${amount < 0n ? '−' : ''}${whole}${fraction}`;
  } catch { return 'Unknown'; }
}
export function parseMinorUnits(value, currency) {
  const digits = minorDigits(currency), input = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(input)) throw new Error('Enter a positive amount without separators.');
  const [whole, fraction = ''] = input.split('.');
  if (fraction.length > digits) throw new Error(`${currencyCode(currency)} accepts ${digits} decimal places.`);
  const amount = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The amount must be positive and within the supported range.');
  if (['ISK', 'UGX'].includes(currencyCode(currency)) && amount % 100n !== 0n) throw new Error(`${currencyCode(currency)} requires a whole-currency amount.`);
  return Number(amount);
}
export function collectionComplete(provider, name) {
  return provider?.collectionStatus?.[name]?.status === 'complete' && Array.isArray(provider[name]);
}
export function collectionCount(provider, name, predicate = () => true) {
  return collectionComplete(provider, name) ? provider[name].filter(predicate).length : null;
}
function groupedAmounts(provider, name, amountOf) {
  if (!collectionComplete(provider, name)) return { known: false, totals: new Map(), error: provider?.collectionStatus?.[name]?.error ?? 'The collection is not complete.' };
  const totals = new Map(), ids = new Set();
  try {
    for (const row of provider[name]) {
      if (!row?.id || ids.has(row.id)) throw new Error('The collection has missing or repeated record IDs.');
      ids.add(row.id);
      const value = amountOf(row); if (value === null) continue;
      const currency = currencyCode(row.currency), amount = minorInteger(value);
      if (amount < 0n) throw new Error('A payment or refund has a negative amount.');
      totals.set(currency, (totals.get(currency) ?? 0n) + amount);
    }
    return { known: true, totals };
  } catch (error) { return { known: false, totals: new Map(), error: error.message }; }
}
export function paymentSummary(stripe) {
  // A PaymentIntent and its charge describe the same payment. Sum charges once;
  // invoice links and subscriptions do not add payment volume.
  const gross = groupedAmounts(stripe, 'charges', charge => {
    if (!['succeeded', 'pending', 'failed'].includes(charge.status)) throw new Error('A charge has an unknown payment status.');
    if (charge.status !== 'succeeded' || charge.paid === false || charge.captured === false) return null;
    return charge.amount_captured ?? charge.amount;
  });
  const refunds = groupedAmounts(stripe, 'refunds', refund => {
    if (!['succeeded', 'pending', 'requires_action', 'failed', 'canceled'].includes(refund.status)) throw new Error('A refund has an unknown status.');
    return refund.status === 'succeeded' ? refund.amount : null;
  });
  const currencies = [...new Set([...gross.totals.keys(), ...refunds.totals.keys()])].sort();
  return { gross, refunds, rows: currencies.map(currency => ({ currency,
    gross: gross.known ? gross.totals.get(currency) ?? 0n : null,
    refunds: refunds.known ? refunds.totals.get(currency) ?? 0n : null,
    net: gross.known && refunds.known ? (gross.totals.get(currency) ?? 0n) - (refunds.totals.get(currency) ?? 0n) : null,
  })) };
}
export function intervalLabel(recurring) {
  if (typeof recurring?.interval !== 'string' || !recurring.interval) return 'Unknown';
  if (!Number.isSafeInteger(recurring.interval_count) || recurring.interval_count < 1) return 'Unknown';
  return `${recurring.interval_count} ${recurring.interval}${recurring.interval_count === 1 ? '' : 's'}`;
}
export function subscriptionAmounts(subscription, stripe) {
  if (!Array.isArray(subscription.items?.data) || subscription.items.has_more === true) throw new Error('Subscription items are incomplete.');
  return subscription.items.data.map(item => {
    let price = item.price;
    if (!price || typeof price !== 'object') {
      if (!collectionComplete(stripe, 'prices')) throw new Error('Subscription prices are incomplete.');
      price = stripe.prices.find(row => row.id === item.price);
    }
    if (!price || price.billing_scheme && price.billing_scheme !== 'per_unit' || price.recurring?.usage_type === 'metered') throw new Error('A recurring amount requires a fixed per-unit price.');
    if (intervalLabel(price.recurring) === 'Unknown') throw new Error('The provider did not supply a complete billing interval.');
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) throw new Error('Subscription quantity is unknown.');
    const amount = minorInteger(price.unit_amount);
    if (amount < 0n) throw new Error('Subscription amount is negative.');
    return { currency: currencyCode(price.currency), interval: price.recurring.interval, interval_count: price.recurring.interval_count,
      amount: amount * BigInt(item.quantity), price_id: price.id };
  });
}
export function recurringSummary(stripe) {
  if (!collectionComplete(stripe, 'subscriptions')) return { known: false, rows: [], error: 'Subscriptions are not complete.' };
  try {
    const groups = new Map(), ids = new Set();
    for (const subscription of stripe.subscriptions) {
      if (!subscription?.id || ids.has(subscription.id)) throw new Error('Subscription IDs are missing or repeated.');
      ids.add(subscription.id);
      if (subscription.status !== 'active') continue;
      for (const row of subscriptionAmounts(subscription, stripe)) {
        const key = JSON.stringify([row.currency, row.interval, row.interval_count]);
        const group = groups.get(key) ?? { ...row, amount: 0n, subscriptions: new Set() };
        group.amount += row.amount; group.subscriptions.add(subscription.id); groups.set(key, group);
      }
    }
    return { known: true, rows: [...groups.values()].map(row => ({ ...row, subscriptions: row.subscriptions.size })).sort((a, b) => `${a.currency}/${a.interval}/${a.interval_count}`.localeCompare(`${b.currency}/${b.interval}/${b.interval_count}`)) };
  } catch (error) { return { known: false, rows: [], error: error.message }; }
}
export function linearStateKey(state) {
  return state?.id ? `id:${state.id}` : state?.name ? `name:${state.name}` : 'unknown';
}
export function linearStates(linear) {
  const states = new Map();
  for (const state of [...(Array.isArray(linear.states) ? linear.states : []), ...(Array.isArray(linear.issues) ? linear.issues : []).map(row => row.state)]) {
    const key = linearStateKey(state);
    if (!states.has(key)) states.set(key, { key, name: state?.name ?? 'Unknown', type: state?.type ?? null, count: collectionComplete(linear, 'issues') ? 0 : null });
  }
  if (collectionComplete(linear, 'issues')) for (const issue of linear.issues) states.get(linearStateKey(issue.state)).count++;
  return [...states.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
export function pageRows(rows, page = 0, pageSize = 50) {
  const count = Math.max(1, Math.ceil(rows.length / pageSize)), current = Math.min(Math.max(0, page), count - 1);
  return { rows: rows.slice(current * pageSize, (current + 1) * pageSize), page: current, pages: count, total: rows.length,
    first: rows.length ? current * pageSize + 1 : 0, last: Math.min((current + 1) * pageSize, rows.length) };
}
