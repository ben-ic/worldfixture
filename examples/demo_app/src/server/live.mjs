// Server-sent events carry measured app state, not a simulated progress clock.
export function createLiveHub({ redact = value => value, heartbeatMs = 15000 } = {}) {
  const clients = new Set();
  const initial = new Map();
  let sequence = 0;
  function send(response, event, value) {
    if (response.destroyed || response.writableEnded) { clients.delete(response); return; }
    if (initial.has(response) && event !== 'connected') {
      const queue = initial.get(response);
      if (queue.length >= 1000) { initial.delete(response); clients.delete(response); response.destroy(); }
      else queue.push([event, value]);
      return;
    }
    try {
      const frame = `id: ${++sequence}\nevent: ${event}\ndata: ${JSON.stringify(redact(value))}\n\n`;
      if (response.writableLength > 4 * 1024 * 1024) { clients.delete(response); response.end(); }
      else {
        response.write(frame);
        if (event === 'connected' && initial.has(response)) {
          const queued = initial.get(response); initial.delete(response);
          for (const [type, payload] of queued) send(response, type, payload);
        }
      }
    } catch { clients.delete(response); response.destroy(); }
  }
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try { if (client.writableLength > 4 * 1024 * 1024) { clients.delete(client); client.end(); } else client.write(': keep-alive\n\n'); }
      catch { clients.delete(client); client.destroy(); }
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    get size() { return clients.size; },
    attach(request, response) {
      if (clients.size >= 32) throw Object.assign(new Error('Too many live connections. Close an unused Account Desk tab.'), { status: 429 });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
      response.write('retry: 2000\n\n');
      clients.add(response);
      initial.set(response, []);
      response.on('close', () => { clients.delete(response); initial.delete(response); });
      return (event, value) => send(response, event, value);
    },
    publish(event, value) { for (const client of clients) send(client, event, value); },
    close() { clearInterval(heartbeat); for (const client of clients) client.end(); clients.clear(); initial.clear(); },
  };
}
