import { localFetch } from './safety.mjs';

export function createGoogleTransport(base, { fetcher = globalThis.fetch, now = Date.now } = {}) {
  const request = localFetch(base, fetcher);
  let blockedUntil = 0;
  function limited() {
    const retryAt = new Date(blockedUntil).toISOString();
    const error = new Error(`Google API request limit reached. Gmail, Calendar and Drive share this limit. Try again after ${retryAt}. No request was retried.`);
    return Object.assign(error, { code: 'PROVIDER_RATE_LIMIT', retryAt });
  }
  return async (input, options) => {
    if (now() < blockedUntil) throw limited();
    const response = await request(input, options);
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const retry = Number(response.headers.get('retry-after')) * 1000;
      blockedUntil = reset > now() ? reset : now() + (retry > 0 ? retry : 60000);
      throw limited();
    }
    return response;
  };
}

// Use only for background inventory refresh. Verification and write readbacks
// bypass this cache. New IDs still require a real provider read immediately.
export function createDetailCache({ ttlMs = 300000, maxEntries = 300, now = Date.now } = {}) {
  const entries = new Map();
  return async (id, load, { allowCached = false } = {}) => {
    const saved = entries.get(id);
    if (allowCached && saved && now() - saved.readAt < ttlMs) return { data: saved.data, cached: true, readAt: saved.readAt };
    const data = await load();
    const readAt = now();
    entries.delete(id);
    entries.set(id, { data, readAt });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return { data, cached: false, readAt };
  };
}
