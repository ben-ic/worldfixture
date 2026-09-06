import {timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {openDomainStore} from './store.mjs';
import {DomainError} from './validation.mjs';

const send = (response, status, value) => { response.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}); response.end(`${JSON.stringify(value)}\n`); };
async function body(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new DomainError(415, 'unsupported_media_type', 'Writes require application/json');
  const chunks = [];
  await new Promise((resolve, reject) => {
    let bytes = 0, exceeded = false;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (exceeded) return;
      if (bytes > 1024 * 1024) { exceeded = true; chunks.length = 0; reject(new DomainError(413, 'request_too_large', 'Domain requests are limited to 1 MiB')); }
      else chunks.push(chunk);
    });
    request.once('end', resolve);
    request.once('error', reject);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError(400, 'invalid_json', 'Request body is not valid JSON'); }
}
function options(url) {
  for (const key of url.searchParams.keys()) if (!['limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new DomainError(400, 'invalid_query', 'Only one limit and one cursor are supported');
  if (url.searchParams.has('cursor') && !url.searchParams.get('cursor')) throw new DomainError(400, 'invalid_cursor', 'cursor cannot be empty');
  return Object.fromEntries(url.searchParams);
}
export function createDomainService(configuration) {
  const store = openDomainStore(configuration), token = Buffer.from(`Bearer ${configuration.token}`);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://domain.local');
      if (url.pathname === '/readyz' && request.method === 'GET') return send(response, 200, {ready: true, world: store.world});
      const authorization = Buffer.from(request.headers.authorization ?? '');
      if (authorization.length !== token.length || !timingSafeEqual(authorization, token)) throw new DomainError(401, 'unauthorized', 'A current domain service credential is required');
      if (url.pathname === '/v1/collections' && request.method === 'GET') return send(response, 200, store.listCollections(options(url)));
      if (url.pathname === '/v1/events' && request.method === 'GET') return send(response, 200, store.listEvents(options(url)));
      const parts = url.pathname.split('/').slice(1).map(part => { try { return decodeURIComponent(part); } catch { throw new DomainError(400, 'invalid_path', 'Path has invalid escaping'); } });
      if (parts[0] !== 'v1' || parts[1] !== 'collections' || ![3, 4].includes(parts.length)) throw new DomainError(404, 'route_not_found', 'No such domain API route');
      const [, , collection, id] = parts;
      if (request.method === 'GET') return send(response, 200, id === undefined ? store.listRecords(collection, options(url)) : store.detail(collection, id));
      if (url.search) throw new DomainError(400, 'invalid_query', 'Writes do not accept query parameters');
      if (request.method === 'POST' && (id === undefined || id === 'validate')) return send(response, id === 'validate' ? 200 : 201, store.mutate(collection, 'create', await body(request), undefined, {validateOnly: id === 'validate'}));
      if (id !== undefined && ['PATCH', 'DELETE'].includes(request.method)) return send(response, 200, store.mutate(collection, request.method === 'PATCH' ? 'update' : 'delete', await body(request), id));
      throw new DomainError(405, 'method_not_allowed', 'This method is not supported for the selected route');
    } catch (error) {
      send(response, error instanceof DomainError ? error.status : 500, {ok: false, error: {code: error.code ?? 'internal_error', message: error instanceof DomainError ? error.message : 'The domain request could not be completed', ...(error.field ? {field: error.field} : {})}});
    }
  });
  let closing;
  return {server, store, close: () => closing ??= (async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); store.close(); })()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.WORLDFIXTURE_WORLD_PATH) {
    console.error('worldfixture: missing world: WORLDFIXTURE_WORLD_PATH is required');
    process.exitCode = 64;
  } else try {
    const address = process.env.WORLDFIXTURE_DOMAIN_LISTEN ?? '127.0.0.1:4717';
    const match = /^(.*):(\d+)$/.exec(address);
    if (!match || Number(match[2]) > 65535) throw new Error('WORLDFIXTURE_DOMAIN_LISTEN must be host:port');
    const service = createDomainService({worldPath: process.env.WORLDFIXTURE_WORLD_PATH, statePath: process.env.WORLDFIXTURE_STATE_PATH,
      expectedDigest: process.env.WORLDFIXTURE_WORLD_SHA256, token: process.env.DOMAIN_TOKEN});
    service.server.on('error', error => { console.error(`Domain listener failed: ${error.code}`); service.store.close(); process.exitCode = 1; });
    service.server.listen(Number(match[2]), match[1], () => console.log(`Domain API ready for ${service.store.world.id}:${service.store.world.version}`));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => service.close().then(() => process.exit(0)));
  } catch (error) { console.error(`Domain startup failed: ${error.code ?? 'invalid_configuration'}: ${error.message}`); process.exitCode = 1; }
}
