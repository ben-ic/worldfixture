// Explicit local database integration check. Run through generated bindings:
// npx worldfixture run -- node tests/storage-live.mjs
// ACCOUNT_DESK_DATABASE=mysql npx worldfixture run -- node tests/storage-live.mjs
// This creates and removes only records in a fresh test namespace. No world reset.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, databaseConfig } from '../src/db/store.mjs';

const testId = process.env.ACCOUNT_DESK_STORAGE_TEST_ID || randomUUID();
if (!/^[a-f0-9-]{36}$/.test(testId)) throw new Error('The storage test identity must be a test UUID.');
const phase = process.env.ACCOUNT_DESK_STORAGE_PHASE || 'complete';
if (!['complete', 'before-reset', 'after-reset'].includes(phase)) throw new Error('Invalid storage test phase.');
if (phase !== 'complete' && !process.env.ACCOUNT_DESK_STORAGE_TEST_ID) throw new Error('Reset test phases require the same explicit test UUID.');
const env = { ...process.env, WORLDFIXTURE_WORLD_ID: `account-desk-storage-check-${testId}`, WORLDFIXTURE_WORLD_VERSION: 'isolated-test' };
if (!['postgres', 'mysql', undefined].includes(env.ACCOUNT_DESK_DATABASE)) throw new Error('This test requires PostgreSQL or MariaDB, not SQLite.');
const selected = env.ACCOUNT_DESK_DATABASE || (env.POSTGRES_URL || env.POSTGRES_HOST ? 'postgres' : 'mysql');
if (!databaseConfig(env, selected)) throw new Error('Start a world with the selected database and run this test through npx worldfixture run.');
let store;
let namespace;
let kind;
let cleanup;
let preserveForReset = false;

try {
  store = await createStore(env);
  namespace = store.namespace;
  kind = store.kind;
  assert.ok(['postgres', 'mysql'].includes(kind), 'A generated database binding is required.');
  assert.match(namespace, /^[a-f0-9]{64}$/, 'The cleanup target must be an exact test namespace.');
  const config = databaseConfig(env, kind);
  if (kind === 'postgres') {
    const { default: pg } = await import('pg');
    const refused = new pg.Client({ ...config, password: `invalid-test-${randomUUID()}`, connectionTimeoutMillis: 5000 });
    try { await assert.rejects(refused.connect(), error => error.code === '28P01', 'A wrong PostgreSQL password must fail authentication.'); }
    finally { await refused.end(); }
    const client = new pg.Client({ ...config, connectionTimeoutMillis: 5000 });
    await client.connect();
    cleanup = async () => {
      try { if (!preserveForReset) await client.query('DELETE FROM account_desk_records WHERE namespace = $1', [namespace]); }
      finally { await client.end(); }
    };
  } else {
    const { default: mysql } = await import('mysql2/promise');
    await assert.rejects(async () => {
      const refused = await mysql.createConnection({ ...config, password: `invalid-test-${randomUUID()}`, connectTimeout: 5000 });
      await refused.end();
    }, error => error.code === 'ER_ACCESS_DENIED_ERROR', 'A wrong MariaDB password must fail authentication.');
    const client = await mysql.createConnection({ ...config, connectTimeout: 5000 });
    cleanup = async () => {
      try {
        if (!preserveForReset) {
          await client.execute('DELETE FROM account_desk_records WHERE namespace = ?', [namespace]);
          await client.execute('DELETE FROM account_desk_locks WHERE namespace = ?', [namespace]);
        }
      } finally { await client.end(); }
    };
  }
  if (phase !== 'after-reset') {
    await store.put('drafts', 'test-draft', { id: 'test-draft', body: 'Original test draft' });
    assert.equal((await store.get('drafts', 'test-draft')).body, 'Original test draft');
    await store.put('drafts', 'test-draft', { id: 'test-draft', body: 'Updated test draft' });
    assert.equal((await store.list('drafts')).length, 1);
    assert.equal((await store.get('drafts', 'test-draft')).body, 'Updated test draft');

    await assert.rejects(store.transaction(async tx => {
      await tx.put('drafts', 'rollback-draft', { id: 'rollback-draft' });
      await tx.put('receipts', 'rollback-receipt', { id: 'rollback-receipt' });
      assert.ok(await tx.get('drafts', 'rollback-draft'));
      throw new Error('Expected test rollback');
    }), /Expected test rollback/);
    assert.equal(await store.get('drafts', 'rollback-draft'), null);
    assert.deepEqual(await store.list('receipts'), []);
  } else {
    assert.equal((await store.get('drafts', 'test-draft'))?.body, 'Updated test draft', 'Normal world reset must preserve the committed app draft.');
    assert.equal(await store.get('drafts', 'rollback-draft'), null, 'A rolled-back draft must not appear after reset.');
  }

  await store.close();
  store = await createStore(env);
  assert.equal((await store.get('drafts', 'test-draft')).body, 'Updated test draft', 'A committed app draft must survive reconnect.');
  preserveForReset = phase === 'before-reset';
  await cleanup();
  cleanup = undefined;
  if (!preserveForReset) assert.deepEqual(await store.list('drafts'), [], 'Only this test namespace must be empty after cleanup.');
  const result = phase === 'before-reset' ? 'password refusal, CRUD, rollback, and reconnect passed; isolated record retained for reset check'
    : phase === 'after-reset' ? 'reset preservation, password refusal, reconnect, and exact test-record cleanup passed'
      : 'password refusal, create, read, update, rollback, reconnect, and test-record cleanup passed';
  console.log(`${kind === 'postgres' ? 'PostgreSQL' : 'MariaDB'}: ${result}.`);
} finally {
  try { await cleanup?.(); } finally { await store?.close(); }
}
