# Application connectors

A WorldFixture application connector fills an application with data from a
prepared world artifact.
It is a development-only HTTP interface implemented inside the target application.
The application owns its domain model and mapping. WorldFixture owns the source
records, clock, delivery order, and run receipts.

Use a connector for two operations:

1. Seed the accepted starting state.
2. Deliver new records and changes while the world clock runs.

The Workbench and CLI are equal clients of the same protocol. A coding-agent
skill can inspect an application and implement its connector from these docs.

## User flow

1. From the application root, start WorldFixture:

   ```sh
   npx worldfixture up
   ```

2. Start the application in another terminal with its normal development
   command.
3. Workbench uses the URL in `.worldfixture/project.json`. You can also run
   `npx worldfixture connector check` with that URL.
4. If the connector is missing, use the `add-worldfixture-connector` skill or
   copy the generated prompt.
5. Review the seed plan.
6. Choose how much of the world to seed.
7. Seed baseline records.
8. Start, pause, accelerate, or manually deliver live events.

## How much of the world to seed

A full seed of the default world sends 13,417 records, and a developer checking
that their mapping works does not need them. `check`, `plan` and `seed` take a
slice:

```sh
npx worldfixture connector seed http://localhost:3000 --scale smoke
npx worldfixture connector seed http://localhost:3000 --limit people=25,messages=5
```

`smoke` keeps at most 25 records of anything and sends 586. `sample` keeps
at most 250. `full` is the default. `--limit` sets counts per collection and
overrides the preset for the collections it names; a nested list such as
`messages` is counted per parent. The Workbench offers the same choice under
**Target**.

WorldFixture takes the slice. A connector does not choose it, and does not need
to know how it was chosen, because a slice is always whole: it never contains a
record that refers to a record it does not contain, and it never empties a
collection the world has records in. A membership list is trimmed to the people
who are present rather than the record being dropped.

Each slice is its own seeding operation and carries its own `idempotency_key`,
so seeding a small slice and then a larger one is two operations rather than a
repeat.

Read [protocol-v1.md](protocol-v1.md) before implementing a connector. Read
[security.md](security.md) for every implementation. Read [mapping-guide.md](mapping-guide.md)
when choosing application entities and services.

The browser extension is not part of Connector v1.

## What happens after a user enters port 3000

Workbench treats `http://localhost:3000` as the target application origin. It
requests `/.well-known/worldfixture` from that origin.

- If discovery succeeds, Workbench shows the connector capabilities and asks
  for a read-only seed plan. The user can then fill the application or deliver
  one event now.
- If discovery returns `404` or is invalid, Workbench shows a coding-agent
  prompt. The prompt tells the agent to read the installed WorldFixture docs,
  inspect the target application's models, add the connector, and run the
  conformance check.
- If the application is unreachable, Workbench keeps the entered URL and lets
  the user check again after the application starts.

Workbench makes connector requests through the local WorldFixture runtime. The
target application does not give database credentials to the browser.

## Application services

The app keeps its own development command and service lifecycle. Optional
WorldFixture services can include PostgreSQL, a MySQL-compatible MariaDB 10.11
database, S3 object storage, and SMTP. The project
requests available services in `.worldfixture/project.json`. The connector
setup maps their bindings into the app only when the user selects them. It does
not replace an app-owned service by default.

An application database cannot support connector reset. Seed and event
operations must still be idempotent, but the connector must not delete the
application tenant or try to reverse its records. Normal `worldfixture reset`
also preserves database data. A future destructive database rebuild must be a
separate, explicit service operation.

## Local environment

`npx worldfixture up` creates or reuses `.worldfixture/token` with file mode
`0600`. The generated `.worldfixture/.gitignore` keeps the token and run state
private while it permits the project config to be committed. The root
`.dockerignore` excludes the token from image builds. The token value is not
printed.

The connector reads `WORLDFIXTURE_TOKEN` or, in development only, the project
token file. The environment value is useful when the app runs in a container.

## Why Connector v1 is application-level

PostgreSQL and MySQL are storage systems, not application domain models. A
generic database writer can find tables, but it cannot reliably know which
table is a user, which service creates a task, or which writes must send a
notification. Connector v1 therefore runs inside the target application and
uses its ORM or service layer. This design supports PostgreSQL, MySQL, SQLite,
and other storage systems without making database structure the public
contract.

A later database adapter can help an agent inspect schemas or generate mapping
code. It must still produce an application-owned connector and mapping plan. It
must not write to unknown tables automatically.
