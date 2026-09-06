import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkflowRunner } from '../src/workflows/runner.mjs';
import { createVerificationRunner } from '../src/verification/runner.mjs';
import { makeRedactor, localUrl, checkRequest } from '../src/server/security.mjs';

function memory() {
  const records = new Map();
  return { async get(c, id) { return structuredClone(records.get(`${c}/${id}`)); }, async put(c, id, value) { records.set(`${c}/${id}`, structuredClone(value)); } };
}
const actions = [{ id: 'mail.send', service: 'mail', label: 'Send', fields: [{ name: 'text', required: true }] }];
const steps = [{ action: 'mail.send', input: { text: 'Test only' } }];
const catalog = () => [{ id: 'mail', name: 'Local Mail', selected: true }];

test('approval is durable and duplicate concurrent requests send only once', async () => {
  let writes = 0;
  const runner = createWorkflowRunner({ actions, store: memory(), providers: { catalog, async execute() { writes++; return { record: { id: '1' }, readback: { id: '1' } }; } } });
  const input = { steps, idempotencyKey: 'test-approval-01' };
  const [first, second] = await Promise.all([runner.run(input), runner.run(input)]);
  assert.equal(first.status, 'passed');
  assert.equal(second.status, 'passed');
  assert.equal(writes, 1);
  assert.equal((await runner.run(input)).status, 'passed');
  assert.equal(writes, 1);
  await assert.rejects(runner.run({ ...input, steps: [{ action: 'mail.send', input: { text: 'Changed' } }] }), /different draft/);
});

test('partial write failure stops later steps and never repeats an uncertain send', async () => {
  let writes = 0;
  const runner = createWorkflowRunner({ actions, store: memory(), providers: { catalog, async execute() { if (++writes === 2) throw new Error('Timeout after send'); return { readback: { id: 'saved' } }; } } });
  const input = { steps: [...steps, ...steps, ...steps], idempotencyKey: 'test-approval-02' };
  const result = await runner.run(input);
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.steps.map(item => item.status), ['passed', 'uncertain']);
  await runner.run(input);
  assert.equal(writes, 2);
});

test('restart does not replay an interrupted receipt', async () => {
  const store = memory();
  const providers = { catalog, async execute() { throw new Error('Must not send'); } };
  const original = createWorkflowRunner({ actions, store, providers: { catalog, async execute() { return { readback: {} }; } } });
  const input = { steps, idempotencyKey: 'test-approval-03' };
  const saved = await original.run(input);
  saved.status = 'running';
  await store.put('receipts', saved.id, saved);
  const restarted = createWorkflowRunner({ actions, store, providers });
  assert.equal((await restarted.run(input)).status, 'uncertain');
});

test('all inputs and service selection are checked before a write starts', async () => {
  let writes = 0;
  const runner = createWorkflowRunner({ actions, store: memory(), providers: { catalog, async execute() { writes++; } } });
  await assert.rejects(runner.run({ steps: [...steps, { action: 'mail.send', input: {} }], idempotencyKey: 'test-approval-04' }), /text is required/);
  assert.equal(writes, 0);
});

test('verification distinguishes an absent selection from a failed selected service', async () => {
  const runner = createVerificationRunner({ store: memory(), world: { id: 'test' }, providers: { catalog: () => [{ id: 'ready', selected: true }, { id: 'down', selected: true }, { id: 'absent', selected: false }], async read(id) { if (id === 'down') throw new Error('Connection refused'); return { items: [] }; } } });
  const begun = await runner.start(['ready', 'down', 'absent']);
  const run = await runner.wait(begun.id);
  assert.equal(run.status, 'failed');
  assert.deepEqual(run.results.map(item => item.status), ['passed', 'failed', 'skipped']);
  assert.deepEqual(run.summary, { passed: 1, failed: 1, skipped: 1 });
});

test('local-only addresses and browser origins reject production and cross-site requests', () => {
  assert.throws(() => localUrl('https://api.stripe.com'), /Only local/);
  assert.throws(() => localUrl('http://user:secret@127.0.0.1:1234'), /Only local/);
  assert.equal(localUrl('http://127.0.0.1:1234').port, '1234');
  assert.throws(() => checkRequest({ headers: { host: '127.0.0.1:1234', origin: 'https://evil.test' } }, 'http://127.0.0.1:1234'), /Cross-origin/);
  assert.throws(() => checkRequest({ headers: { host: 'evil.test:1234' } }, 'http://127.0.0.1:1234'), /Invalid/);
});

test('redaction removes nested credentials, bearer headers, and known secret values', () => {
  const redact = makeRedactor({ SLACK_TOKEN: 'local-secret-value' });
  assert.deepEqual(redact({ tokenResult: { access_token: 'abc' }, text: 'local-secret-value', header: 'Bearer abc.def' }), { tokenResult: { access_token: '[redacted]' }, text: '[redacted]', header: 'Bearer [redacted]' });
  assert.deepEqual(redact({ modseq: 12n, date: new Date('2026-01-01Z') }), { modseq: '12', date: '2026-01-01T00:00:00.000Z' });
});
