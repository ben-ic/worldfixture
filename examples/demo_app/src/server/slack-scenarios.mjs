import { randomUUID } from 'node:crypto';

const RUNS = 'slackScenarios';
const PLANS = 'slackScenarioPlans';
const unfinished = new Set(['running', 'stopping']);
const copy = value => structuredClone(value);
const texts = [
  '[Account Desk local scenario 1/3] Incident review exercise: check a delayed account update. This is test data, not a real outage.',
  '[Account Desk local scenario 2/3] Open Service health and compare the provider responses before you decide what to do.',
  '[Account Desk local scenario 3/3] Record the result and the next check. This exercise did not change service health.',
];

export function createSlackScenarios({ providers, store, workflows, world, onUpdate = () => {}, onMessage = () => {}, intervalMs = 3000 }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) throw new Error('Scenario interval must be between 0 and 60000 milliseconds.');
  const active = new Map();
  const starts = new Map();
  let closed = false, restored, startingPlan = null;
  const sameWorld = value => JSON.stringify(value.world) === JSON.stringify(world);
  async function notify(run) {
    try { await onUpdate(copy(run)); } catch { /* A UI connection cannot invalidate a provider receipt. */ }
  }
  async function save(run) { run.updatedAt = new Date().toISOString(); await store.put(RUNS, run.id, run); await notify(run); }
  function restore() {
    restored ??= (async () => {
      for (const run of await store.list(RUNS)) {
        if (!sameWorld(run) || !unfinished.has(run.status)) continue;
        run.status = 'interrupted';
        run.completedAt = new Date().toISOString();
        run.nextSendAt = null;
        run.error = 'The app stopped before this scenario finished. Check its receipts and Slack messages. No message was sent again.';
        await save(run);
      }
    })();
    return restored;
  }
  function available() {
    if (closed) throw new Error('Slack scenarios are closed.');
    if (!providers.catalog().some(item => item.id === 'slack' && item.selected)) throw new Error('Slack is not selected in this world.');
  }
  async function preview(channel) {
    await restore();
    available();
    if (typeof channel !== 'string' || !channel.trim() || channel.length > 100) throw new Error('Select a Slack conversation.');
    const data = await providers.read('slack');
    const conversation = data.conversations?.find(item => item.id === channel && !item.is_archived);
    if (!conversation) throw new Error('This conversation is not available in the current world. Refresh Slack and select one of its conversations.');
    const now = Date.now(), id = randomUUID();
    const plan = {
      id, world, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60000).toISOString(),
      channel, name: conversation.name || 'Direct conversation', channelName: conversation.name || 'Direct conversation', intervalMs,
      baselineMessageTs: (conversation.messages ?? []).slice(0, 30).map(message => message.ts).filter(ts => typeof ts === 'string'),
      sender: { label: 'Current local Slack API identity', mode: 'authenticated-sdk-token' },
      scope: 'Three local scenario messages through the official Slack SDK. These are test messages, not messages from simulated people. Each send is read back from Slack.',
      steps: texts.map((text, index) => ({ id: `${id}-${index}`, action: 'slack.send', input: { channel, text } })),
    };
    await store.put(PLANS, id, plan);
    return copy(plan);
  }
  function pause(control) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { control.cancelWait = null; resolve(); }, intervalMs);
      control.cancelWait = () => { clearTimeout(timer); control.cancelWait = null; resolve(); };
    });
  }
  async function perform(control) {
    const { run } = control;
    try {
      for (let index = 0; index < run.steps.length; index++) {
        run.nextSendAt = new Date(Date.now() + intervalMs).toISOString();
        await save(run);
        if (control.stop) break;
        await pause(control);
        if (control.stop) break;
        const step = run.steps[index];
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        run.nextSendAt = null;
        await save(run);
        if (control.stop) { step.status = 'pending'; break; }
        const receipt = await workflows.run({ steps: [{ action: step.action, input: step.input }], idempotencyKey: step.receiptId });
        step.receiptStatus = receipt.status;
        step.status = receipt.status === 'passed' ? 'passed' : 'uncertain';
        step.completedAt = new Date().toISOString();
        if (step.status !== 'passed') {
          step.error = receipt.error || 'Slack did not confirm this message. Check the receipt before sending another message.';
          run.status = 'failed';
          run.error = step.error;
          await save(run);
          break;
        }
        const confirmed = receipt.result?.readback?.messages?.find(message => message.ts === receipt.result?.record?.ts && message.text === step.input.text);
        if (!confirmed) {
          step.status = 'uncertain';
          throw new Error('The receipt has no exact Slack message readback');
        }
        step.result = { channel: receipt.result.record.channel, ts: confirmed.ts, text: confirmed.text, ...(confirmed.user ? { user: confirmed.user } : {}) };
        run.sent = run.steps.filter(item => item.status === 'passed').length;
        await save(run);
        try { await onMessage({ runId: run.id, channel: run.channel, step: copy(step), receipt: copy(receipt) }); }
        catch { run.notice = 'The message was confirmed in Slack, but the app refresh failed. Refresh Slack to see it.'; }
      }
      if (run.status !== 'failed') run.status = control.stop ? 'stopped' : 'passed';
    } catch (error) {
      run.status = 'failed';
      run.error = `Scenario stopped: ${error.message}. Check the latest receipt before another approval. No message was retried.`;
    } finally {
      run.completedAt = new Date().toISOString();
      run.nextSendAt = null;
      try { await save(run); } finally { active.delete(run.id); }
    }
    return copy(run);
  }
  function start({ planId, approved } = {}) {
    if (approved !== true) return Promise.reject(new Error('Review the three messages and approve the scenario before it starts.'));
    if (typeof planId !== 'string' || !planId) return Promise.reject(new Error('A saved scenario plan is required.'));
    if (starts.has(planId)) return starts.get(planId);
    const task = (async () => {
      await restore();
      available();
      const existing = await store.get(RUNS, planId);
      if (existing) {
        if (!sameWorld(existing)) throw new Error('This scenario belongs to another world.');
        return copy(existing);
      }
      if (active.size || startingPlan) throw new Error('Stop or finish the current Slack scenario before starting another.');
      startingPlan = planId;
      const plan = await store.get(PLANS, planId);
      if (!plan || !sameWorld(plan)) throw new Error('This scenario plan is not available in the current world.');
      if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error('The scenario plan expired. Preview the messages again.');
      const run = {
        id: plan.id, planId: plan.id, world, channel: plan.channel, name: plan.name, channelName: plan.channelName || plan.name, sender: plan.sender, baselineMessageTs: plan.baselineMessageTs,
        status: 'running', createdAt: new Date().toISOString(), sent: 0, total: plan.steps.length,
        intervalMs, nextSendAt: new Date(Date.now() + intervalMs).toISOString(),
        steps: plan.steps.map((step, index) => ({ ...step, status: 'pending', receiptId: `slack-scenario-${plan.id}-${index}` })),
      };
      const control = { run, stop: false, cancelWait: null, task: null };
      active.set(run.id, control);
      try { await save(run); } catch (error) { active.delete(run.id); throw error; }
      control.task = perform(control);
      // Keep an asynchronous storage failure observed until close()/wait().
      control.task.catch(() => {});
      return copy(run);
    })().finally(() => { starts.delete(planId); if (startingPlan === planId) startingPlan = null; });
    starts.set(planId, task);
    return task;
  }
  async function stop(id) {
    await restore();
    const control = active.get(id);
    if (control) {
      control.stop = true;
      control.run.status = 'stopping';
      control.run.nextSendAt = null;
      control.cancelWait?.();
      await save(control.run);
      return copy(control.run);
    }
    const run = await store.get(RUNS, id);
    if (!run || !sameWorld(run)) throw new Error('This Slack scenario does not exist in the current world.');
    return copy(run);
  }
  async function list() { await restore(); return (await store.list(RUNS)).filter(sameWorld).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async function wait(id) { await restore(); return active.has(id) ? active.get(id).task : store.get(RUNS, id); }
  async function close() {
    closed = true;
    await restore();
    await Promise.allSettled([...starts.values()]);
    const pending = [...active.values()];
    await Promise.all(pending.map(control => stop(control.run.id)));
    await Promise.all(pending.map(control => control.task));
  }
  return { preview, start, stop, list, restore, wait, close };
}
