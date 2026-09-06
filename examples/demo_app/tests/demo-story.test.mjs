import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDemoStories, emailAddresses } from '../src/workflows/demo-story.mjs';

test('demo selects a real incoming message and invoice through exact relationships', () => {
  const stories = buildDemoStories({ stripe: { customers: [{ id: 'other-world-person', name: 'Aster', email: 'aster@company.test' }], invoices: [{ id: 'invoice-random', customer: 'other-world-person', number: 'A42', status: 'open', currency: 'usd', amount_remaining: 7000 }] }, gmail: { messages: [{ id: 'incoming', from: 'Aster <aster@company.test>', subject: 'Need an update', body: 'Please check this', internalDate: '100' }, { id: 'outgoing', from: 'agent@company.test', to: 'aster@company.test', subject: 'Sent update', internalDate: '200' }, { id: 'similar', from: 'notaster@company.test', subject: 'Unrelated', internalDate: '300' }] } });
  assert.equal(stories[0].message.id, 'incoming');
  assert.equal(stories[0].invoice.id, 'invoice-random');
  assert.equal(stories[0].reply.to, 'aster@company.test');
  assert.match(stories[0].evidence[1].detail, /\$70\.00/);
  assert.doesNotMatch(stories[0].reply.text, /resolved|released|fixed|paid/i);
});
test('no matching records produces an honest empty demo', () => {
  assert.deepEqual(buildDemoStories({}), []);
  assert.deepEqual(buildDemoStories({ stripe: { customers: [{ id: 'one', email: 'a@test.example' }], invoices: [{ customer: 'unrelated', status: 'open' }] } }), []);
});
test('latest incoming message wins without a fixed company or person', () => {
  const stories = buildDemoStories({ stripe: { customers: [{ id: '1', email: 'b@other.test' }] }, gmail: { messages: [{ id: 'old', from: 'b@other.test', internalDate: '1' }, { id: 'new', from: 'b@other.test', internalDate: '2' }] } });
  assert.equal(stories[0].message.id, 'new');
  assert.deepEqual(emailAddresses('Person <B@OTHER.TEST>, second@elsewhere.test'), ['b@other.test', 'second@elsewhere.test']);
});
