---
name: add-worldfixture-connector
description: Add or repair a development-only WorldFixture application connector from the installed Connector v1 documentation. Use when a user wants WorldFixture to seed an application or deliver live world events to it.
---

# Add a WorldFixture connector

Implement the connector inside the target application. The application owns the
mapping and WorldFixture owns the protocol.

## Source of truth

Before changing the application, run `worldfixture connector docs` and read all
of the installed Connector v1 documentation. Use the installed documentation
and schemas instead of reconstructing the protocol from this skill.

## Work

1. Read the packs reference in `worldfixture connector docs` ("What a connector
   receives") first. It lists every pack, collection and field with a real record
   of each, generated from the artifact. Do not capture a seed request to
   discover the payload, and do not guess a field name.
2. Inspect the application's domain models, migrations, ORM, authentication,
   service layer, existing factories or seed tools, development commands,
   tests, and local service dependencies.
3. Propose mappings from accepted WorldFixture packs to existing application
   concepts. Identify skipped records and required dependencies.
4. Preserve the application's normal development command and service lifecycle.
   Read `.worldfixture/project.json`. Request optional WorldFixture services
   there only when the user wants them. Do not replace a working app-owned
   database or other service by default.
5. Test the application through its normal development path. Verify its normal
   page and connector. The user must not copy the connector token.
6. Implement the development-only connector. Use existing application services
   for live events when their normal side effects matter. Use the ORM for
   efficient baseline data when it preserves application rules.
7. Require `WORLDFIXTURE_TOKEN`. Do not enable the connector in production or
   expose secrets in discovery, status, logs, or errors.
8. In development, load the token from `WORLDFIXTURE_TOKEN` or
   `.worldfixture/token` in the app root. Keep file loading disabled in
   production. Implement runtime loading without opening or reading the real
   token during agent work. Use a separate dummy token in tests. Do not print,
   commit, copy, or otherwise expose the real token.
9. Make seed and event delivery idempotent. Return application references for
   mapped WorldFixture entities.
10. Do not implement connector reset for an app-owned database. When
   WorldFixture owns the complete local database, reset belongs to the
   WorldFixture service lifecycle and restores or replaces that database
   outside the application connector. A connector must never delete the
   application's tenant or try to reverse seeded records individually.
11. Add application tests for mapping, repeated seed, repeated event delivery,
   authentication, and the normal application page. Test service-owned reset
   outside the connector when that service lifecycle is available.
12. Match the published response schemas exactly. `connector check` validates
   every response against `schemas/connector-*.v1.schema.json` and names any
   missing field. The fields most often missed are `mappings` on a plan (plural,
   with `source`, `target` and `status` on each entry), `status` and `references`
   on a receipt, and `receipts` on a status. `capabilities` must give a boolean
   for all five operations, and `state` is a closed set.
13. Accept a partial world. A seed or plan can carry a slice rather than the
   whole world, and `options.scale` says what arrived. A slice is always
   referentially whole, so no special handling is needed, but a plan should
   report counts for what it was sent and say so when `complete` is `false`.
   Iterate with `--scale smoke`, then prove a full seed once.
14. Run `npx worldfixture connector check <application-url>` and the relevant
   application tests. Fix failures before handoff.

Report the service bindings, start command, application URL, entity mapping,
event mapping, skipped records, reset behavior, verification results, and
changed files.
