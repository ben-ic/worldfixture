# Application service plan

Superseded by [project-flow.md](project-flow.md). WorldFixture no longer owns
the target application's setup, migrations, or process.

Status: superseded. The project-local flow, PostgreSQL, MySQL-compatible
MariaDB, S3, SMTP, and complete bindings are implemented. Use
`npx worldfixture up` and `npx worldfixture run -- <command>`. WorldFixture does
not own the application process.

## User experience

The user gives WorldFixture an application directory. A coding agent adds the
connector and one committed application manifest. The user then runs one
command:

```sh
worldfixture app up
```

Workbench uses the same operation. Before the first run, it shows the detected
services and commands. After confirmation, WorldFixture:

1. Starts the required local services.
2. Creates the app database and accepted S3 buckets.
3. Maps WorldFixture bindings to the app's environment variable names.
4. Adds the private connector token to the app process environment.
5. Runs dependency, build, and migration commands when required.
6. Starts the app.
7. Waits for the normal app page and connector discovery endpoint.
8. Shows the connector seed plan.

WorldFixture reserves the application port before it allocates provider ports.
If a provider normally uses the same port, WorldFixture moves the provider and
updates its binding. The application URL remains stable.

The user does not copy a token, start a database, or maintain a second compose
file.

## Manifest

Use a committed `.worldfixture/application.json` file. It contains no secret
values. A proposed shape is:

```json
{
  "api_version": "worldfixture.application/v1",
  "name": "example-app",
  "url": "http://localhost:8080",
  "services": [
    {
      "use": "postgres.wire.v1",
      "ownership": "worldfixture",
      "environment": {
        "DATABASE_URL": "POSTGRES_URL"
      }
    },
    {
      "use": "aws.s3.objects.v1",
      "ownership": "worldfixture",
      "environment": {
        "S3_ENDPOINT": "S3_BASE_URL",
        "S3_ACCESS_KEY_ID": "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY": "S3_SECRET_ACCESS_KEY",
        "S3_REGION": "S3_REGION",
        "S3_BUCKET": "S3_BUCKET"
      }
    }
  ],
  "setup": [
    ["npm", "ci"],
    ["npm", "run", "build"],
    ["npm", "run", "migrate"]
  ],
  "start": ["npm", "run", "dev"],
  "readiness": {
    "path": "/",
    "expect_status": 200
  }
}
```

The final schema can add command conditions and framework shortcuts only after
two independent app tests show that they are needed.

## Canonical bindings

Database services must supply complete connection values:

- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USERNAME`,
  `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`, and `POSTGRES_URL`.
- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USERNAME`, `MYSQL_PASSWORD`,
  `MYSQL_DATABASE`, and `MYSQL_URL`.

S3 must supply `S3_BASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_REGION`, `S3_PATH_STYLE`, and an accepted `S3_BUCKET`. SMTP must supply
separate `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, and `SMTP_PASSWORD` values.
It can also supply `SMTP_HOST_PORT` for current WorldFixture clients. The app
manifest maps these values to the names used by the app.

The runtime stores secret values in its private instance state and injects them
into the app process. Workbench does not receive or display them.

If WorldFixture writes a local token file, it adds that file to both
`.gitignore` and `.dockerignore`. The app start path must load that file or use
direct process injection. The coding agent must not assume that the framework
loads `.env.local`.

## Ownership and reset

The manifest must state whether each service is `worldfixture`, `application`,
or `external`. Normal world reset preserves database data for all ownership
modes. The connector does not delete application records. Repeated seed and
event requests remain idempotent. A future destructive database rebuild must
be a separate, explicit operation.

## Delivery order

1. Done: add `postgres.wire.v1` and `mysql.wire.v1` with real protocol checks
   and complete bindings.
2. Done: add project-local service selection and safe local token storage.
3. Done: make `npx worldfixture up` and `npx worldfixture run -- <command>` work
   from an application root.
4. Done: use the same connector operations from Workbench.
5. In progress: repeat the independent Monica test with the MySQL-compatible
   service.
6. Define and validate the canonical application event catalog.
7. Add a full, explicit connector verification command that tests seed and
   event idempotency. Keep `connector check` non-mutating.
8. Add an extension only after this local flow is proven.

## Acceptance test

For each target app, start from a clean worktree with no app services running.
Use only the generated connector prompt and installed docs. One WorldFixture
command must reach all of these results:

- required services are ready;
- migrations are complete;
- the app's normal page returns success;
- connector conformance passes;
- baseline data is visible in the normal UI;
- a live event appears once after two deliveries;
- no reset action is offered for an app-owned database.
