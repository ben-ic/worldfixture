import { createHash, randomUUID } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function createWorkflowRunner({ providers, store, actions, world = null, redact = value => value, onUpdate = () => {} }) {
  const active = new Map();
  async function save(receipt) { await store.put('receipts', receipt.id, receipt); onUpdate(redact(receipt)); }
  function validate(steps) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 8) throw new Error('Select between one and eight actions.');
    for (const step of steps) {
      const schema = actions.find(item => item.id === step.action);
      if (!schema) throw new Error(`Action is not supported: ${step.action}`);
      if (!providers.catalog().find(item => item.id === schema.service)?.selected) throw new Error(`${schema.service} is not selected in this world.`);
      if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) throw new Error('Each action needs an input object.');
      for (const field of schema.fields ?? []) {
        const name = typeof field === 'string' ? field : field.name;
        if (field.required !== false && !String(step.input[name] ?? '').trim()) throw new Error(`${schema.label}: ${name} is required.`);
        if (step.input[name] !== undefined && typeof step.input[name] !== 'string') throw new Error(`${name} must be text.`);
      }
    }
  }
  async function run({ steps, idempotencyKey }) {
    validate(steps);
    if (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,160}$/.test(idempotencyKey)) throw new Error('A stable idempotencyKey of 8–160 characters is required.');
    const fingerprint = createHash('sha256').update(JSON.stringify(stable(steps))).digest('hex');
    const existing = await store.get('receipts', idempotencyKey);
    if (existing && existing.fingerprint !== fingerprint) throw new Error('This approval key belongs to a different draft. Review the changed draft and use a new key.');
    if (active.has(idempotencyKey)) return active.get(idempotencyKey);
    if (existing) {
      if (existing.status === 'running') {
        existing.status = 'uncertain';
        existing.error = 'The app stopped before it recorded the result. Check provider state before any new approval. This action was not sent again.';
        await save(existing);
      }
      return existing;
    }
    const task = (async () => {
      const receipt = { id: idempotencyKey, runId: randomUUID(), world, fingerprint, status: 'running', createdAt: new Date().toISOString(), steps: [] };
      await save(receipt);
      for (const step of steps) {
        const evidence = { action: step.action, input: redact(step.input), status: 'running', startedAt: new Date().toISOString() };
        receipt.steps.push(evidence);
        await save(receipt);
        const started = performance.now();
        try {
          const result = await providers.execute(step.action, step.input);
          if (result?.readback == null) throw new Error('The provider write has no readback evidence.');
          evidence.status = 'passed';
          evidence.result = redact(result);
          receipt.result = evidence.result;
        } catch (error) {
          evidence.status = 'uncertain';
          evidence.error = redact(error.message);
          receipt.status = 'uncertain';
          receipt.error = `Stopped at ${step.action}. The provider may have accepted the write. Check its record before another approval. Successful steps will not be sent again.`;
        }
        evidence.durationMs = Math.round(performance.now() - started);
        await save(receipt);
        if (receipt.status === 'uncertain') break;
      }
      if (receipt.status === 'running') receipt.status = 'passed';
      receipt.completedAt = new Date().toISOString();
      await save(receipt);
      return receipt;
    })();
    active.set(idempotencyKey, task);
    try { return await task; } finally { active.delete(idempotencyKey); }
  }
  return { run, validate };
}
