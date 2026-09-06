# MongoDB Atlas

## What works

WorldFixture supports selected Atlas Admin resources. It also keeps a small
local form of the retired Atlas Data API v1 for old tests. Support label:
**Supported but partial**.

## What does not work

Production authentication, API version negotiation, project update,
database-user update, private endpoints, network access, backups, alerts,
events, logs, search, billing, and unlisted Atlas APIs do not work. Atlas
events and webhooks do not work. The local Data API does not support the full
MongoDB query or aggregation language. These operations are **Not supported**.
Production behavior, Atlas CLI, official SDKs, and MongoDB drivers are
**Not verified against the production provider**.

## Connect

Use `MONGOATLAS_BASE_URL`. WorldFixture also generates `MONGOATLAS_TOKEN`,
but local routes do not validate it. Production Atlas Admin uses service-account
OAuth or HTTP Digest and a versioned `Accept` header. The local API does not
apply these contracts.

WorldFixture uses `@emulators/mongoatlas` 0.10.0 and a WorldFixture project
seed correction.

## Admin route reference

Create and update calls use JSON. List responses use Atlas-like `links`,
`results`, and `totalCount` fields.

| Resource | Exact methods and paths | Output | Proof |
| --- | --- | --- | --- |
| Projects | `GET, POST /api/atlas/v2/groups`<br>`GET, DELETE /api/atlas/v2/groups/:groupId` | Project list, project object, or delete result | Registered route source |
| Clusters | `GET, POST /api/atlas/v2/groups/:groupId/clusters`<br>`GET, PATCH, DELETE /api/atlas/v2/groups/:groupId/clusters/:clusterName` | Cluster list, object, or delete result | Registered route source |
| Database users | `GET, POST /api/atlas/v2/groups/:groupId/databaseUsers`<br>`GET, DELETE /api/atlas/v2/groups/:groupId/databaseUsers/admin/:username` | User list, object, or delete result | Registered route source |
| Databases | `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases` | Seeded database list | Registered route source |
| Collections | `GET /api/atlas/v2/groups/:groupId/clusters/:clusterName/databases/:databaseName/collections` | Seeded collection list | Registered route source |

Project objects include local `id`, `name`, `orgId`, cluster count, links,
and timestamps. Cluster objects include name, group ID, provider settings,
state, connection strings, and timestamps.

## Retired Data API reference

Each route is `POST /app/data-api/v1/action/OPERATION`. The body uses JSON.

| Operation | Input | Output | Proof |
| --- | --- | --- | --- |
| `findOne` | Data source, database, collection, filter, projection | `document` | Registered route source |
| `find` | Data source, database, collection, filter, projection, sort, skip, limit | `documents` | Registered route source |
| `insertOne` | Data source, database, collection, document | `insertedId` | Registered route source |
| `insertMany` | Data source, database, collection, documents | `insertedIds` | Registered route source |
| `updateOne`, `updateMany` | Filter, local update subset, optional upsert | Matched and modified counts; optional upsert ID | Registered route source |
| `deleteOne`, `deleteMany` | Data source, database, collection, filter | `deletedCount` | Registered route source |
| `aggregate` | Small local pipeline subset | `documents` | Registered route source |

Atlas App Services reached end of life in September 2025. Use these Data API
routes only for an old test that still needs them. Do not use them for a new
production integration.

## State, reset, Workbench, and proof

Admin and Data API writes change one store. The Workbench reads projects,
clusters, database users, databases, and collections through live Admin routes.
It has no Atlas write control. Reset restarts and reseeds the store. Stop does
not preserve this state.

Implementation: emulate.dev. The composer seeds the selected world without
the provider's sample seed hook. The test in
`emulators/emulate/src/main.test.mjs` reads declared projects, clusters, and
database users through live Admin routes. It also verifies that a world can
declare a project named `Project0`. Compiler tests cover the projection.
These local tests do not prove production Atlas parity. No SDK, driver, or CLI
version has a WorldFixture test.

Provider authority: [MongoDB Atlas Administration API](https://www.mongodb.com/docs/atlas/api/) and
[Atlas App Services end of life](https://www.mongodb.com/docs/atlas/app-services/).
