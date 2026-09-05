# Project connection

Run WorldFixture from the target application's root directory:

```sh
npx worldfixture up
```

The directory becomes the local project boundary. WorldFixture creates:

- `.worldfixture/project.json`, a small secret-free file that can be committed;
- `.worldfixture/token`, a stable local connector secret with mode `0600`;
- `.worldfixture/runs/`, ignored local runtime state.

The generated `.worldfixture/.gitignore` keeps the token and run state out of
Git while it permits `project.json`. WorldFixture also excludes the token from
the root Docker build context.

The initial project file is:

```json
{
  "api_version": "worldfixture.project/v1",
  "application_url": "http://localhost:3000",
  "services": []
}
```

Change `application_url` when the app uses another local origin. Optional
WorldFixture services are `postgres`, `mysql`, `s3`, and `smtp`. These services
do not change who owns the app or its normal start command.

Their bindings can change when a preferred port is already in use, so an
application that consumes them must read the active run bindings. A port copied
into a config file is not the contract.

You can set the origin when you start WorldFixture:

```bash
npx worldfixture up --application-url http://localhost:5175
```

The user starts the app with its normal development command in another
terminal. WorldFixture does not install dependencies, run migrations, or start
the app.

## Token loading

The connector can read `WORLDFIXTURE_TOKEN` from its process environment. For
the two-terminal local flow, it can instead read `.worldfixture/token` from the
app root. File loading must be development-only. It must refuse connector
actions when neither source contains a token.

Application code reads the token only at runtime. A coding agent must not open,
read, print, or copy the real token while it implements or tests a connector.
Tests must use a separate dummy token.

An app running in Docker must receive the token as an environment value or a
read-only mounted file. The token must not be copied into an image.

## Database ownership

By default, the connector writes through the app's existing data layer to its
existing database. The database is app-owned. Seed and event requests must be
idempotent, and connector reset must be unavailable.

Adding `postgres` to the project service list asks WorldFixture to supply a
local database. It does not give the connector permission to reset database
data. Normal `worldfixture reset` preserves application records. A future
destructive database rebuild must use a separate, explicit command.

Adding `mysql` supplies a MySQL-compatible MariaDB 10.11 database. It provides
`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USERNAME`, `MYSQL_PASSWORD`,
`MYSQL_DATABASE`, and `MYSQL_URL`. Run the application with
`npx worldfixture run -- <normal-development-command>` so it receives the
active bindings. The same ownership and preservation rules apply to both
databases.
