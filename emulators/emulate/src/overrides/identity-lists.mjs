import { getMicrosoftStore } from '@emulators/microsoft';

const graphError = (c, status, code, message) => c.json({ error: { code, message } }, status);
const directoryScopes = new Set(['User.ReadBasic.All', 'User.Read.All', 'User.ReadWrite.All', 'Directory.Read.All', 'Directory.ReadWrite.All']);
const graphFields = ['id', 'displayName', 'givenName', 'surname', 'mail', 'userPrincipalName'];
const graphUser = user => ({ id: user.oid, displayName: user.name, givenName: user.given_name,
  surname: user.family_name, mail: user.email, userPrincipalName: user.preferred_username });

// Add the missing public list route over the same native users as /me and
// /users/:id. No parallel identity store or source-dependent response exists.
export function extendMicrosoftUsers(upstream) {
  return { ...upstream, register(app, store, ...args) {
    app.get('/v1.0/users', c => {
      const actor = c.get('authUser');
      if (!actor) return graphError(c, 401, 'InvalidAuthenticationToken', 'Authentication required.');
      if (!actor.scopes?.some(scope => directoryScopes.has(scope))) return graphError(c, 403, 'Authorization_RequestDenied', 'Directory read permission is required.');
      const url = new URL(c.req.url), query = url.searchParams;
      for (const key of query.keys()) if (!['$top', '$select', '$skiptoken'].includes(key)) return graphError(c, 400, 'Request_UnsupportedQuery', `Unsupported query option: ${key}`);
      const top = query.get('$top') ?? '100';
      if (!/^[1-9]\d*$/.test(top) || Number(top) > 999) return graphError(c, 400, 'Request_BadRequest', '$top must be an integer from 1 to 999.');
      const fields = query.has('$select') ? query.get('$select').split(',').map(field => field.trim()) : graphFields;
      if (!fields.length || fields.some(field => !graphFields.includes(field))) return graphError(c, 400, 'Request_UnsupportedQuery', 'Unsupported user field in $select.');
      const users = getMicrosoftStore(store).users.all().sort((a, b) => a.oid.localeCompare(b.oid));
      let offset = 0;
      if (query.has('$skiptoken')) {
        try {
          const cursor = query.get('$skiptoken');
          const id = Buffer.from(cursor, 'base64url').toString('utf8');
          if (!cursor || Buffer.from(id).toString('base64url') !== cursor) throw new Error('invalid cursor');
          const previous = users.findIndex(user => user.oid === id);
          if (previous < 0) throw new Error('unknown cursor');
          offset = previous + 1;
        } catch { return graphError(c, 400, 'Request_BadRequest', 'Invalid paging token.'); }
      }
      const page = users.slice(offset, offset + Number(top));
      const body = { '@odata.context': `${url.origin}/v1.0/$metadata#users`,
        value: page.map(user => Object.fromEntries(Object.entries(graphUser(user)).filter(([key]) => fields.includes(key)))) };
      if (offset + page.length < users.length) {
        url.searchParams.set('$skiptoken', Buffer.from(page.at(-1).oid).toString('base64url'));
        body['@odata.nextLink'] = url.href;
      }
      return c.json(body);
    });
    upstream.register(app, store, ...args);
  } };
}

// Keep native authentication, filtering, ordering and offset pagination. The
// Clerk users route returns an array; organization lists retain their envelope.
export function extendClerkUsers(upstream) {
  return { ...upstream, register(app, store, ...args) {
    app.use('/v1/users', async (c, next) => {
      if (c.req.method !== 'GET' || c.req.path !== '/v1/users') return next();
      const json = c.json;
      c.json = function(value, ...options) {
        return json.call(this, value && Array.isArray(value.data) && Number.isInteger(value.total_count) ? value.data : value, ...options);
      };
      try { await next(); } finally { c.json = json; }
    });
    upstream.register(app, store, ...args);
  } };
}
