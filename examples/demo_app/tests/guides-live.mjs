import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebClient } from '@slack/web-api';
import { localUrl } from '../src/server/security.mjs';

// Opt-in application HTTP + official SDK proof. Run through the installed npx
// flow in a separate test app. Do not run while a person uses its scenario slot.
// No reset, world stop, private emulator access, or provider write retry occurs.
if (process.env.ACCOUNT_DESK_ALLOW_TEST_WRITES !== '1') throw new Error('Set ACCOUNT_DESK_ALLOW_TEST_WRITES=1 only for an isolated local test app.');
if (!process.env.ACCOUNT_DESK_URL) throw new Error('ACCOUNT_DESK_URL must name the local app to test.');
if (!process.env.SLACK_BASE_URL || !process.env.SLACK_TOKEN) throw new Error('Use npx --no-install worldfixture run -- node tests/guides-live.mjs to supply this app’s generated Slack bindings.');
const origin = localUrl(process.env.ACCOUNT_DESK_URL).origin;
const slackOrigin = localUrl(process.env.SLACK_BASE_URL).origin;
const deadline = AbortSignal.timeout(120000);
const sseAbort = new AbortController();
const owned = new Set();
const progress = [];
let connected = false, sseError = null, streamTask;
const sdk = new WebClient(process.env.SLACK_TOKEN, { slackApiUrl: `${slackOrigin}/api/`, timeout: 10000, allowAbsoluteUrls: false, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });

async function request(path, input, { cleanup = false } = {}) {
  const response = await fetch(origin + path, {
    ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(input) }),
    redirect: 'error', signal: cleanup ? AbortSignal.timeout(10000) : AbortSignal.any([deadline, AbortSignal.timeout(30000)]),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${body.error?.message || body.error || 'Request failed'}`);
  return body;
}
async function until(check, message, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  do {
    deadline.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(100, undefined, { signal: deadline });
  } while (Date.now() < end);
  throw new Error(message);
}
async function history(channel) {
  const messages = [], seen = new Set();
  let cursor;
  for (let page = 0; page < 20; page++) {
    deadline.throwIfAborted();
    const value = await sdk.conversations.history({ channel, limit: 100, cursor });
    messages.push(...(value.messages ?? []));
    cursor = value.response_metadata?.next_cursor;
    if (!cursor) return messages;
    assert.ok(!seen.has(cursor), 'Slack repeated its history cursor.');
    seen.add(cursor);
  }
  throw new Error('Slack history exceeds the 2000-message proof limit. Select a smaller isolated world.');
}
const timestamps = messages => messages.map(message => message.ts).sort();
async function terminal(id) {
  return until(async () => {
    const run = await request(`/api/slack-scenarios/${encodeURIComponent(id)}`);
    return ['running', 'stopping'].includes(run.status) ? null : run;
  }, 'Slack scenario did not finish within 45 seconds.');
}
async function readStream() {
  const response = await fetch(`${origin}/api/live`, { redirect: 'error', signal: AbortSignal.any([deadline, sseAbort.signal]) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { if (!sseAbort.signal.aborted) throw new Error('The live stream ended before verification finished.'); break; }
      buffer += decoder.decode(value, { stream: true });
      assert.ok(buffer.length <= 16 * 1024 * 1024, 'A live frame exceeded the 16 MiB test limit.');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        if (event === 'connected') connected = true;
        if (event !== 'slackScenario') continue;
        const data = JSON.parse(frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
        progress.push({ id: data.id, status: data.status, sent: data.sent, steps: (data.steps ?? []).map(step => step.status) });
        assert.ok(progress.length <= 1000, 'Too many scenario events for this bounded test.');
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

try {
  const state = await request('/api/state');
  assert.ok(state.world?.id && state.world.id !== 'unbound', 'The app needs a running world.');
  const service = state.services?.find(item => item.id === 'slack');
  assert.ok(service?.selected, 'Slack must be selected.');
  assert.equal(localUrl(service.baseUrl).origin, slackOrigin, 'The app and installed CLI must use the same Slack binding.');
  assert.ok(!(await request('/api/slack-scenarios')).some(run => ['running', 'stopping'].includes(run.status)), 'Another scenario is active. Do not interrupt it; run this proof after it ends.');
  const slack = await request('/api/service/slack');
  const conversation = [...(slack.conversations ?? [])].filter(item => !item.is_archived).sort((a, b) => Number(b.latest || 0) - Number(a.latest || 0))[0];
  assert.ok(conversation?.id, 'The world needs a visible Slack conversation.');
  const channel = conversation.id;
  streamTask = readStream().catch(error => { if (!sseAbort.signal.aborted) sseError = error; });
  await until(() => { if (sseError) throw sseError; return connected; }, 'No initial live-stream event arrived.', 15000);

  const beforePreview = await history(channel);
  const previousRuns = await request('/api/slack-scenarios');
  const plan = await request('/api/slack-scenarios/preview', { channel });
  assert.equal(plan.channel, channel);
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps.every(step => step.action === 'slack.send' && step.input.channel === channel && step.input.text.startsWith('[Account Desk local scenario ')));
  assert.deepEqual(timestamps(await history(channel)), timestamps(beforePreview), 'Preview must not create Slack messages.');
  assert.deepEqual((await request('/api/slack-scenarios')).map(run => run.id).sort(), previousRuns.map(run => run.id).sort(), 'Preview must not create a running scenario.');
  owned.add(plan.id);
  const started = await request('/api/slack-scenarios', { planId: plan.id, approved: true });
  assert.equal(started.id, plan.id);
  const completed = await terminal(started.id);
  assert.equal(completed.status, 'passed', completed.error);
  assert.equal(completed.sent, 3);
  const receipts = (await request('/api/state')).receipts;
  const after = await history(channel);
  for (const [index, step] of completed.steps.entries()) {
    assert.equal(step.status, 'passed');
    assert.equal(step.input.text, plan.steps[index].input.text);
    const receipt = receipts.find(item => item.id === step.receiptId);
    assert.equal(receipt?.status, 'passed', 'Each message needs a saved passed workflow receipt.');
    assert.equal(receipt.steps.length, 1);
    assert.equal(receipt.steps[0].action, 'slack.send');
    assert.deepEqual(receipt.steps[0].input, step.input);
    const exact = receipt.result?.readback?.messages?.find(message => message.ts === receipt.result?.record?.ts && message.text === step.input.text);
    assert.ok(exact, 'The workflow must contain exact fresh provider readback.');
    assert.ok(after.some(message => message.ts === exact.ts && message.text === exact.text && message.user === exact.user), 'The official SDK must read the same message from live Slack.');
    assert.equal(step.result.ts, exact.ts);
    assert.equal(step.result.channel, channel);
  }
  await until(() => progress.some(event => event.id === completed.id && event.status === 'passed' && event.sent === 3), 'The final scenario result did not arrive over SSE.');
  assert.ok(progress.some(event => event.id === completed.id && event.status === 'running' && event.sent < 3), 'SSE must show progress before completion.');
  const duplicate = await request('/api/slack-scenarios', { planId: plan.id, approved: true });
  assert.equal(duplicate.id, completed.id);
  assert.deepEqual(duplicate.steps.map(step => step.receiptId), completed.steps.map(step => step.receiptId));
  await delay(Math.min(plan.intervalMs + 250, 10000), undefined, { signal: deadline });
  assert.deepEqual(timestamps(await history(channel)), timestamps(after), 'Repeating approval must not send another message.');

  const stopPlan = await request('/api/slack-scenarios/preview', { channel });
  owned.add(stopPlan.id);
  await request('/api/slack-scenarios', { planId: stopPlan.id, approved: true });
  await request(`/api/slack-scenarios/${encodeURIComponent(stopPlan.id)}/stop`, {});
  const stopped = await terminal(stopPlan.id);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.sent <= 1, 'Prompt stop must prevent later scheduled messages; an already running send can finish.');
  assert.ok(stopped.steps.slice(1).every(step => step.status === 'pending' && !step.result));
  const stoppedHistory = await history(channel);
  await delay(Math.min(stopPlan.intervalMs + 250, 10000), undefined, { signal: deadline });
  assert.deepEqual(timestamps(await history(channel)), timestamps(stoppedHistory), 'No later message may arrive after stop.');
  assert.equal((await request(`/api/slack-scenarios/${encodeURIComponent(stopPlan.id)}`)).sent, stopped.sent);
  await until(() => progress.some(event => event.id === stopped.id && event.status === 'stopped'), 'The stop result did not arrive over SSE.');
  if (sseError) throw sseError;
  console.log(JSON.stringify({ apiVersion: 'account-desk.guides-live/v1', app: origin, world: state.world, channel, preview: 'read-only', scenario: { id: completed.id, messages: 3, officialSdkReadback: true, workflowReceipts: completed.steps.map(step => step.receiptId) }, repeatedApproval: 'no additional send', stop: { id: stopped.id, sent: stopped.sent, laterMessages: 0 }, sse: { progress: true, completed: true, stopped: true }, productionVerified: false }));
} finally {
  sseAbort.abort();
  await streamTask;
  // Cancel only plans this test approved if a check failed during their run.
  // Completed/stopped runs are unchanged by stop. Never stop another user's run.
  for (const id of owned) {
    try { await request(`/api/slack-scenarios/${encodeURIComponent(id)}/stop`, {}, { cleanup: true }); }
    catch { console.error(`Could not confirm cleanup for test scenario ${id}. Check its status before another approval.`); }
  }
}
