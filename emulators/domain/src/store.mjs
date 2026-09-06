import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DomainError, referenceEdges, validateEnvelope, validateRecord, WRITABLE_COLLECTIONS} from './validation.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new DomainError(500, code, message); };

export function loadDomainProjection(worldPath, expectedDigest) {
  if (!worldPath) fail('world_path_required', 'WORLDFIXTURE_WORLD_PATH is required; the domain service has no default world');
  let root, manifest;
  try { root = realpathSync(worldPath); manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); }
  catch { fail('invalid_world_artifact', `Cannot read a world artifact manifest at ${worldPath}`); }
  const identity = `${manifest.world_id}:${manifest.world_version}`;
  if (manifest.api_version !== 'worldfixture.world-artifact/v1' || !plain(manifest.files) || !manifest.world_id || !manifest.world_version) fail('invalid_world_artifact', 'The domain service requires a versioned world artifact manifest');
  if (sha(`${JSON.stringify(canonical(manifest.files))}\n`) !== manifest.artifact_sha256) fail('artifact_digest_mismatch', `World ${identity} has an invalid artifact digest`);
  if (expectedDigest && expectedDigest !== manifest.artifact_sha256) fail('artifact_digest_mismatch', `World ${identity} does not match WORLDFIXTURE_WORLD_SHA256`);
  let projection;
  for (const [name, expected] of Object.entries(manifest.files)) {
    let path, bytes;
    try {
      path = realpathSync(resolve(root, name));
      if (relative(root, path).startsWith(`..${sep}`) || relative(root, path) === '..' || path === root) fail('invalid_world_artifact', `World ${identity} has an unsafe manifest path`);
      bytes = readFileSync(path);
    } catch (error) { if (error instanceof DomainError) throw error; fail('artifact_file_missing', `World ${identity} is missing ${name}`); }
    if (bytes.length !== expected.size || sha(bytes) !== expected.sha256) fail('artifact_file_mismatch', `World ${identity} has changed artifact file ${name}`);
    if (name === 'projections/domain.json') { try { projection = JSON.parse(bytes); } catch { fail('invalid_domain_projection', `World ${identity} has invalid projections/domain.json`); } }
  }
  if (!projection) fail('domain_projection_required', `World ${identity} has no projections/domain.json; select a world with domain records`);
  if (projection.api_version !== 'worldfixture.domain/v1' || !plain(projection.collections) || projection.world?.id !== manifest.world_id || projection.world?.version !== manifest.world_version) fail('invalid_domain_projection', `World ${identity} has an invalid domain projection identity or collections map`);
  for (const [name, rows] of Object.entries(projection.collections)) {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(name) || !Array.isArray(rows)) fail('invalid_domain_projection', `World ${identity} has invalid collection ${name}`);
    const ids = new Set();
    for (const row of rows) {
      if (!plain(row) || typeof row.id !== 'string' || !row.id || ids.has(row.id)) fail('invalid_domain_projection', `World ${identity} collection ${name} has a missing or duplicate record ID`);
      ids.add(row.id);
    }
  }
  return {projection, world: {id: manifest.world_id, version: manifest.world_version, artifact_sha256: manifest.artifact_sha256}};
}

export function openDomainStore({worldPath, statePath, token, expectedDigest, now = () => new Date().toISOString()}) {
  if (typeof token !== 'string' || !token) fail('domain_token_required', 'DOMAIN_TOKEN must be generated and supplied explicitly');
  if (!statePath) fail('state_path_required', 'WORLDFIXTURE_STATE_PATH is required for persistent domain state');
  const {projection, world} = loadDomainProjection(worldPath, expectedDigest);
  const stateDirectory = join(resolve(statePath), 'domain'), databasePath = join(stateDirectory, 'state.sqlite');
  for (const path of [stateDirectory, databasePath]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('invalid_domain_state', 'Domain state paths cannot be symbolic links');
  if (existsSync(databasePath)) {
    const previous = new DatabaseSync(databasePath, {readOnly: true});
    try {
      const meta = Object.fromEntries(previous.prepare('SELECT key,value FROM metadata').all().map(row => [row.key, row.value]));
      if (meta.artifact_sha256 !== world.artifact_sha256 || meta.world_id !== world.id || meta.world_version !== world.version || meta.schema_version !== '1') fail('state_artifact_mismatch', `Domain state belongs to a different artifact or schema; world ${world.id}:${world.version} requires a separate state directory`);
    } catch (error) { if (error instanceof DomainError) throw error; fail('invalid_domain_state', 'Existing domain state cannot be identified; refusing to overwrite it'); }
    finally { previous.close(); }
  }
  mkdirSync(stateDirectory, {recursive: true, mode: 0o700});
  const db = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS collections(name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL REFERENCES collections(name),id TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(collection,id)); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,body TEXT NOT NULL);');
  if (!db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const metadata = {schema_version: '1', world_id: world.id, world_version: world.version, artifact_sha256: world.artifact_sha256, revision: '0'};
      for (const [key, value] of Object.entries(metadata)) db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(key, value);
      for (const [name, rows] of Object.entries(projection.collections)) {
        db.prepare('INSERT INTO collections(name) VALUES (?)').run(name);
        for (const row of rows) db.prepare('INSERT INTO records(collection,id,body,version) VALUES (?,?,?,1)').run(name, row.id, JSON.stringify(row));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  const revision = () => Number(db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value);
  const checkCollection = name => { if (!db.prepare('SELECT 1 FROM collections WHERE name=?').get(name)) throw new DomainError(404, 'collection_not_found', `Collection ${name} is not declared by this world`); };
  const getVersioned = (name, id) => { const row = db.prepare('SELECT body,version FROM records WHERE collection=? AND id=?').get(name, id); return row ? {record: JSON.parse(row.body), version: row.version} : null; };
  const get = (name, id) => typeof id === 'string' ? getVersioned(name, id)?.record ?? null : null;
  const signature = body => createHmac('sha256', token).update(body).digest('base64url');
  const encodeCursor = (scope, after) => { const body = Buffer.from(JSON.stringify({v: 1, scope, after, revision: revision(), artifact: world.artifact_sha256})).toString('base64url'); return `${body}.${signature(body)}`; };
  const decodeCursor = (cursor, scope) => {
    if (!cursor) return null;
    try {
      if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error();
      const [body, signed, extra] = cursor.split('.');
      const expected = signature(body), a = Buffer.from(signed ?? ''), b = Buffer.from(expected);
      if (extra || a.length !== b.length || !timingSafeEqual(a, b)) throw new Error();
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (value.v !== 1 || value.scope !== scope || value.artifact !== world.artifact_sha256 || typeof value.after !== 'string') throw new Error();
      if (scope !== 'events' && value.revision !== revision()) throw new DomainError(409, 'stale_cursor', 'Domain data changed; restart this collection read');
      return value.after;
    } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(400, 'invalid_cursor', 'Cursor is invalid for this collection'); }
  };
  function page(rows, scope, {limit = '100', cursor} = {}) {
    if (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 1000) throw new DomainError(400, 'invalid_limit', 'limit must be an integer from 1 through 1000');
    const after = decodeCursor(cursor, scope), offset = after === null ? 0 : rows.findIndex(row => String(row.key) === after) + 1;
    if (after !== null && offset === 0) throw new DomainError(400, 'invalid_cursor', 'Cursor does not identify a record in this collection');
    const selected = rows.slice(offset, offset + Number(limit)), more = offset + selected.length < rows.length;
    return {data: selected.map(row => row.value), total_count: rows.length, has_more: more, next_cursor: more ? encodeCursor(scope, String(selected.at(-1).key)) : null, world};
  }
  function listCollections(options) {
    return page(db.prepare('SELECT name FROM collections ORDER BY name COLLATE BINARY').all().map(({name}) => ({key: name, value: {
      name, count: db.prepare('SELECT count(*) AS count FROM records WHERE collection=?').get(name).count,
      writable: WRITABLE_COLLECTIONS.includes(name), id_field: 'id', owner: WRITABLE_COLLECTIONS.includes(name) ? 'domain' : 'seed-view',
      write_scope: WRITABLE_COLLECTIONS.includes(name) ? 'domain-only' : 'read-only', provider_sync: false,
    }})), 'collections', options);
  }
  function listRecords(name, options) {
    checkCollection(name);
    return page(db.prepare('SELECT id,body FROM records WHERE collection=? ORDER BY id COLLATE BINARY').all(name).map(row => ({key: row.id, value: JSON.parse(row.body)})), `records:${name}`, options);
  }
  function detail(name, id) {
    checkCollection(name); const value = getVersioned(name, id);
    if (!value) throw new DomainError(404, 'record_not_found', `${name} has no record ${id}`);
    return {...value, world};
  }
  function mutate(name, operation, input, id, {validateOnly = false} = {}) {
    checkCollection(name);
    if (!WRITABLE_COLLECTIONS.includes(name)) throw new DomainError(403, 'read_only_collection', `${name} is a read-only canonical seed view; finance settlement state is owned by its provider APIs`);
    validateEnvelope(input, operation);
    if (!get('identity.people', input.actor_id)) throw new DomainError(400, 'invalid_actor', 'actor_id must name a person in this world', 'actor_id');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = operation === 'create' ? null : getVersioned(name, id);
      if (operation !== 'create' && !previous) throw new DomainError(404, 'record_not_found', `${name} has no record ${id}`);
      if (input.expected_version !== undefined && previous?.version !== input.expected_version) throw new DomainError(409, 'version_conflict', 'The record version changed');
      const record = operation === 'delete' ? null : operation === 'create' ? input.record : {...previous.record, ...input.patch};
      if (operation === 'update' && record.id !== id) throw new DomainError(400, 'immutable_id', 'PATCH cannot change record.id', 'id');
      if (record) validateRecord(name, record, get);
      const recordId = record?.id ?? id;
      if (operation === 'create' && get(name, recordId)) throw new DomainError(409, 'record_conflict', `${name} already contains ${recordId}`);
      const referring = db.prepare('SELECT collection,id,body FROM records').all().map(row => ({...row, record: JSON.parse(row.body)}))
        .filter(row => !(row.collection === name && row.id === recordId) && referenceEdges(row.collection, row.record).some(edge => edge.collection === name && edge.id === recordId));
      if (operation === 'delete' && referring.length) throw new DomainError(409, 'reference_in_use', `${name}/${recordId} is referenced by ${referring[0].collection}/${referring[0].id}`);
      if (record) {
        const candidateGet = (collection, key) => collection === name && key === recordId ? record : get(collection, key);
        for (const dependent of referring.filter(row => WRITABLE_COLLECTIONS.includes(row.collection))) {
          try { validateRecord(dependent.collection, dependent.record, candidateGet); }
          catch (error) { throw new DomainError(409, 'reference_conflict', `The change would invalidate ${dependent.collection}/${dependent.id}: ${error.message}`, error.field); }
        }
      }
      if (validateOnly) { db.exec('ROLLBACK'); return {ok: true, valid: true, record, world}; }
      const version = (previous?.version ?? 0) + 1;
      if (operation === 'delete') db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(name, id);
      else if (operation === 'create') db.prepare('INSERT INTO records(collection,id,body,version) VALUES (?,?,?,?)').run(name, recordId, JSON.stringify(record), version);
      else db.prepare('UPDATE records SET body=?,version=? WHERE collection=? AND id=?').run(JSON.stringify(record), version, name, id);
      const seq = revision() + 1;
      const event = {api_version: 'worldfixture.domain-event/v1', id: `domain-event-${seq}`, seq,
        type: operation === 'create' && name === 'commerce.orders' ? 'commerce.order.placed.v1' : `domain.record.${{create: 'created', update: 'updated', delete: 'deleted'}[operation]}.v1`,
        collection: name, record_id: recordId, actor_id: input.actor_id, occurred_at: now(), world: {id: world.id, version: world.version},
        provenance: {service: 'domain', artifact_sha256: world.artifact_sha256, record_version: version, write_scope: 'domain-only', provider_sync: false}, before: previous?.record ?? null, after: record};
      db.prepare('INSERT INTO events(seq,body) VALUES (?,?)').run(seq, JSON.stringify(event));
      db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(seq)); db.exec('COMMIT');
      return {ok: true, record, version, event, world};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {world, databasePath, close: () => db.close(), listCollections, listRecords, detail, mutate,
    listEvents: options => page(db.prepare('SELECT seq,body FROM events ORDER BY seq').all().map(row => ({key: String(row.seq), value: JSON.parse(row.body)})), 'events', options)};
}
