import { AsyncLocalStorage } from 'node:async_hooks';
const operations = new AsyncLocalStorage();
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function checkBudget() { operations.getStore()?.signal.throwIfAborted(); }

// Protocol SDKs can return 64-bit counters as BigInt (for example IMAP modseq).
// Keep every digit when these results cross the app's JSON API/store boundary.
export function serializableData(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

export async function boundedOperation(work, milliseconds = 45000) {
  const controller = new AbortController();
  let timer;
  try {
    return await operations.run(controller, () => Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('The provider operation exceeded 45 seconds. Check provider state before repeating a write.');
        error.code = 'PROVIDER_TIMEOUT';
        controller.abort(error);
        reject(error);
      }, milliseconds);
    })]));
  } finally { clearTimeout(timer); }
}

export function localUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname) || url.username || url.password) {
    throw new Error('Only generated local HTTP bindings are allowed.');
  }
  return url;
}

export function localFetch(base, fetcher = globalThis.fetch) {
  const allowed = localUrl(base).origin;
  return async (input, options = {}) => {
    const url = localUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== allowed) throw new Error('The request does not match this provider binding.');
    checkBudget();
    const signals = [options.signal, operations.getStore()?.signal, AbortSignal.timeout(15000)].filter(Boolean);
    return fetcher(input, { ...options, redirect: options.redirect === 'manual' ? 'manual' : 'error', signal: AbortSignal.any(signals) });
  };
}

export function hostPort(value) {
  const url = localUrl(`http://${value}`);
  if (!url.port) throw new Error('A generated local port is required.');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) };
}

export function required(input, name, max = 10000) {
  const value = input?.[name];
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}

export function headerValue(input, name) {
  const value = required(input, name, 998);
  if (/[\r\n]/.test(value)) throw new Error(`${name} cannot contain a line break.`);
  return value;
}

export function pathId(input, name) { return encodeURIComponent(required(input, name, 300)); }

export async function pages(load, getItems, getNext, limit = 50) {
  const result = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < limit; page++) {
    checkBudget();
    const response = await load(cursor);
    result.push(...getItems(response));
    const next = getNext(response);
    if (!next) return result;
    if (seen.has(next)) throw new Error('Provider repeated a pagination cursor.');
    seen.add(next);
    cursor = next;
  }
  throw new Error(`Provider exceeded the ${limit}-page safety limit. Narrow the request.`);
}

export function assertReadback(condition, operation) {
  if (!condition) {
    const error = new Error(`${operation} was accepted, but fresh readback did not confirm it. Do not repeat the write without checking the provider.`);
    error.code = 'READBACK_UNCONFIRMED';
    throw error;
  }
}
