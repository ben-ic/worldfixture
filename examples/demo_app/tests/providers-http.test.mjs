import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspectHttpTargets, parseFeed } from '../src/providers/http-targets.mjs';

const feed = '<rss version="2.0"><channel><title>Customer news</title><item><guid isPermaLink="false">a-1</guid><title>One &amp; two</title><link>http://127.0.0.1/item</link><description>Local update</description></item></channel></rss>';
test('RSS parser preserves stable identifiers, text and rejects invalid feeds/entities', () => {
  const parsed = parseFeed(feed);
  assert.equal(parsed.items[0].id, 'a-1');
  assert.equal(parsed.items[0].title, 'One & two');
  assert.throws(() => parseFeed('<bad>'), /invalid XML/);
  assert.throws(() => parseFeed('<!DOCTYPE rss><rss/>'), /entity/);
  assert.throws(() => parseFeed('<rss version="1.0"><channel/></rss>'), /RSS 2.0/);
});

test('HTTP checks discover dynamic paths and distinguish expected failures', async t => {
  let count = 0;
  const server = createServer((request, response) => {
    if (request.url === '/') return response.end('<a href="/a">Healthy service</a><a href="/b">Failing service</a><a href="/c">Changing service</a><a href="/news">Raw RSS feed</a><a href="/schema">OpenAPI document</a><a href="https://example.com">External</a>');
    if (request.url === '/b') response.statusCode = 503;
    if (request.url === '/c') response.statusCode = count++ % 2 ? 503 : 200;
    if (request.url === '/news') { response.setHeader('Content-Type', 'application/rss+xml'); return response.end(feed); }
    if (request.url === '/schema') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ openapi: '3.0.3', paths: { '/facts': { get: { responses: { 200: {} } } } } })); }
    response.end(request.url === '/facts' ? '{"synthetic":true}' : 'Local target');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const data = await inspectHttpTargets(`http://127.0.0.1:${server.address().port}`);
  assert.ok(data.checks.every(check => check.status === 'passed'));
  assert.deepEqual(data.checks.find(check => check.kind === 'failing').actual, [503, 503]);
  assert.equal(data.feeds[0].items[0].id, 'a-1');
  assert.ok(data.targets.some(target => target.url.endsWith('/facts')));
  assert.ok(!data.targets.some(target => target.url.includes('example.com')));
});
