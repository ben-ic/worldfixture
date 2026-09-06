import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { localUrl, localFetch, checkBudget } from './safety.mjs';

function decodeText(value) {
  return value.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

export function parseFeed(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('RSS entity declarations are not accepted.');
  if (XMLValidator.validate(xml) !== true) throw new Error('The RSS target returned invalid XML.');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false }).parse(xml);
  if (parsed.rss?.['@_version'] !== '2.0' || !parsed.rss.channel) throw new Error('The feed is not RSS 2.0.');
  const channel = parsed.rss.channel;
  const entries = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
  const text = value => typeof value === 'object' ? value?.['#text'] || '' : value || '';
  const items = entries.map(item => ({ id: text(item.guid), title: text(item.title), url: text(item.link), summary: text(item.description), publishedAt: text(item.pubDate) }));
  if (items.some(item => !item.id || !item.title) || new Set(items.map(item => item.id)).size !== items.length) throw new Error('RSS entries must have a title and a unique stable GUID.');
  return { title: text(channel.title), description: text(channel.description), items };
}

export async function inspectHttpTargets(value) {
  const root = localUrl(value).href.replace(/\/$/, '');
  const fetcher = localFetch(root);
  const checks = [], feeds = [], targets = [];
  async function measure(url, title) {
    checkBudget();
    const started = Date.now();
    const response = await fetcher(url);
    const content = await response.text();
    if (content.length > 2_000_000) throw new Error('HTTP target exceeded the 2 MB inspection limit.');
    return { id: String(url), url: String(url), title, status: response.status, durationMs: Date.now() - started, contentType: response.headers.get('content-type'), content };
  }
  const home = await measure(`${root}/`, 'Site root');
  targets.push(home);
  checks.push({ id: 'root', expected: 'HTTP 2xx', actual: home.status, status: home.status >= 200 && home.status < 300 ? 'passed' : 'failed' });
  const found = new Map();
  for (const match of home.content.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const url = localUrl(new URL(decodeText(match[1]), `${root}/`));
      if (url.origin === new URL(root).origin && url.pathname !== '/') found.set(url.href, { url: url.href, title: decodeText(match[2]) || url.pathname });
    } catch { /* Never fetch external links from page content. */ }
  }
  found.set(`${root}/metrics`, { url: `${root}/metrics`, title: 'Metrics' });
  const expectedModes = { 'Healthy service': 'stable', 'Failing service': 'failing', 'Changing service': 'flapping' };
  for (const { url, title } of [...found.values()].slice(0, 30)) {
    const first = await measure(url, title);
    targets.push(first);
    const mode = expectedModes[title];
    if (mode) {
      const statuses = [first.status];
      for (let sample = 1; sample < (mode === 'flapping' ? 6 : 2); sample++) statuses.push((await measure(url, title)).status);
      const success = status => status >= 200 && status < 300;
      const bad = status => status >= 400;
      const passed = mode === 'stable' ? statuses.every(success) : mode === 'failing' ? statuses.every(bad) : statuses.some(success) && statuses.some(bad);
      checks.push({ id: url, kind: mode, expected: mode === 'stable' ? 'Repeated HTTP success' : mode === 'failing' ? 'Repeated HTTP failure (expected)' : 'Both success and failure in a six-request sample', actual: statuses, status: passed ? 'passed' : mode === 'flapping' ? 'not-verified' : 'failed' });
      first.expectedMode = mode;
      first.samples = statuses;
    }
    if (/xml/i.test(first.contentType || '') && /<rss\b/.test(first.content)) {
      const feed = parseFeed(first.content);
      const next = parseFeed((await measure(url, title)).content);
      const nextIds = new Set(next.items.map(item => item.id));
      const stable = feed.items.every(item => nextIds.has(item.id));
      feeds.push({ url, ...feed });
      checks.push({ id: `${url}#rss`, kind: 'rss', expected: 'Valid RSS 2.0; unique GUIDs; existing GUIDs remain on the next read', actual: { entries: feed.items.length, stable }, status: stable ? 'passed' : 'failed' });
    }
    if (title === 'OpenAPI document') {
      let document;
      try { document = JSON.parse(first.content); } catch { throw new Error('The advertised OpenAPI target did not return JSON.'); }
      if (!document.openapi || !document.paths) throw new Error('The advertised OpenAPI document is incomplete.');
      for (const [path, methods] of Object.entries(document.paths).slice(0, 20)) {
        if (!methods.get || path.includes('{')) continue;
        const endpoint = localUrl(new URL(path, `${root}/`));
        if (endpoint.origin !== new URL(root).origin) throw new Error('OpenAPI path escaped the local target origin.');
        const result = await measure(endpoint.href, `API ${path}`);
        targets.push(result);
        const expected = Object.keys(methods.get.responses ?? {});
        const passed = expected.includes(String(result.status)) || expected.includes('default');
        checks.push({ id: endpoint.href, kind: 'openapi', expected, actual: result.status, status: passed ? 'passed' : 'failed' });
      }
    }
  }
  const items = targets.map(({ content, ...target }) => ({ ...target, preview: content.slice(0, 1000), subtitle: `HTTP ${target.status} · ${target.durationMs} ms` }));
  return {
    items, targets: items, feeds, checks, truncated: found.size > 30,
    note: 'GET requests advance page variants and probe counters. Probe checks compare advertised behavior, not an unavailable exact status sequence. RSS checks prove current entries and stable GUIDs; delayed arrivals require a later read. At most 30 links and 20 OpenAPI paths are inspected.',
  };
}
