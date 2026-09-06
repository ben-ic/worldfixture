import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const COLLECTIONS = new Set(['drafts', 'receipts', 'runs', 'mappings', 'events', 'slackScenarios', 'slackScenarioPlans']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function validateKey(collection, id) {
  if (!COLLECTIONS.has(collection)) throw new Error(`Unknown app collection: ${collection}`);
  if (id !== undefined && (typeof id !== 'string' || !id || id.length > 512)) {
    throw new Error('An app record ID must contain 1 to 512 characters.');
  }
}

export function databaseConfig(env, provider) {
  const prefix = provider === 'postgres' ? 'POSTGRES' : 'MYSQL';
  let config;
  if (env[`${prefix}_URL`]) {
    const url = new URL(env[`${prefix}_URL`]);
    if (!(provider === 'postgres' ? ['postgres:', 'postgresql:'] : ['mysql:']).includes(url.protocol)) {
      throw new Error(`Invalid ${prefix}_URL protocol.`);
    }
    // Do not pass arbitrary URL options to a database driver.
    config = {
      host: url.hostname, port: Number(url.port || (provider === 'postgres' ? 5432 : 3306)),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
    };
  } else if (env[`${prefix}_HOST`]) {
    config = {
      host: env[`${prefix}_HOST`], port: Number(env[`${prefix}_PORT`]),
      user: env[`${prefix}_USERNAME`], password: env[`${prefix}_PASSWORD`],
      database: env[`${prefix}_DATABASE`],
    };
  } else return null;
  if (!LOOPBACK.has(config.host)) throw new Error(`${prefix} must use a loopback address. Account Desk cannot write to a remote database.`);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error(`Invalid ${prefix} port.`);
  if (!config.user || !config.database) throw new Error(`${prefix} user and database bindings are required.`);
  if (config.host === '[::1]') config.host = '::1';
  // Use a literal address: do not resolve a user-controlled hostname.
  if (config.host === 'localhost') config.host = '127.0.0.1';
  return config;
}

/** App records only. Never stores a replacement copy of provider state. */
export async function createStore(env = process.env) {
  const namespace = createHash('sha256').update(JSON.stringify([env.WORLDFIXTURE_WORLD_ID || 'unbound', env.WORLDFIXTURE_WORLD_VERSION || 'unknown'])).digest('hex');
  const requested = env.ACCOUNT_DESK_DATABASE;
  if (requested && !['postgres', 'mysql', 'sqlite'].includes(requested)) throw new Error('ACCOUNT_DESK_DATABASE must be postgres, mysql, or sqlite.');
  const pgConfig = requested && requested !== 'postgres' ? null : databaseConfig(env, 'postgres');
  const mysqlConfig = requested && requested !== 'mysql' ? null : databaseConfig(env, 'mysql');
  if (requested === 'postgres' && !pgConfig) throw new Error('PostgreSQL was selected but its bindings are missing.');
  if (requested === 'mysql' && !mysqlConfig) throw new Error('MariaDB was selected but its bindings are missing.');
  const kind = pgConfig ? 'postgres' : mysqlConfig ? 'mysql' : 'sqlite';
  let connection;
  let query;
  let close;
  if (kind === 'postgres') {
    const { default: pg } = await import('pg');
    connection = new pg.Client({ ...pgConfig, connectionTimeoutMillis: 5000 });
    await connection.connect();
    query = async (sql, values = []) => (await connection.query(sql, values)).rows;
    close = () => connection.end();
  } else if (kind === 'mysql') {
    const { default: mysql } = await import('mysql2/promise');
    connection = await mysql.createConnection({ ...mysqlConfig, connectTimeout: 5000 });
    query = async (sql, values = []) => (await connection.execute(sql, values))[0];
    close = () => connection.end();
  } else {
    const { DatabaseSync } = await import('node:sqlite');
    const path = env.ACCOUNT_DESK_SQLITE_PATH === ':memory:' ? ':memory:' : resolve(env.ACCOUNT_DESK_SQLITE_PATH || '.account-desk/app.sqlite');
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    connection = new DatabaseSync(path);
    connection.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    query = async (sql, values = []) => {
      const statement = connection.prepare(sql);
      return /^\s*(SELECT|PRAGMA)/i.test(sql) ? statement.all(...values) : statement.run(...values);
    };
    close = () => connection.close();
  }
  const placeholder = (number) => kind === 'postgres' ? `$${number}` : '?';
  const keyWhere = `namespace = ${placeholder(1)} AND collection = ${placeholder(2)}`;
  const jsonType = kind === 'postgres' ? 'JSONB' : kind === 'mysql' ? 'JSON' : 'TEXT';
  try {
    await query(`CREATE TABLE IF NOT EXISTS account_desk_records (
      namespace VARCHAR(64) NOT NULL, collection VARCHAR(32) NOT NULL,
      record_id VARCHAR(512) NOT NULL, value ${jsonType} NOT NULL,
      PRIMARY KEY (namespace, collection, record_id)
    )${kind === 'mysql' ? ' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' : ''}`);
    if (kind === 'mysql') {
      await query('CREATE TABLE IF NOT EXISTS account_desk_locks (namespace VARCHAR(512) PRIMARY KEY) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
      await query('INSERT IGNORE INTO account_desk_locks (namespace) VALUES (?)', [namespace]);
    }
  } catch (error) {
    await close();
    throw error;
  }
  const decode = (row) => typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  const raw = {
    async list(collection) {
      validateKey(collection);
      return (await query(`SELECT value FROM account_desk_records WHERE ${keyWhere} ORDER BY record_id`, [namespace, collection])).map(decode);
    },
    async get(collection, id) {
      validateKey(collection, id);
      const rows = await query(`SELECT value FROM account_desk_records WHERE ${keyWhere} AND record_id = ${placeholder(3)}`, [namespace, collection, id]);
      return rows.length ? decode(rows[0]) : null;
    },
    async put(collection, id, value) {
      validateKey(collection, id);
      const json = JSON.stringify(value);
      if (json === undefined || json.length > 8 * 1024 * 1024) throw new Error('App records must be JSON and no larger than 8 MiB.');
      const conflict = kind === 'mysql' ? 'ON DUPLICATE KEY UPDATE value = VALUES(value)' : 'ON CONFLICT (namespace, collection, record_id) DO UPDATE SET value = excluded.value';
      await query(`INSERT INTO account_desk_records (namespace, collection, record_id, value) VALUES (${[1, 2, 3, 4].map(placeholder).join(', ')}) ${conflict}`, [namespace, collection, id, json]);
      return JSON.parse(json);
    },
  };
  let pending = Promise.resolve();
  let closed = false;
  const schedule = (fn) => {
    if (closed) return Promise.reject(new Error('App storage is closed.'));
    const result = pending.then(fn);
    pending = result.catch(() => {});
    return result;
  };
  return {
    kind, available: true, namespace,
    description: kind === 'sqlite' ? 'Local app-only SQLite. Provider data stays in the world services.' : `App records in ${kind === 'postgres' ? 'PostgreSQL' : 'MariaDB'}. Provider data stays in the world services.`,
    list: (...args) => schedule(() => raw.list(...args)),
    get: (...args) => schedule(() => raw.get(...args)),
    put: (...args) => schedule(() => raw.put(...args)),
    transaction(callback) {
      return schedule(async () => {
        await query(kind === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
          if (kind === 'postgres') await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`account-desk:${namespace}`]);
          if (kind === 'mysql') await query('SELECT namespace FROM account_desk_locks WHERE namespace = ? FOR UPDATE', [namespace]);
          const result = await callback(raw);
          await query('COMMIT');
          return result;
        } catch (error) {
          await query('ROLLBACK');
          throw error;
        }
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await close();
    },
  };
}
