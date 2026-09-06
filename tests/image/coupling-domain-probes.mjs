import {createHash} from 'node:crypto';

const own = (value, key) => Object.hasOwn(value ?? {}, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const sorted = rows => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const writable = new Set(['commerce.products', 'commerce.orders', 'social.posts', 'social.reviews', 'social.comments', 'work.projects', 'work.tasks', 'work.time_entries', 'support.cases']);
const fields = {
  identity: ['organizations', 'people'], communication: ['channels', 'mail', 'documents', 'calendars', 'calendar_events'],
  software: ['repositories'], finance: ['customers', 'suppliers', 'invoices', 'bills', 'payments', 'refunds', 'ledger_entries'],
  commerce: ['products', 'orders'], social: ['posts', 'reviews', 'comments'], work: ['projects', 'tasks', 'time_entries'], support: ['cases'],
};
// These arrays configure other APIs. They are not canonical domain records.
const configuration = new Set(['communication.bots', 'communication.mailboxes', 'software.operator_ids', 'software.operator_teams', 'software.queues', 'software.service_roles']);
const derivedFinance = new Set(['invoices', 'bills', 'payments', 'refunds', 'ledger_entries']);

/** Expectations come from the canonical world, never from a projection. */
export function sourceDomainCollections(world) {
  const collections = {};
  for (const [section, names] of Object.entries(fields)) {
    const source = section === 'identity' ? world : world[section] ?? {};
    const candidates = new Set([...names, ...Object.keys(source).filter(key => Array.isArray(source[key]) && section !== 'identity'), ...(section === 'finance' ? Object.keys(source.resolved ?? {}).filter(key => Array.isArray(source.resolved[key])) : [])]);
    for (const field of candidates) {
      const name = `${section}.${field}`;
      if (configuration.has(name) || field === 'resolved_mail' || field === 'anchor_invoices') continue;
      let records = source[field], path = section === 'identity' ? field : name;
      if (section === 'finance' && (derivedFinance.has(field) || Array.isArray(source.resolved?.[field])) && own(source.resolved, field)) {
        records = source.resolved[field]; path = `finance.resolved.${field}`;
      } else if (name === 'finance.invoices' && own(source, 'anchor_invoices')) {
        records = source.anchor_invoices; path = 'finance.anchor_invoices';
      } else if (name === 'communication.mail' && own(source, 'resolved_mail')) {
        records = source.resolved_mail; path = 'communication.resolved_mail';
      }
      if (records !== undefined) collections[name] = {records, path};
    }
  }
  return collections;
}

export function nestedDomainPaths(records, root) {
  const paths = new Set([root]);
  function visit(value, path) {
    if (Array.isArray(value)) { paths.add(path); for (const row of value) visit(row, `${path}[]`); }
    else if (object(value)) for (const [key, row] of Object.entries(value)) visit(row, `${path}.${key}`);
  }
  visit(records, root); return [...paths].sort();
}

export async function domainPages(read, {identity = 'id'} = {}) {
  const rows = [], cursors = new Set(), identities = new Set();
  let cursor, count;
  for (let pages = 0; pages < 10000; pages++) {
    const body = await read(cursor);
    if (!Array.isArray(body.data) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || typeof body.has_more !== 'boolean') throw new Error('Domain list omitted its complete pagination contract');
    if (count !== undefined && count !== body.total_count) throw new Error('Domain total_count changed during pagination');
    count = body.total_count;
    for (const row of body.data) {
      if (typeof row?.[identity] !== 'string' || !row[identity] || identities.has(row[identity])) throw new Error('Domain list has a missing or repeated record identity');
      identities.add(row[identity]); rows.push(row);
    }
    if (!body.has_more) {
      if (body.next_cursor !== null || rows.length !== count) throw new Error('Domain final page does not match total_count or next_cursor');
      return rows;
    }
    if (!body.data.length || typeof body.next_cursor !== 'string' || !body.next_cursor || cursors.has(body.next_cursor)) throw new Error('Domain continuation is missing, empty or repeated');
    cursors.add(body.next_cursor); cursor = body.next_cursor;
  }
  throw new Error('Domain pagination exceeded the safety bound');
}

export async function probeDomainWorld({artifact, bindings, fetchImpl = fetch}) {
  const checks = [], responses = [], coverage = [];
  const expected = sourceDomainCollections(artifact.world), projection = artifact.projections?.domain;
  const world = {id: artifact.world.id, version: artifact.world.version, artifact_sha256: artifact.identity?.digest ?? artifact.manifest?.artifact_sha256};
  const redact = value => typeof value === 'string' ? (bindings.DOMAIN_TOKEN ? value.replaceAll(bindings.DOMAIN_TOKEN, '[redacted]') : value)
    : Array.isArray(value) ? value.map(redact) : object(value) ? Object.fromEntries(Object.entries(value).map(([key, row]) => [key, /secret|token|password|authorization/i.test(key) ? '[redacted]' : redact(row)])) : value;
  const add = (check, passed, detail = {}) => checks.push({check: `domain.${check}`, status: passed ? 'passed' : 'failed', ...redact(detail)});
  const compare = (name, wanted, actual) => add(name, equal(wanted, actual), {expected: wanted, actual, failure_kind: 'assertion'});
  const recordsEqual = (name, wanted, actual) => add(name, equal(wanted, actual), {expected: {sha256: hash(wanted)}, actual: {sha256: hash(actual)}, failure_kind: 'assertion', detail: 'Compared every canonical record field, including nested values and array order.'});
  const run = async (name, action) => { try { const value = await action(); add(name, true); return value; } catch (error) { add(name, false, {failure_kind: 'assertion', detail: error.message}); return null; } };
  if (!Object.keys(expected).length && !projection && !bindings.DOMAIN_BASE_URL) return {checks, responses, coverage};
  compare('projection.identity', {api_version: 'worldfixture.domain/v1', world: {id: world.id, version: world.version}}, {api_version: projection?.api_version, world: projection?.world});
  compare('projection.collections', Object.keys(expected).sort(), Object.keys(projection?.collections ?? {}).sort());
  for (const name of Object.keys(projection?.collections ?? {})) if (!expected[name]) add(`reader.${name}`, false, {failure_kind: 'reader_gap', detail: 'Projected collection has no independently derived canonical source collection.'});
  const configured = !!bindings.DOMAIN_BASE_URL && !!bindings.DOMAIN_TOKEN && typeof world.artifact_sha256 === 'string';
  add('provider.configuration', configured, {detail: 'A domain binding, current run credential, and selected artifact digest are required.'});
  async function request(path) {
    const response = await fetchImpl(`${bindings.DOMAIN_BASE_URL.replace(/\/$/, '')}${path}`, {method: 'GET', headers: {authorization: `Bearer ${bindings.DOMAIN_TOKEN}`}, signal: AbortSignal.timeout(30000)});
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    responses.push({provider: 'domain', path, status: response.status, body: redact(body)});
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    if (!object(body) || body.error) throw new Error(`${path} returned an invalid domain response`);
    if (!equal(body.world, world)) throw new Error(`${path} returned a different world identity or artifact provenance`);
    return body;
  }
  const page = (path, identity) => domainPages(cursor => request(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), {identity});
  const ready = configured ? await run('api.ready', async () => { const result = await request('/readyz'); if (result.ready !== true) throw new Error('Domain service is not ready'); return result; }) : null;
  const metadata = configured ? await run('api.metadata.read', () => page('/v1/collections', 'name')) : null;
  if (metadata) compare('api.metadata.names', Object.keys(expected).sort(), metadata.map(row => row.name).sort());
  for (const [name, {records, path}] of Object.entries(expected)) {
    const start = checks.length, base = `/v1/collections/${encodeURIComponent(name)}`;
    const valid = Array.isArray(records) && records.every(row => object(row) && typeof row.id === 'string' && row.id) && new Set(records.map(row => row.id)).size === records.length;
    add(`source.${name}.identities`, valid, {failure_kind: 'assertion'});
    const wanted = valid ? sorted(records) : [];
    const authored = name === 'communication.mail' && path !== name ? artifact.world.communication?.mail
      : name === 'finance.invoices' && path !== 'finance.anchor_invoices' ? artifact.world.finance?.anchor_invoices
        : name.startsWith('finance.') && path.startsWith('finance.resolved.') ? artifact.world.finance?.[name.split('.')[1]] : null;
    if (Array.isArray(authored) && valid) for (const row of authored) {
      const resolved = records.find(item => item.id === row.id);
      recordsEqual(`source.${name}.${row.id}.resolved-completeness`, row, resolved ? Object.fromEntries(Object.keys(row).map(key => [key, resolved[key]])) : null);
    }
    recordsEqual(`projection.${name}.records`, wanted, Array.isArray(projection?.collections?.[name]) ? sorted(projection.collections[name]) : null);
    const isWritable = writable.has(name);
    const meta = metadata?.find(row => row.name === name);
    compare(`api.${name}.metadata`, {name, count: wanted.length, writable: isWritable, id_field: 'id', owner: isWritable ? 'domain' : 'seed-view', write_scope: isWritable ? 'domain-only' : 'read-only', provider_sync: false}, meta ?? null);
    const live = configured ? await run(`api.${name}.read`, () => page(base, 'id')) : null;
    if (live) recordsEqual(`api.${name}.records`, wanted, live);
    if (configured && valid) for (const record of records) {
      const detail = await run(`api.${name}.${record.id}.detail`, () => request(`${base}/${encodeURIComponent(record.id)}`));
      if (detail) {
        recordsEqual(`api.${name}.${record.id}.fields`, record, detail.record);
        add(`api.${name}.${record.id}.version`, Number.isSafeInteger(detail.version) && detail.version >= 1, {failure_kind: 'assertion', actual: detail.version});
      }
    }
    const passed = !!ready && !!metadata && !!live && checks.slice(start).every(row => row.status === 'passed');
    const aliases = [path];
    if (name.startsWith('identity.')) aliases.push(name);
    if (name === 'communication.mail' && path !== name && Array.isArray(artifact.world.communication?.mail)) aliases.push(name);
    if (name === 'finance.invoices' && path !== 'finance.anchor_invoices' && Array.isArray(artifact.world.finance?.anchor_invoices)) aliases.push('finance.anchor_invoices');
    for (const alias of aliases) for (const collection of nestedDomainPaths(records, alias)) coverage.push({collection, provider: 'domain', path: base, status: passed ? 'passed' : 'failed', detail: 'Complete metadata, list and detail API reads compared against full canonical world records, with selected artifact provenance. Domain state is separate from provider state.'});
  }
  return {checks, responses, coverage};
}
