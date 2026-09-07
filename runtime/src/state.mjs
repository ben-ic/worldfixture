// One SQLite database per environment, and nothing else.
//
// The boundary is explicit: SQLite holds the runtime's own records -- the
// append-only event log, schedules, cursors, leases, turn requests, idempotency
// keys and clock -- and service state stays in the service that owns it. Slack
// owns Slack messages. Cyrus owns IMAP mailboxes. SeaweedFS owns S3 objects.
// The event log is an observation ledger: it records completed facts and their
// provider evidence, and it is not a copy of provider state.
//
// `node:sqlite` is in the standard library from Node 22, so this costs no
// dependency, which keeps the runtime as free of a supply chain as the compiler.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { shareHostOwnership } from './host-state-ownership.mjs';

export const SCHEMA_VERSION = 2;

// `strict` catches a column written with the wrong type at insert time rather
// than at read time, which for an append-only log is the difference between a
// failure and a corrupt record nothing notices.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT;

-- The lock this instance was started from. One row: an instance never follows a
-- newer resolution, so a second lock is a new instance rather than an update.
CREATE TABLE IF NOT EXISTS instance (
  id TEXT PRIMARY KEY,
  lock_sha256 TEXT NOT NULL,
  environment_sha256 TEXT NOT NULL,
  world_id TEXT NOT NULL,
  world_version TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;

-- Append-only. 'seq' is the cursor consumers record; nothing updates a row.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  actor_id TEXT,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  provider_evidence TEXT,
  caused_by TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS events_by_type ON events(type);

-- A command can fail, so it is recorded apart from the fact it may produce.
-- Only a successful provider action creates the event; a model response is a
-- proposal and never evidence.
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  actor_id TEXT,
  target TEXT NOT NULL,
  input TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL,
  failure TEXT,
  event_id TEXT,
  submitted_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS scheduled_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  due_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  caused_by TEXT,
  delivered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','delivered','failed','skipped','uncertain')),
  attempted_at INTEGER,
  completed_at INTEGER,
  command_id TEXT,
  event_id TEXT,
  error TEXT
) STRICT;

-- Preserved across provider reset: the application owns its data and receipts.
CREATE TABLE IF NOT EXISTS connector_receipts (
  event_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  envelope TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  receipt TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS timeline_cycle (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  cycle INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS scheduled_events_due ON scheduled_events(due_at) WHERE delivered_at IS NULL;

-- Where the runtime has read up to in each service's change journal. No service
-- offers one yet -- 'GET /_worldfixture/changes' exists nowhere -- so this table
-- stays empty until one does, and is here because the cursor contract is the
-- reason a service must declare 'recoverable_changes'.
CREATE TABLE IF NOT EXISTS service_cursors (
  service TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS actor_leases (
  actor_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

-- The environment clock. Startup time does not consume the scenario timeline,
-- so the live clock starts only after required readiness.
CREATE TABLE IF NOT EXISTS clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  world_anchor TEXT NOT NULL,
  started_at INTEGER,
  paused_at INTEGER,
  offset_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

function migrateSchema1To2(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    ALTER TABLE scheduled_events RENAME TO scheduled_events_v1;
    DROP INDEX IF EXISTS scheduled_events_due;
    CREATE TABLE scheduled_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      due_at INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      caused_by TEXT,
      delivered_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_flight','delivered','failed','skipped','uncertain')),
      attempted_at INTEGER,
      completed_at INTEGER,
      command_id TEXT,
      event_id TEXT,
      error TEXT
    ) STRICT;
    INSERT INTO scheduled_events (
      id, due_at, type, payload, caused_by, delivered_at, status, completed_at
    )
    SELECT
      id, due_at, type, payload, caused_by, delivered_at,
      CASE WHEN delivered_at IS NULL THEN 'pending' ELSE 'delivered' END,
      delivered_at
    FROM scheduled_events_v1
    ORDER BY due_at, id;
    DROP TABLE scheduled_events_v1;
    CREATE INDEX scheduled_events_due ON scheduled_events(due_at) WHERE delivered_at IS NULL;
    UPDATE schema_version SET version = 2;
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openState(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  const [row] = db.prepare("SELECT version FROM schema_version").all();
  if (!row) {
    db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
  } else if (row.version === 1 && SCHEMA_VERSION === 2) {
    migrateSchema1To2(db);
  } else if (row.version !== SCHEMA_VERSION) {
    // Refuse schemas for which there is no reviewed, lossless migration.
    throw new Error(
      `state at ${path} is schema version ${row.version}, this runtime writes ${SCHEMA_VERSION}; ` +
        "remove the instance directory and start a new instance",
    );
  }

  if (path !== ":memory:") {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) shareHostOwnership(file);
    }
  }
  return db;
}

export function recordInstance(db, { id, lock, lockSha256, startedAt }) {
  db.prepare(
    `INSERT INTO instance(id, lock_sha256, environment_sha256, world_id, world_version, artifact_sha256, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, lockSha256, lock.environment_sha256, lock.world.id, lock.world.version, lock.world.artifact_sha256, startedAt);
}

export function appendEvent(db, event) {
  db.prepare(
    `INSERT INTO events(id, type, actor_id, source, occurred_at, provider_evidence, caused_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.type,
    event.actor_id ?? null,
    event.source,
    event.occurred_at,
    event.provider_evidence ? JSON.stringify(event.provider_evidence) : null,
    event.caused_by ?? null,
  );
  return db.prepare("SELECT seq FROM events WHERE id = ?").get(event.id).seq;
}

export function eventsAfter(db, cursor = 0, limit = 100) {
  return db
    .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(cursor, limit)
    .map((row) => ({
      ...row,
      provider_evidence: row.provider_evidence ? JSON.parse(row.provider_evidence) : undefined,
    }));
}

export function latestEvents(db, limit = 100) {
  return db
    .prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?")
    .all(limit)
    .reverse()
    .map((row) => ({
      ...row,
      provider_evidence: row.provider_evidence ? JSON.parse(row.provider_evidence) : undefined,
    }));
}

// Restore the runtime-owned part of a session. The instance row and schema stay:
// reset returns this instance to its accepted start; it does not create another
// instance with another lock.
export function resetState(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "events",
      "commands",
      "scheduled_events",
      "service_cursors",
      "actor_leases",
      "clock",
    ]) {
      db.exec(`DELETE FROM ${table}`);
    }
    db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run("events");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
