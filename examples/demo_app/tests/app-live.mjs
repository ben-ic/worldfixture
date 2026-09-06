import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localUrl } from '../src/server/security.mjs';

const origin = localUrl(process.env.ACCOUNT_DESK_URL || 'http://127.0.0.1:5175').origin;
if (process.env.ACCOUNT_DESK_ALLOW_TEST_WRITES !== '1') throw new Error('Set ACCOUNT_DESK_ALLOW_TEST_WRITES=1 only for an isolated local test app.');
async function request(path, input) {
  const response = await fetch(origin + path, input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(60000) } : { signal: AbortSignal.timeout(60000) });
  const body = await response.json();
  assert.equal(response.status < 400, true, body.error);
  return body;
}
const state = await request('/api/state');
assert.ok(state.world.id && state.world.id !== 'unbound');
assert.ok(state.storage.available);
const marker = `Account Desk integration ${randomUUID()}`;
const channel = state.data.slack?.selected?.id ?? state.data.slack?.conversations?.[0]?.id;
const repo = state.data.github?.repositories?.[0];
const page = state.data.notion?.pages?.find(item => !item.archived);
const customer = state.data.stripe?.customers?.find(item => item.email?.endsWith('.test'));
assert.ok(channel && repo && page && customer, 'This test needs Slack, GitHub, Notion and a synthetic customer email.');
const steps = [
  { action: 'gmail.send', input: { to: customer.email, subject: marker, text: marker } },
  { action: 'github.issue', input: { owner: repo.owner.login, repo: repo.name, title: marker, body: marker } },
  { action: 'notion.note', input: { pageId: page.id, text: marker } },
  { action: 'slack.send', input: { channel, text: marker } },
];
const draft = await request('/api/drafts', { action: 'gmail.send', input: steps[0].input, steps: steps.slice(1), customerId: customer.id });
assert.ok((await request('/api/drafts')).drafts.some(item => item.id === draft.id));
const input = { steps, idempotencyKey: randomUUID() };
const receipt = await request('/api/workflows', input);
assert.equal(receipt.status, 'passed', JSON.stringify(receipt.steps.map(step => ({ action: step.action, error: step.error }))));
assert.equal(receipt.steps.length, 4);
assert.ok(receipt.steps.every(step => step.result.readback));
const duplicate = await request('/api/workflows', input);
assert.equal(duplicate.id, receipt.id);
assert.deepEqual(duplicate.steps, receipt.steps);
const plan = await request('/api/connector/plan', {});
assert.ok(plan.api_version);
const seeded = await request('/api/connector/seed', { approved: true });
assert.ok(['applied', 'already_applied'].includes(seeded.status));
console.log(JSON.stringify({ app: origin, world: state.world, storage: state.storage.kind, draft: 'saved and re-read', approval: 'four provider writes and readbacks passed', duplicate: 'same receipt; no replay', connector: seeded.status, receipt: receipt.id }));
