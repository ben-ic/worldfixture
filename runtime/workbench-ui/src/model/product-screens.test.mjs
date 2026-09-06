import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
let Stripe, Linear, Okta, Clerk, Resend, Twilio, Vercel, MongoAtlas;
before(async () => {
  const require = createRequire(import.meta.url);
  const output = await build({ entryPoints: [fileURLToPath(new URL('../screens/ProductScreens.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
    plugins: [{ name: 'existing-react-instance', setup(build) {
      build.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    } }],
  });
  ({ Stripe, Linear, Okta, Clerk, Resend, Twilio, Vercel, MongoAtlas } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));
});
const complete = values => ({ ...values, collectionStatus: Object.fromEntries(Object.keys(values).map(name => [name, { status: 'complete' }])) });
const render = (component, provider, value, errors = []) => renderToStaticMarkup(React.createElement(component, { data: { surfaces: [{ id: provider }], providers: { [provider]: value, errors } } }));

test('Stripe renders distinct currencies, cents, refunds and billing intervals without a combined payment total', () => {
  const stripe = complete({ customers: [], products: [], prices: [], paymentIntents: [], invoices: [],
    charges: [{ id: 'usd', amount: 5995, currency: 'usd', status: 'succeeded' }, { id: 'jpy', amount: 1000, currency: 'jpy', status: 'succeeded' }],
    refunds: [{ id: 'refund', amount: 2600, currency: 'usd', status: 'succeeded' }], subscriptions: [{ id: 'annual', status: 'active', items: { data: [{ quantity: 1, price: { id: 'p', currency: 'eur', unit_amount: 5001, recurring: { interval: 'year', interval_count: 1 } } }] } }] });
  const html = render(Stripe, 'stripe', stripe);
  for (const value of ['USD 59.95', 'USD 26.00', 'USD 33.95', 'JPY 1,000', 'EUR 50.01', '1 year']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /Successful volume|MONTHLY|USD 69\.95/);
});

test('Stripe failure shows unknown rather than an empty measured volume', () => {
  const html = render(Stripe, 'stripe', { charges: [], refunds: [] }, [{ provider: 'stripe', message: 'controlled unavailable read' }]);
  assert.match(html, /controlled unavailable read/); assert.match(html, /Unknown/);
  assert.doesNotMatch(html, /No successful payments|USD 0\.00|Review 0 invoices/);
});

test('Linear uses translated provider states, keeps all-state default and exposes next-page control', () => {
  const linear = complete({ teams: [], states: [{ id: 'complete', name: 'Fertig', type: 'completed' }], issues: Array.from({ length: 121 }, (_, index) => ({ id: `issue-${index}`, title: `Task ${index}`, state: { id: 'complete', name: 'Fertig', type: 'completed' }, labels: [] })) });
  const html = render(Linear, 'linear', linear);
  assert.match(html, /Fertig.*completed/); assert.match(html, /All issues/); assert.match(html, /Issues · 121/);
  assert.match(html, /Next/); assert.match(html, /1–50 of 121/); assert.doesNotMatch(html, /In Progress|Backlog/);
});

test('Linear failed reads retain observed issues but do not report a zero or complete total', () => {
  const html = render(Linear, 'linear', { issues: [{ id: 'one', title: 'Observed task', state: { name: 'Custom' } }], collectionStatus: { issues: { status: 'failed', error: 'Second page failed' } } });
  assert.match(html, /Observed task/); assert.match(html, /total unknown/); assert.match(html, /Second page failed/);
  assert.doesNotMatch(html, /No Linear issues/);
});


test('Other product screens expose pages past 100 and failed lists never appear empty or active', () => {
  for (const [component, provider, key] of [[Okta, 'okta', 'users'], [Clerk, 'clerk', 'users'], [Resend, 'resend', 'emails'], [Twilio, 'twilio', 'phone_numbers'], [Vercel, 'vercel', 'projects'], [MongoAtlas, 'mongoatlas', 'clusters']]) {
    const rows = Array.from({ length: 121 }, (_, index) => ({ id: `row-${index}`, sid: `row-${index}`, name: `Name ${index}`, subject: `Subject ${index}`, phone_number: `+100${index}` }));
    const html = render(component, provider, complete({ [key]: rows }));
    assert.match(html, /1–50 of 121/, provider); assert.match(html, /Next/, provider);
    const failure = render(component, provider, { [key]: [], collectionStatus: { [key]: { status: 'failed', error: 'Page failed' } } });
    assert.match(failure, /Unknown/, provider); assert.match(failure, /Page failed/, provider);
    assert.doesNotMatch(failure, /No records are present|No content yet/, provider);
  }
});
