// Read only public provider APIs. Failed later pages retain observed records;
// only a proved end of a collection permits a total in the Workbench.
const statusOf = ({ status, error }) => ({ status, ...(error ? { error } : {}) });
const failed = (error, rows = []) => ({ rows, status: 'failed', error: error.message ?? String(error) });
const complete = rows => ({ rows, status: 'complete' });
const combined = entries => {
  const failures = entries.filter(entry => entry.status !== 'complete');
  return failures.length ? { status: 'failed', error: failures.map(entry => entry.error ?? 'Parent collection is incomplete').join('; ') } : { status: 'complete' };
};
const overview = entries => ({ ...Object.fromEntries(entries.map(([key, result]) => [key, result.rows])),
  collectionStatus: Object.fromEntries(entries.map(([key, result]) => [key, statusOf(result)])) });
function append(rows, seen, page, identity = row => row.id, allowOverlap = false) {
  const pageIds = new Set();
  for (const row of page) {
    const id = identity(row);
    if (!id || pageIds.has(id) || (!allowOverlap && seen.has(id))) throw new Error('Missing or repeated record ID');
    pageIds.add(id);
    if (!seen.has(id)) { seen.add(id); rows.push(row); }
  }
}
function queryPath(path, params) {
  const url = new URL(path, 'http://provider.invalid');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

export async function readProductCollection(read, path, { mode, key, identity } = {}) {
  const rows = [], seen = new Set();
  let cursor, offset = 0, total;
  try {
    for (let page = 0; page < 1000; page++) {
      const params = mode === 'okta' ? { page: page + 1, per_page: 100 }
        : mode === 'clerk' ? { limit: 100, offset }
        : mode === 'vercel' ? { limit: 100, ...(cursor !== undefined ? { until: cursor } : {}) }
        : mode === 'twilio' ? { PageSize: 100, Page: page } : {};
      const value = await read(queryPath(path, params));
      const batch = mode === 'okta' ? value : value?.[key ?? 'data'];
      if (!Array.isArray(batch)) throw new Error('Provider response has no record array');
      const before = rows.length;
      // Vercel's pinned cursor is inclusive: its boundary record can recur.
      append(rows, seen, batch, identity, mode === 'vercel');
      if (mode === 'okta') { if (batch.length < 100) return complete(rows); }
      else if (mode === 'clerk') {
        if (!Number.isSafeInteger(value.total_count) || value.total_count < 0 || typeof value.has_more !== 'boolean') throw new Error('Incomplete Clerk pagination metadata');
        if (total !== undefined && total !== value.total_count) throw new Error('Clerk total changed during pagination');
        total = value.total_count;
        if (!value.has_more) {
          if (rows.length !== total) throw new Error('Clerk total does not match returned records');
          return complete(rows);
        }
        if (!batch.length || rows.length >= total) throw new Error('Invalid Clerk next page');
        offset += batch.length;
      } else if (mode === 'vercel') {
        if (!value.pagination || value.pagination.count !== batch.length || !Object.hasOwn(value.pagination, 'next')) throw new Error('Incomplete Vercel pagination metadata');
        const next = value.pagination.next;
        if (next === null) return complete(rows);
        if (!Number.isFinite(next) || !batch.length || rows.length === before || next === cursor) throw new Error('Vercel cursor cannot advance; collection is incomplete');
        cursor = next;
      } else if (mode === 'twilio') {
        if (value.page !== page || !Object.hasOwn(value, 'next_page_uri')) throw new Error('Incomplete Twilio pagination metadata');
        if (value.next_page_uri === null) return complete(rows);
        // Keep the selected service prefix. Pinned Twilio next_page_uri uses
        // /v1/Services and /v2/Services without /messaging or /verify.
        const next = new URL(value.next_page_uri, 'http://provider.invalid');
        if (next.origin !== 'http://provider.invalid' || Number(next.searchParams.get('Page')) !== page + 1 || !batch.length) throw new Error('Invalid Twilio next page');
      } else if (mode === 'resend') {
        if (value.object !== 'list' || (Object.hasOwn(value, 'has_more') && value.has_more !== false)) throw new Error('Incomplete Resend list');
        return complete(rows); // Pinned Resend list routes return all rows.
      } else if (mode === 'atlas') {
        if (value.totalCount !== rows.length) throw new Error('Atlas totalCount does not match returned records');
        return complete(rows); // Pinned Atlas admin routes have no page limit.
      } else throw new Error('Unknown provider list contract');
    }
    throw new Error('Provider exceeded the pagination limit');
  } catch (error) { return failed(new Error(`${path}: ${error.message}`), rows); }
}

async function flatOverview(read, specs, mode) {
  return overview(await Promise.all(Object.entries(specs).map(async ([key, path]) => [key, await readProductCollection(read, path, { mode })])));
}
export const readOktaOverview = read => flatOverview(read, { users: '/api/v1/users', groups: '/api/v1/groups', applications: '/api/v1/apps' }, 'okta');
export const readClerkOverview = read => flatOverview(read, { users: '/v1/users', organizations: '/v1/organizations', sessions: '/v1/sessions' }, 'clerk');

export async function readVercelOverview(read) {
  const readList = (path, key) => readProductCollection(read, path, { mode: 'vercel', key, identity: key === 'deployments' ? row => row.uid : undefined });
  const teams = await readList('/v2/teams', 'teams');
  const scopes = [null, ...teams.rows.map(row => row.id)]; // Personal account plus every visible team.
  const entries = await Promise.all(['projects', 'deployments'].map(async key => {
    const results = await Promise.all(scopes.map(team => readList(queryPath(key === 'projects' ? '/v10/projects' : '/v6/deployments', team ? { teamId: team } : {}), key)));
    const rows = [], seen = new Set();
    try { for (const result of results) append(rows, seen, result.rows, key === 'deployments' ? row => row.uid : undefined); }
    catch (error) { return [key, failed(error, rows)]; }
    return [key, { rows, ...combined([teams, ...results]) }];
  }));
  return overview([['teams', teams], ...entries]);
}

export async function readResendOverview(read) {
  const result = await flatOverview(read, { emails: '/emails', domains: '/domains', audiences: '/audiences' }, 'resend');
  const groups = await Promise.all(result.audiences.map(async audience => {
    const contacts = await readProductCollection(read, `/audiences/${encodeURIComponent(audience.id)}/contacts`, { mode: 'resend' });
    return { audience, contacts: contacts.rows, collectionStatus: { contacts: statusOf(contacts) } };
  }));
  return { ...result, contactGroups: groups, collectionStatus: { ...result.collectionStatus,
    contactGroups: combined([result.collectionStatus.audiences, ...groups.map(group => group.collectionStatus.contacts)]) } };
}

export async function readMongoAtlasOverview(read) {
  const readList = (path, identity) => readProductCollection(read, path, { mode: 'atlas', key: 'results', identity });
  const projects = await readList('/api/atlas/v2/groups');
  const details = await Promise.all(projects.rows.map(async project => {
    const base = `/api/atlas/v2/groups/${encodeURIComponent(project.id)}`;
    const [clusters, users] = await Promise.all([readList(`${base}/clusters`), readList(`${base}/databaseUsers`, row => row.username)]);
    const dbGroups = await Promise.all(clusters.rows.map(async cluster => {
      const dbPath = `${base}/clusters/${encodeURIComponent(cluster.name)}/databases`;
      const databases = await readList(dbPath, row => row.databaseName);
      const rows = await Promise.all(databases.rows.map(async database => {
        const collections = await readList(`${dbPath}/${encodeURIComponent(database.databaseName)}/collections`, row => row.collectionName);
        return { ...database, name: database.databaseName, cluster: cluster.name, groupId: project.id,
          collections: collections.rows.map(row => row.collectionName), collectionStatus: { collections: statusOf(collections) } };
      }));
      return { rows, status: statusOf(databases) };
    }));
    const databases = dbGroups.flatMap(group => group.rows);
    return { project, clusters: clusters.rows, databaseUsers: users.rows, databases,
      collectionStatus: { clusters: statusOf(clusters), databaseUsers: statusOf(users),
        databases: combined([clusters, ...dbGroups.map(group => group.status)]),
        collections: combined([clusters, ...dbGroups.map(group => group.status), ...databases.map(db => db.collectionStatus.collections)]) } };
  }));
  const collectionStatus = { projects: statusOf(projects) };
  for (const key of ['clusters', 'databaseUsers', 'databases', 'collections']) collectionStatus[key] = combined([projects, ...details.map(detail => detail.collectionStatus[key])]);
  return { projects: projects.rows, projectDetails: details,
    // Expose the same observed records at the top level for checked totals.
    clusters: details.flatMap(row => row.clusters), databaseUsers: details.flatMap(row => row.databaseUsers),
    databases: details.flatMap(row => row.databases), collectionStatus };
}

export async function readTwilioOverview(read, { accountSid }) {
  const base = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
  let account = null, accountStatus;
  try {
    account = await read(`${base}.json`);
    if (account?.sid !== accountSid) throw new Error('Twilio account ID does not match the selected account');
    accountStatus = { status: 'complete' };
  } catch (error) { accountStatus = statusOf(failed(error)); }
  const specs = { phone_numbers: [`${base}/IncomingPhoneNumbers.json`, 'incoming_phone_numbers'], messaging_services: ['/messaging/v1/Services', 'services'], verify_services: ['/verify/v2/Services', 'services'] };
  const result = overview(await Promise.all(Object.entries(specs).map(async ([key, [path, arrayKey]]) => [key,
    await readProductCollection(read, path, { mode: 'twilio', key: arrayKey, identity: row => row.sid })])));
  return { ...result, account, collectionStatus: { ...result.collectionStatus, account: accountStatus } };
}
