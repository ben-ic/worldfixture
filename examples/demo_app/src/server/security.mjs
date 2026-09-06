export function localUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Only local WorldFixture HTTP addresses are allowed.');
  }
  return url;
}

export function makeRedactor(env = {}) {
  const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|ACCESS_KEY|AUTHORIZATION/i.test(key) && typeof value === 'string' && value.length > 3).map(([, value]) => value);
  function redact(value) {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /password|secret|authorization|cookie|(^|_)token($|_)|access.?token|refresh.?token|id.?token|private.?key|api.?key|credential/i.test(key) ? '[redacted]' : redact(item)]));
    if (typeof value === 'string') {
      let text = value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
      return text;
    }
    return value;
  }
  return redact;
}

export function checkRequest(request, origin) {
  let requested;
  try { requested = localUrl(`http://${request.headers.host}`); } catch { throw Object.assign(new Error('Invalid application host.'), { status: 403 }); }
  if (requested.port !== new URL(origin).port) throw Object.assign(new Error('Invalid application port.'), { status: 403 });
  if (request.headers.origin && request.headers.origin !== requested.origin) throw Object.assign(new Error('Cross-origin requests are not allowed.'), { status: 403 });
  if (request.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('Cross-site requests are not allowed.'), { status: 403 });
}

export async function readBody(request, maximum = 1024 * 1024) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('Use Content-Type: application/json.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('Request exceeds the allowed size.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('Request body is not valid JSON.'), { status: 400 }); }
}
