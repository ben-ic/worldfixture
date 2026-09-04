# Connector mapping guide

Map the world to the application's existing concepts. Do not add a second set of
organization, person, project, or task models only for WorldFixture.

Start with dependencies:

1. Tenant, workspace, or primary organization.
2. Users and memberships.
3. Customer and supplier organizations.
4. Provider or integration connections.
5. Projects and other parent records.
6. Tasks, support cases, finance records, and historical activity.

Keep the WorldFixture identity with each mapped record when the application has
a suitable fixture, external ID, metadata, or source field. Otherwise, keep a
connector-owned reference table in the development database.

For each collection, report one of these results in the plan:

- mapped;
- partly mapped;
- skipped because the application has no matching concept;
- blocked because a required dependency is missing.

Do not guess from a table name alone. Confirm meaning from models, services,
routes, tests, and product language.

Baseline seeding can use efficient ORM operations. Live delivery should use the
normal application command or service when its side effects matter.
