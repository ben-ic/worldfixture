import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProviders } from '../src/providers/index.mjs';
import { createHmac } from 'node:crypto';

test('advanced Notion reads keep REST/Admin/MCP credentials separate and require explicit consent', async t => {
  let base;
  const calls = [];
  const page = { object: 'page', id: 'new-page', url: 'http://127.0.0.1/new-page', public_url: null, properties: { title: { type: 'title', title: [{ plain_text: 'New account note' }] } } };
  const payload = { subscription_id: 'subscription1', entity: { id: 'new-page' }, type: 'page.properties_updated' };
  let changed = false, removed = false;
  const server = createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk;
    const path = new URL(request.url, base).pathname;
    calls.push({ path, method: request.method, auth: request.headers.authorization });
    let result = {};
    if (path === '/.well-known/oauth-protected-resource/mcp') result = { resource: `${base}/mcp`, authorization_servers: [base] };
    else if (path === '/.well-known/oauth-authorization-server') result = { token_endpoint: `${base}/token` };
    else if (path === '/v1/users') result = { results: [{ id: 'person1', type: 'person', name: 'Person One' }], has_more: false };
    else if (path === '/admin/v1/legal_holds') { assert.equal(request.headers.authorization, 'Bearer admin-only'); assert.equal(request.headers['notion-version'], '2026-06-01'); result = { results: [], has_more: false }; }
    else if (path === '/v1/agents/query' || path === '/v1/sessions/query') result = { results: [], has_more: false };
    else if (path === '/v1/agents/agent1') result = { id: 'agent1', status: 'active' };
    else if (path === '/v1/sessions' || path === '/v1/sessions/session1') result = { id: 'session1', agent_id: 'agent1', status: 'completed' };
    else if (path === '/v1/sessions/session1/events/query') result = { results: [{ type: 'user.message', content: [{ type: 'text', text: 'Review account note' }] }], has_more: false };
    else if (path === '/v1/pages') result = page;
    else if (path === '/v1/pages/new-page') {
      if (request.method === 'PATCH') { changed = true; page.icon = { type: 'emoji', emoji: '✅' }; }
      result = page;
    } else if (path === '/v1/pages/new-page/markdown') result = { markdown: '# New account note\nBrief content' };
    else if (path === '/__worldfixture/notion-admin') result = { live_webhook_delivery: false, webhook_deliveries: changed ? [{ payload, signature: `sha256=${createHmac('sha256', 'temporary-webhook-key').update(JSON.stringify(payload)).digest('hex')}` }] : [] };
    else if (path === '/__worldfixture/notion-admin/webhooks') { assert.equal(new URL(JSON.parse(content).url).protocol, 'https:'); result = { id: 'subscription1', verification_token: 'temporary-webhook-key' }; }
    else if (path === '/__worldfixture/notion-admin/webhooks/subscription1/verify') result = { status: 'active' };
    else if (path === '/__worldfixture/notion-admin/webhooks/subscription1' && request.method === 'DELETE') { removed = true; result = {}; }
    else if (path === '/register') { response.statusCode = 201; result = { client_id: 'client1' }; }
    else if (path === '/authorize') {
      const fields = new URLSearchParams(content);
      assert.equal(fields.get('user_id'), 'person1');
      assert.equal(fields.get('code_challenge_method'), 'S256');
      assert.ok(fields.get('code_challenge').length > 30);
      response.statusCode = 302;
      response.setHeader('Location', `${fields.get('redirect_uri')}?code=code1&state=${fields.get('state')}`);
      response.end(); return;
    } else if (path === '/token') { assert.ok(new URLSearchParams(content).get('code_verifier').length > 40); result = { access_token: 'mcp-only' }; }
    else if (path === '/mcp') {
      assert.equal(request.headers.authorization, 'Bearer mcp-only');
      const body = JSON.parse(content);
      if (body.method === 'notifications/initialized') { response.statusCode = 202; response.end(); return; }
      result = { jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { protocolVersion: '2025-11-25' } : body.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ pages: [page] }) }] } : { tools: [{ name: 'notion-create-pages', description: 'Create notes', inputSchema: { type: 'object' } }] } };
    } else response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  base = `http://127.0.0.1:${server.address().port}`;
  const providers = createProviders({ NOTION_BASE_URL: base, NOTION_TOKEN: 'rest-only', NOTION_ADMIN_BASE_URL: base, NOTION_ADMIN_TOKEN: 'admin-only' });
  const before = await providers.read('notion-mcp');
  assert.equal(before.connected, false);
  assert.ok(calls.every(call => call.method === 'GET'));
  await providers.read('notion-admin');
  await providers.read('notion-agent');
  const connected = await providers.execute('notion-mcp.connect', { userId: 'person1' });
  assert.equal(connected.readback.tools, 1);
  assert.ok(!JSON.stringify(connected).includes('mcp-only'));
  assert.equal((await providers.read('notion-mcp')).connected, true);
  const created = await providers.execute('notion-mcp.page', { parentPageId: 'parent1', title: 'New account note', text: 'Brief content' });
  assert.equal(created.readback.page.id, 'new-page');
  assert.equal(created.readback.markdown.markdown, '# New account note\nBrief content');
  const session = await providers.execute('notion-agent.session', { agentId: 'agent1', message: 'Review account note' });
  assert.equal(session.readback.events[0].type, 'user.message');
  const webhook = await providers.execute('notion.webhook-capture', { parentPageId: 'parent1', title: 'Webhook test' });
  assert.equal(webhook.readback.signatureVerified, true);
  assert.equal(webhook.readback.networkDelivery, false);
  assert.equal(removed, true);
  assert.ok(!JSON.stringify(webhook).includes('temporary-webhook-key'));
});
