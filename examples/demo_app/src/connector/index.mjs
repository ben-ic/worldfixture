import { createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = '/__worldfixture/';
const LIMIT = 8 * 1024 * 1024;
const SOURCES = {
  'identity.organizations': { type: 'organization', label: 'name' },
  'identity.people': { type: 'person', label: 'name' },
  'work.projects': { type: 'project', label: 'name' },
  'work.tasks': { type: 'task', label: 'title' },
  'support.cases': { type: 'case', label: 'title' },
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const response = (status, body) => ({ status, body });
const failure = (status, code, message) => response(status, { error: { code, message } });

function authorized(header, token) {
  if (typeof header !== 'string') return false;
  return timingSafeEqual(Buffer.from(hash(header)), Buffer.from(hash(`Bearer ${token}`)));
}

function validateEnvelope(input, world, seed) {
  if (!object(input) || input.api_version !== 'worldfixture.connector-request/v1'
    || !text(input.request_id) || !object(input.world) || !object(input.packs) || !object(input.options)) {
    return 'Expected a Connector v1 request with request_id, world, packs, and options.';
  }
  if (input.world.synthetic !== true || !text(input.world.id) || !text(input.world.version)
    || !/^[a-f0-9]{64}$/.test(input.world.artifact_sha256 || '')) return 'A synthetic world identity and SHA-256 artifact hash are required.';
  if (world.id && world.id !== 'unbound' && input.world.id !== world.id) return 'The request world does not match this app session.';
  if (world.version && world.version !== 'unknown' && input.world.version !== world.version) return 'The request world version does not match this app session.';
  if (seed && (!text(input.idempotency_key) || input.idempotency_key.length > 400)) return 'Seed requires an idempotency_key of 1 to 400 characters.';
  if (input.options.mode !== (seed ? 'apply' : 'preview')) return `options.mode must be ${seed ? 'apply' : 'preview'}.`;
  for (const [pack, collections] of Object.entries(input.packs)) {
    if (!object(collections)) return `Pack ${pack} must be an object.`;
    for (const [collection, records] of Object.entries(collections)) {
      if (!SOURCES[`${pack}.${collection}`]) continue;
      if (!Array.isArray(records)) return `${pack}.${collection} must be an array.`;
      const ids = new Set();
      for (const record of records) {
        if (!object(record) || !/^[a-z][a-z0-9.-]*$/.test(record.id || '') || record.id.length > 300) return `${pack}.${collection} contains an invalid record ID.`;
        if (ids.has(record.id)) return `${pack}.${collection} contains a duplicate record ID.`;
        ids.add(record.id);
      }
    }
  }
  return null;
}

function mapRequest(input) {
  const mappings = [];
  const records = [];
  const counts = {};
  for (const [pack, collections] of Object.entries(input.packs)) {
    for (const [collection, items] of Object.entries(collections)) {
      const source = `${pack}.${collection}`;
      const spec = SOURCES[source];
      if (!spec) {
        mappings.push({ source, target: '', status: 'skipped', reason: 'Provider data is read through provider APIs. This collection has no app reference mapping.' });
        continue;
      }
      mappings.push({ source, target: 'AccountDeskReference', status: 'partial', reason: 'Imports names, identity fields, and relationship IDs only. Does not copy provider records or send provider requests.' });
      counts[collection] = items.length;
      for (const item of items) {
        const ref = `${spec.type}/${item.id}`;
        const relations = {};
        for (const [key, value] of Object.entries(item)) {
          if (key !== 'id' && (key.endsWith('_id') || key.endsWith('_ids')) && (typeof value === 'string' || Array.isArray(value))) relations[key] = value;
        }
        const identities = {};
        for (const key of ['email', 'slack_id', 'github_login']) if (typeof item[key] === 'string') identities[key] = item[key];
        records.push({ id: ref, worldfixture_ref: ref, application_ref: `account-desk:${ref}`, source, source_id: item.id,
          label: String(item[spec.label] || item.id), identities, relations, importedBy: 'connector-v1' });
      }
    }
  }
  const warnings = ['Only app reference mappings are imported. Provider data stays in the world services.'];
  let summary = `Map ${records.length} records to app references. No provider writes.`;
  if (input.options.scale?.complete === false) {
    const collections = input.options.scale.collections;
    summary += ' This request is a partial world slice.';
    if (Array.isArray(collections)) {
      for (const item of collections) if (text(item.collection) && Number.isInteger(item.sent) && Number.isInteger(item.available)) warnings.push(`${item.collection}: ${item.sent} of ${item.available} records supplied.`);
    }
  }
  return { records, plan: { api_version: 'worldfixture.connector-plan/v1', summary, mappings, counts, warnings } };
}

function validateEvent(input) {
  if (!object(input) || input.api_version !== 'worldfixture.application-event/v1'
    || !text(input.delivery_id) || !text(input.event_id) || input.event_id.length > 400
    || !/^[a-z][a-z0-9.-]+\.v[0-9]+$/.test(input.kind || '')
    || !text(input.occurred_at) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.occurred_at)
    || !Number.isFinite(Date.parse(input.occurred_at)) || !object(input.data)) return 'Expected a valid Connector v1 application event.';
  for (const key of ['actor', 'subject']) {
    if (input[key] !== undefined && (!object(input[key]) || !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9.-]+$/.test(input[key].worldfixture_ref || ''))) return `Invalid ${key} reference.`;
  }
  return null;
}

/** Local, opt-in app reference import and event inbox. No provider mutations. */
export function createConnector({ store, token, world = {}, enabled = false, nodeEnv = process.env.NODE_ENV }) {
  const identity = typeof world === 'string' ? { id: world } : world;
  const active = enabled === true && nodeEnv !== 'production' && text(token);
  return {
    enabled: active,
    async handle({ method, path, authorization, input }) {
      if (path !== '/.well-known/worldfixture' && !path.startsWith(PREFIX)) return null;
      if (!active) return failure(404, 'connector_disabled', 'The local application connector is disabled.');
      if (path === '/.well-known/worldfixture') {
        if (method !== 'GET') return failure(405, 'method_not_allowed', 'Use GET for discovery.');
        return response(200, { api_version: 'worldfixture.connector/v1', application: { id: 'account-desk', name: 'Account Desk' },
          capabilities: { plan: true, seed: true, event: true, status: true, reset: false }, accepts: ['identity', 'work', 'support'] });
      }
      if (!authorized(authorization, token)) return failure(401, 'unauthorized', 'A valid local connector token is required.');
      if (path === `${PREFIX}reset`) return failure(409, 'reset_not_supported', 'App records are preserved. The connector does not reset an app-owned database.');
      if (path === `${PREFIX}status`) {
        if (method !== 'GET') return failure(405, 'method_not_allowed', 'Use GET for status.');
        const saved = await store.get('mappings', '__connector_status');
        const receipts = (await store.list('receipts')).filter((item) => item.connector === true).slice(-20).map((item) => item.receipt);
        return response(200, { api_version: 'worldfixture.connector-status/v1', state: saved?.state || 'empty',
          ...(saved?.artifact_sha256 ? { artifact_sha256: saved.artifact_sha256 } : {}), receipts });
      }
      if (![`${PREFIX}plan`, `${PREFIX}seed`, `${PREFIX}events`].includes(path)) return failure(404, 'not_found', 'Unknown connector endpoint.');
      if (method !== 'POST') return failure(405, 'method_not_allowed', 'Use POST for this operation.');
      if (Buffer.byteLength(JSON.stringify(input) || '') > LIMIT) return failure(413, 'request_too_large', 'Connector requests must not exceed 8 MiB.');
      if (path === `${PREFIX}plan` || path === `${PREFIX}seed`) {
        const seed = path === `${PREFIX}seed`;
        const invalid = validateEnvelope(input, identity, seed);
        if (invalid) return failure(400, 'mapping_invalid', invalid);
        const { plan, records } = mapRequest(input);
        if (!seed) return response(200, plan);
        return store.transaction(async (tx) => {
          const key = `connector:seed:${hash(input.idempotency_key)}`;
          const prior = await tx.get('receipts', key);
          if (prior) return response(200, { ...prior.receipt, status: 'already_applied' });
          const references = [];
          for (const record of records) {
            await tx.put('mappings', record.id, record);
            references.push({ worldfixture_ref: record.worldfixture_ref, application_ref: record.application_ref });
          }
          const receipt = { api_version: 'worldfixture.connector-receipt/v1', status: 'applied', idempotency_key: input.idempotency_key,
            summary: plan.summary, counts: plan.counts, references, warnings: plan.warnings };
          await tx.put('receipts', key, { id: key, connector: true, receipt });
          await tx.put('mappings', '__connector_status', { id: '__connector_status', state: 'seeded', artifact_sha256: input.world.artifact_sha256 });
          return response(200, receipt);
        });
      }
      const invalid = validateEvent(input);
      if (invalid) return failure(400, 'event_invalid', invalid);
      return store.transaction(async (tx) => {
        const key = `connector:event:${hash(input.event_id)}`;
        const prior = await tx.get('receipts', key);
        if (prior) return response(200, { ...prior.receipt, status: 'already_applied' });
        const references = [];
        for (const property of ['actor', 'subject']) {
          if (!input[property]) continue;
          const mapped = await tx.get('mappings', input[property].worldfixture_ref);
          if (!mapped) return failure(422, 'mapping_missing', `The event ${property} has no app reference. Seed the required records first.`);
          references.push({ worldfixture_ref: mapped.worldfixture_ref, application_ref: mapped.application_ref });
        }
        await tx.put('events', input.event_id, { ...input, id: input.event_id, source: 'connector', received_at: new Date().toISOString() });
        const receipt = { api_version: 'worldfixture.connector-receipt/v1', status: 'applied', event_id: input.event_id,
          summary: 'Stored one app inbox event for review. No provider writes.', counts: { events: 1 }, references, warnings: [] };
        await tx.put('receipts', key, { id: key, connector: true, receipt });
        const status = await tx.get('mappings', '__connector_status');
        await tx.put('mappings', '__connector_status', { ...status, id: '__connector_status', state: 'changed' });
        return response(200, receipt);
      });
    },
  };
}
