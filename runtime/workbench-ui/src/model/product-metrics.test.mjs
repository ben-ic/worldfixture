import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionCount, formatMinorUnits, intervalLabel, linearStates, pageRows, parseMinorUnits, paymentSummary, recurringSummary } from './product-metrics.mjs';

const complete = values => ({ ...values, collectionStatus: Object.fromEntries(Object.keys(values).map(name => [name, { status: 'complete' }])) });
const charge = (id, amount, currency = 'usd', extra = {}) => ({ id, amount, currency, status: 'succeeded', paid: true, ...extra });
const refund = (id, amount, currency = 'usd', extra = {}) => ({ id, amount, currency, status: 'succeeded', ...extra });
const subscription = (id, currency, interval, interval_count, amount, quantity = 1) => ({ id, status: 'active', items: { data: [{ quantity, price: { id: `price-${id}`, currency, unit_amount: amount, recurring: { interval, interval_count, usage_type: 'licensed' } } }] } });

test('payments are counted once by charge, with successful refunds and separate currencies', () => {
  const stripe = complete({ charges: [charge('a', 5995), charge('b', 200, 'eur'), charge('c', 1000, 'jpy'), charge('failed', 9000, 'usd', { status: 'failed' }), charge('authorization', 8000, 'usd', { captured: false })],
    refunds: [refund('r', 2600), refund('pending', 500, 'usd', { status: 'pending' })],
    paymentIntents: [{ id: 'pi-a', amount: 5995, status: 'succeeded' }], invoices: [{ amount_paid: 5995 }], subscriptions: [subscription('s', 'usd', 'month', 1, 12000)] });
  assert.deepEqual(paymentSummary(stripe).rows, [{ currency: 'EUR', gross: 200n, refunds: 0n, net: 200n }, { currency: 'JPY', gross: 1000n, refunds: 0n, net: 1000n }, { currency: 'USD', gross: 5995n, refunds: 2600n, net: 3395n }]);
});

test('partial capture uses captured amount and exact sums exceed Number precision safely', () => {
  const result = paymentSummary(complete({ charges: [charge('a', 9007199254740991), charge('b', 9007199254740991), charge('partial', 1000, 'usd', { amount_captured: 250 })], refunds: [] }));
  assert.equal(result.rows[0].gross, 18014398509482232n);
  assert.equal(formatMinorUnits(result.rows[0].gross, 'usd', 'en-US'), 'USD 180,143,985,094,822.32');
});

test('failed or partial reads are unknown and cannot become zero or net volume', () => {
  for (const status of ['partial', 'failed', 'unavailable']) {
    const stripe = complete({ charges: [charge('a', 100)], refunds: [] });
    stripe.collectionStatus.refunds = { status, error: 'controlled read failure' };
    const result = paymentSummary(stripe);
    assert.equal(result.rows[0].gross, 100n); assert.equal(result.rows[0].refunds, null); assert.equal(result.rows[0].net, null);
  }
  assert.equal(collectionCount({ customers: [] }, 'customers'), null);
  assert.equal(collectionCount(complete({ customers: [] }), 'customers'), 0);
  assert.equal(paymentSummary({ charges: [], refunds: [] }).gross.known, false);
});

test('missing amounts, currencies and repeated records are unknown rather than a plausible sum', () => {
  for (const rows of [[charge('a', undefined)], [charge('a', 10, null)], [charge('a', 10), charge('a', 10)], [charge('a', 0.1)], [charge('a', Number.MAX_SAFE_INTEGER + 1)]]) {
    assert.equal(paymentSummary(complete({ charges: rows, refunds: [] })).gross.known, false);
  }
});

test('unknown payment or refund statuses cannot be reported as a measured zero', () => {
  assert.equal(paymentSummary(complete({ charges: [charge('a', 100, 'usd', { status: undefined })], refunds: [] })).gross.known, false);
  assert.equal(paymentSummary(complete({ charges: [], refunds: [refund('r', 100, 'usd', { status: 'future-status' })] })).refunds.known, false);
});

test('minor-unit formatting retains cents, zero-decimal charges and Stripe special cases', () => {
  assert.equal(formatMinorUnits(1, 'usd', 'en-US'), 'USD 0.01');
  assert.equal(formatMinorUnits(5995, 'usd', 'en-US'), 'USD 59.95');
  assert.equal(formatMinorUnits(1000, 'jpy', 'en-US'), 'JPY 1,000');
  assert.equal(formatMinorUnits(5, 'mga', 'en-US'), 'MGA 5');
  assert.equal(formatMinorUnits(500, 'isk', 'en-US'), 'ISK 5.00');
  assert.equal(formatMinorUnits(1045, 'huf', 'en-US'), 'HUF 10.45');
  assert.equal(formatMinorUnits(-1n, 'eur', 'de-DE'), 'EUR −0,01');
  assert.equal(formatMinorUnits(null, 'usd'), 'Unknown');
  assert.equal(formatMinorUnits(1), 'Unknown');
});

test('form values convert without floating-point rounding or implicit USD', () => {
  assert.equal(parseMinorUnits('59.95', 'usd'), 5995); assert.equal(parseMinorUnits('0.29', 'eur'), 29);
  assert.equal(parseMinorUnits('123', 'jpy'), 123);
  assert.throws(() => parseMinorUnits('1.5', 'jpy'), /0 decimal/);
  assert.throws(() => parseMinorUnits('1.23', 'isk'), /whole-currency/);
  assert.throws(() => parseMinorUnits('1.001', 'usd'), /2 decimal/);
  assert.throws(() => parseMinorUnits('1', ''), /currency/);
});

test('recurring prices group by currency and exact billing interval, retaining quantity', () => {
  const result = recurringSummary(complete({ subscriptions: [subscription('a', 'usd', 'month', 1, 1200, 2), subscription('b', 'usd', 'year', 1, 9999), subscription('c', 'eur', 'month', 3, 888), { ...subscription('inactive', 'usd', 'month', 1, 999), status: 'canceled' }] }));
  assert.equal(result.known, true);
  assert.deepEqual(result.rows.map(({ currency, interval, interval_count, amount }) => ({ currency, interval, interval_count, amount })), [
    { currency: 'EUR', interval: 'month', interval_count: 3, amount: 888n }, { currency: 'USD', interval: 'month', interval_count: 1, amount: 2400n }, { currency: 'USD', interval: 'year', interval_count: 1, amount: 9999n }]);
  assert.equal(intervalLabel(result.rows[0]), '3 months');
});

test('incomplete, missing-quantity, metered and unresolved recurring data is unknown', () => {
  for (const mutate of [s => { s.items.has_more = true; }, s => { delete s.items.data[0].quantity; }, s => { s.items.data[0].price.recurring.usage_type = 'metered'; }, s => { delete s.items.data[0].price.recurring.interval_count; }, s => { s.items.data[0].price = 'missing-price'; }]) {
    const row = subscription('a', 'usd', 'month', 1, 1200); mutate(row);
    assert.equal(recurringSummary(complete({ subscriptions: [row] })).known, false);
  }
  assert.equal(recurringSummary({ subscriptions: [] }).known, false);
});

test('Linear states use provider IDs, names and types, including translated and unknown states', () => {
  const linear = complete({ issues: [{ id: '1', state: { id: 'done-a', name: 'Fertig', type: 'completed' } }, { id: '2', state: { id: 'done-b', name: 'Fertig', type: 'custom-future' } }, { id: '3', state: { id: 'started', name: 'En cours', type: 'started' } }],
    states: [{ id: 'empty', name: 'Wartend', type: 'backlog' }] });
  const states = linearStates(linear);
  assert.equal(states.length, 4); assert.equal(states.find(row => row.key === 'id:empty').count, 0);
  assert.equal(states.filter(row => row.name === 'Fertig').length, 2);
  linear.collectionStatus.issues.status = 'failed'; assert.ok(linearStates(linear).every(row => row.count === null));
});

test('progressive pages expose every issue past the old 100-record cap', () => {
  const rows = Array.from({ length: 503 }, (_, id) => ({ id }));
  const all = Array.from({ length: 11 }, (_, page) => pageRows(rows, page).rows).flat();
  assert.deepEqual(all, rows); assert.equal(pageRows(rows, 99).page, 10);
  assert.deepEqual(pageRows([], 2).rows, []); assert.equal(pageRows(rows.slice(0, 3), 9).page, 0);
});
