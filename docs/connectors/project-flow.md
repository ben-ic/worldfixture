# Project and service plan

Status: in progress. Project-local configuration, stable token handling,
PostgreSQL, MySQL-compatible MariaDB, S3, SMTP bindings, and connector clients
are implemented.

## Product boundary

The user runs `npx worldfixture up` from an application root. WorldFixture owns
the world, Workbench, optional fixture services, connector client, and live
event delivery. It does not install app dependencies, run app migrations, or
start the app. The user starts the app with its normal command in another
terminal.

## Startup

`npx worldfixture up` uses the current directory as the project root. It creates
the project config and stable token when absent, starts the world and requested
optional services, and uses `application_url` as the connector target. When the
app is not running, Workbench keeps the target and shows the coding-agent
prompt.

The current optional service names are `postgres`, `mysql`, `s3`, and `smtp`.
Their bindings can change when a preferred port is unavailable. An app that
consumes them must read the active run bindings. Static copied ports are not
the contract.

## Ownership and reset

The connector never resets app data. Normal `worldfixture reset` preserves all
database data, including data in a WorldFixture-supplied database. Repeated seed
and event delivery remain idempotent. A future destructive database rebuild
must use a separate, explicit command.

## Delivery order

1. Done: connector protocol, prompt, Workbench client, and live delivery.
2. Done: project-local config and stable ignored token.
3. Done: PostgreSQL, MySQL-compatible MariaDB, and complete database, S3, and
   SMTP bindings.
4. In progress: pass project service selection and connector target to the
   runtime.
5. Package the root CLI for `npx worldfixture`.
6. Test the two-terminal flow with the regular sample app.
7. Test the prompt-only flow with Fider.
8. In progress: repeat the clean Monica test with the MySQL-compatible service.
9. Add the browser extension after this flow is proven.

## Acceptance test

From a clean application directory:

- `npx worldfixture up` creates safe project-local state;
- the app starts through its normal command;
- Workbench connects through the configured URL;
- baseline seed is visible in the normal app UI;
- a repeated seed creates no duplicates;
- one event delivered twice appears once;
- no connector reset is offered for an app-owned database.
