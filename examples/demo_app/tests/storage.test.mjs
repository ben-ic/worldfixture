import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, databaseConfig } from '../src/db/store.mjs';

const memoryEnv = { ACCOUNT_DESK_SQLITE_PATH: ':memory:', WORLDFIXTURE_WORLD_ID: 'test', WORLDFIXTURE_WORLD_VERSION: 'v1' };

test('app storage saves and replaces JSON records without shared references', async () => {
  const store = await createStore(memoryEnv);
  try {
    assert.equal(store.kind, 'sqlite');
    assert.equal(store.available, true);
    assert.equal(await store.get('drafts', 'missing'), null);
    const input = { id: 'draft-1', body: 'First reply', state: 'draft' };
    await store.put('drafts', input.id, input);
    input.body = 'Mutated outside store';
    assert.equal((await store.get('drafts', input.id)).body, 'First reply');
    await store.put('drafts', input.id, { ...input, body: 'Edited reply' });
    assert.equal((await store.list('drafts')).length, 1);
    assert.equal((await store.get('drafts', input.id)).body, 'Edited reply');
    await assert.rejects(store.list('provider_state'), /Unknown app collection/);
    await assert.rejects(store.put('drafts', '', {}), /record ID/);
    await assert.rejects(store.put('drafts', 'undefined', undefined), /must be JSON/);
  } finally { await store.close(); }
  await assert.rejects(store.get('drafts', 'draft-1'), /closed/);
});

test('transactions roll back all writes and serialize concurrent changes', async () => {
  const store = await createStore(memoryEnv);
  try {
    await assert.rejects(store.transaction(async (tx) => {
      await tx.put('drafts', 'failed', { id: 'failed' });
      await tx.put('receipts', 'failed', { id: 'failed' });
      throw new Error('simulated failure');
    }), /simulated failure/);
    assert.deepEqual(await store.list('drafts'), []);
    assert.deepEqual(await store.list('receipts'), []);
    await store.put('runs', 'counter', { id: 'counter', count: 0 });
    await Promise.all(Array.from({ length: 12 }, () => store.transaction(async (tx) => {
      const counter = await tx.get('runs', 'counter');
      await tx.put('runs', 'counter', { ...counter, count: counter.count + 1 });
    })));
    assert.equal((await store.get('runs', 'counter')).count, 12);
  } finally { await store.close(); }
});

test('app records survive reopening and are isolated by world and version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'account-desk-storage-'));
  const env = { ...memoryEnv, ACCOUNT_DESK_SQLITE_PATH: join(directory, 'app.sqlite') };
  try {
    const first = await createStore(env);
    await first.put('drafts', 'one', { id: 'one', body: 'Keep after reset' });
    await first.close();
    const reopened = await createStore(env);
    assert.equal((await reopened.get('drafts', 'one')).body, 'Keep after reset');
    await reopened.close();
    for (const changes of [{ WORLDFIXTURE_WORLD_ID: 'other' }, { WORLDFIXTURE_WORLD_VERSION: 'v2' }]) {
      const other = await createStore({ ...env, ...changes });
      assert.deepEqual(await other.list('drafts'), []);
      await other.close();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('database bindings reject remote writes and malformed values before connecting', async () => {
  const local = databaseConfig({ POSTGRES_URL: 'postgres://app:local%3Apassword@127.0.0.1:35432/app' }, 'postgres');
  assert.equal(local.port, 35432);
  assert.equal(local.password, 'local:password');
  assert.equal(databaseConfig({ MYSQL_URL: 'mysql://app:pw@localhost:33306/app' }, 'mysql').host, '127.0.0.1');
  assert.throws(() => databaseConfig({ POSTGRES_URL: 'postgres://app:pw@production.example:5432/app' }, 'postgres'), /loopback/);
  assert.throws(() => databaseConfig({ MYSQL_URL: 'postgres://app:pw@localhost:5432/app' }, 'mysql'), /protocol/);
  assert.throws(() => databaseConfig({ POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: 'wat' }, 'postgres'), /port/);
  await assert.rejects(createStore({ ...memoryEnv, ACCOUNT_DESK_DATABASE: 'postgres' }), /bindings are missing/);
  await assert.rejects(createStore({ ...memoryEnv, ACCOUNT_DESK_DATABASE: 'mysql' }), /bindings are missing/);
  await assert.rejects(createStore({ ...memoryEnv, ACCOUNT_DESK_DATABASE: 'mongodb' }), /must be/);
});
