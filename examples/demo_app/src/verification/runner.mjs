import { randomUUID } from 'node:crypto';

export function createVerificationRunner({ providers, store, world, workflows, identity = {}, redact = value => value, onUpdate = () => {} }) {
  const tasks = new Map();
  const stopped = new Set();
  async function save(run) { await store.put('runs', run.id, run); onUpdate(redact(run)); }
  async function start(serviceIds) {
    const catalog = providers.catalog();
    const ids = serviceIds ?? catalog.filter(service => service.selected).map(service => service.id);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !catalog.some(service => service.id === id))) throw new Error('Select at least one known service.');
    const run = { id: randomUUID(), world, identity, mode: 'reads', scope: 'Provider read workflows. This is not write coverage or production parity.', status: 'running', createdAt: new Date().toISOString(), results: [...new Set(ids)].map(id => ({ service: id, status: 'not_run' })) };
    await save(run);
    const task = (async () => {
      for (const result of run.results) {
        const service = catalog.find(item => item.id === result.service);
        if (stopped.has(run.id) || !service.selected) {
          result.status = 'skipped';
          result.reason = stopped.has(run.id) ? 'Stopped by the user before this check started.' : 'Service was not selected in this world.';
          await save(run);
          continue;
        }
        result.status = 'running';
        result.expected = 'A valid provider read result with an items array. Empty data is allowed and is reported.';
        result.client = service.client;
        await save(run);
        const began = performance.now();
        try {
          const data = await providers.read(service.id);
          if (!data || !Array.isArray(data.items)) throw new Error('The adapter did not return a resource collection.');
          result.status = 'passed';
          result.count = data.items.length;
          result.evidence = redact(data);
          const failures = (data.checks ?? []).filter(check => check.status === 'failed');
          result.unverifiedChecks = (data.checks ?? []).filter(check => check.status === 'not-verified');
          if (failures.length) throw new Error(failures.map(check => `${check.id}: expected ${check.expected}; got ${check.actual}`).join('; '));
          result.actual = `Read ${data.items.length} records${data.truncated ? ' (bounded sample)' : ''}.`;
        } catch (error) {
          result.status = 'failed';
          result.error = redact(error.message);
        }
        result.durationMs = Math.round(performance.now() - began);
        await save(run);
      }
      run.status = run.results.some(result => result.status === 'failed') ? 'failed' : stopped.has(run.id) ? 'stopped' : 'passed';
      run.completedAt = new Date().toISOString();
      run.summary = Object.fromEntries(['passed', 'failed', 'skipped'].map(status => [status, run.results.filter(result => result.status === status).length]));
      await save(run);
      return run;
    })();
    tasks.set(run.id, task);
    task.finally(() => { tasks.delete(run.id); stopped.delete(run.id); }).catch(() => {});
    return structuredClone(run);
  }
  async function startWrites(plan) {
    if (!workflows) throw new Error('Write verification is not configured.');
    if (!plan?.id || !Array.isArray(plan.steps) || !plan.steps.length) throw new Error('A reviewed write plan is required.');
    // Durable run identity makes a repeated approval return the same run.
    const runId = `write-${plan.id}`;
    const prior = await store.get('runs', runId);
    if (prior) return prior;
    const run = { id: runId, world, identity, mode: 'writes', scope: plan.scope, status: 'running', createdAt: new Date().toISOString(), results: plan.steps.map(step => ({ service: step.service, action: step.action, input: redact(step.input), status: 'not_run' })) };
    await save(run);
    const task = (async () => {
      for (let index = 0; index < plan.steps.length; index++) {
        const step = plan.steps[index], result = run.results[index];
        if (stopped.has(run.id)) {
          result.status = 'skipped'; result.reason = 'Stopped before this action started. No write was sent.'; await save(run); continue;
        }
        result.expected = 'The approved write succeeds and a fresh provider read confirms the saved record.';
        if (!step.ready) {
          result.status = 'failed'; result.error = step.reason || 'A prerequisite is missing. No write was sent.'; await save(run); continue;
        }
        result.status = 'running'; result.receipt = step.id; await save(run);
        const began = performance.now();
        try {
          const receipt = await workflows.run({ steps: [{ action: step.action, input: step.input }], idempotencyKey: step.id });
          result.receipt = receipt.id;
          result.evidence = redact(receipt);
          if (receipt.status !== 'passed') throw new Error(receipt.error || 'The provider result is not confirmed.');
          result.status = 'passed'; result.actual = 'Approved write saved and read back.';
        } catch (error) { result.status = 'failed'; result.error = redact(error.message); }
        result.durationMs = Math.round(performance.now() - began); await save(run);
      }
      run.status = run.results.some(result => result.status === 'failed') ? 'failed' : stopped.has(run.id) ? 'stopped' : 'passed';
      run.completedAt = new Date().toISOString();
      run.summary = Object.fromEntries(['passed', 'failed', 'skipped'].map(status => [status, run.results.filter(result => result.status === status).length]));
      await save(run); return run;
    })();
    tasks.set(run.id, task);
    task.finally(() => { tasks.delete(run.id); stopped.delete(run.id); }).catch(() => {});
    return structuredClone(run);
  }
  return {
    start, startWrites,
    async wait(id) { return tasks.get(id) ? await tasks.get(id) : store.get('runs', id); },
    stop(id) { if (!tasks.has(id)) throw new Error('This run is not active.'); stopped.add(id); return { id, stopping: true }; },
    async close() { for (const id of tasks.keys()) stopped.add(id); await Promise.allSettled([...tasks.values()]); },
  };
}
