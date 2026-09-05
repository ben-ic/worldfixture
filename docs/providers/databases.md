# PostgreSQL and MariaDB

Database services are optional. Select them in `.worldfixture/project.json`.
Then use the dynamic `POSTGRES_*` or `MYSQL_*` bindings.

## What works

| Service | What works | What does not have proof | Test proof |
| --- | --- | --- | --- |
| PostgreSQL 15.19 | Startup, generated bindings, connection, and SCRAM-SHA-256 wire authentication | SQL reads, writes, transactions, schema operations, and `COPY` have no WorldFixture CRUD contract test | Connection and authentication are **Supported and contract-tested** by service and supervisor tests |
| MariaDB 10.11.18 on the MySQL protocol | Handshake, database creation, insert, select, and persistence through normal reset | Broad MariaDB SQL behavior and Oracle MySQL semantic parity | The named operations are **Supported and contract-tested** by `runtime/src/supervisor.test.mjs` |

Overall status: **Supported but partial**. This summary does not add support
beyond the exact operations in the table.

## What does not work

- PostgreSQL SQL reads and writes do not have a WorldFixture CRUD contract test.
- WorldFixture does not prove complete PostgreSQL or MariaDB SQL behavior.
- WorldFixture does not prove Oracle MySQL parity.
- The Workbench does not have a database browser.
- Database changes do not create WorldFixture events or webhooks.

## State and reset

- A normal world reset keeps PostgreSQL and MariaDB data.
- `down` removes their temporary container state.
- WorldFixture does not seed database data.
- The Workbench shows connection values only. It has no database browser.
- Database changes do not create WorldFixture events or webhooks.

## Drivers and production comparison

No database driver version is tested. These services run the named database
server versions. WorldFixture does not claim complete PostgreSQL, MariaDB, or
Oracle MySQL behavior.
