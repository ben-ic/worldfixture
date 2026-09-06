import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from '../src/server/app.mjs';
import { createStore } from '../src/db/store.mjs';
import { createLiveHub } from '../src/server/live.mjs';
import { EventEmitter } from 'node:events';

test('SSE sends the connection snapshot before updates that arrive while it loads', () => {
  const hub = createLiveHub();
  const response = new EventEmitter();
  const frames = [];
  Object.assign(response, { writeHead() {}, write(frame) { frames.push(frame); }, end() {}, writableLength: 0 });
  try {
    const send = hub.attach({}, response);
    hub.publish('receipt', { id: 'approval', status: 'running' });
    assert.equal(frames.some(frame => frame.includes('event: receipt')), false);
    send('connected', { receipts: [] });
    const events = frames.filter(frame => frame.includes('event:')).map(frame => /event: (\w+)/.exec(frame)[1]);
    assert.deepEqual(events, ['connected', 'receipt']);
  } finally { hub.close(); }
});

test('SSE streams loading, data and persisted action progress; reconnect gets actual state', async () => {
  const store = await createStore({ ACCOUNT_DESK_SQLITE_PATH: ':memory:' });
  let releaseWrite;
  const app = createApplication({ store, env: { TEST_TOKEN: 'private-fixture-value' }, actions: [{ id: 'slack.send', service: 'slack', fields: [{ name: 'text' }] }], connector: { handle: async () => null }, providers: {
    catalog: () => [{ id: 'slack', name: 'Slack', selected: true }],
    async read() { return { items: [{ id: '1', text: 'Current message' }] }; },
    async execute() { await new Promise(resolve => { releaseWrite = resolve; }); return { record: { id: '2' }, readback: { id: '2', authorization: 'Bearer private-fixture-value' } }; },
  } });
  const abort = new AbortController();
  const frames = [];
  const waiters = [];
  let monitor;
  function waitFor(predicate) {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected stream event did not arrive.')), 5000);
      waiters.push(frame => { if (predicate(frame)) { clearTimeout(timer); resolve(frame); return true; } return false; });
    });
  }
  try {
    const origin = await app.listen(0);
    const response = await fetch(origin + '/api/live', { signal: abort.signal });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    monitor = (async () => {
      let pending = '';
      for await (const chunk of response.body) {
        pending += new TextDecoder().decode(chunk);
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const raw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !raw) continue;
          const value = { event, data: JSON.parse(raw) }; frames.push(value);
          for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i](value)) waiters.splice(i, 1);
        }
      }
    })().catch(error => { if (!abort.signal.aborted) throw error; });
    await waitFor(frame => frame.event === 'connected');
    await app.refreshAll();
    await waitFor(frame => frame.event === 'service' && frame.data.service.state === 'ready');
    const request = fetch(origin + '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'slack.send', input: { text: 'Approved' }, idempotencyKey: 'stream-write-approval' }) });
    await waitFor(frame => frame.event === 'receipt' && frame.data.steps[0]?.status === 'running');
    // The client sees the real running step before the provider completes.
    assert.ok(releaseWrite);
    releaseWrite();
    await waitFor(frame => frame.event === 'receipt' && frame.data.status === 'passed');
    assert.equal((await request).status, 200);
    assert.ok(frames.some(frame => frame.event === 'service' && frame.data.service.state === 'loading'));
    assert.doesNotMatch(JSON.stringify(frames), /private-fixture-value/);
    abort.abort(); await monitor;
    const reconnectAbort = new AbortController();
    const reconnect = await fetch(origin + '/api/live', { signal: reconnectAbort.signal });
    const reader = reconnect.body.getReader();
    let first = '';
    while (!first.includes('event: connected') || !first.trimEnd().endsWith('}')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      first += new TextDecoder().decode(chunk.value);
    }
    assert.match(first, /stream-write-approval/);
    reconnectAbort.abort();
  } finally { abort.abort(); releaseWrite?.(); await monitor; await app.close(); await store.close(); }
});
