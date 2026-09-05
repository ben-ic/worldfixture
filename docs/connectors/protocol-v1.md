# WorldFixture Connector v1

Connector v1 is a local HTTP contract between WorldFixture and a target
application. The connector can use an ORM, application services, factories, or
an internal API. It must preserve the application's existing domain rules.

The JSON Schemas in `schemas/connector-*.v1.schema.json` are authoritative for
request and response shapes. Every required field is named in this document as
well. `worldfixture connector check` validates each response against its schema
and reports missing fields by name.

## Discovery

WorldFixture sends an unauthenticated request:

```http
GET /.well-known/worldfixture
Accept: application/json
```

The response contains no secret or application data. `api_version`,
`application`, `capabilities` and `accepts` are all required, and `capabilities`
must give a boolean for every one of `plan`, `seed`, `event`, `status` and
`reset` -- declare the ones you do not support as `false` rather than omitting
them:

```json
{
  "api_version": "worldfixture.connector/v1",
  "application": {"id": "example-app", "name": "Example App"},
  "capabilities": {
    "plan": true,
    "seed": true,
    "event": true,
    "status": true,
    "reset": true
  },
  "accepts": ["identity", "work", "support"]
}
```

The standard authenticated endpoints are:

```text
POST /__worldfixture/plan
POST /__worldfixture/seed
POST /__worldfixture/events
GET  /__worldfixture/status
POST /__worldfixture/reset
```

Discovery can override these paths with an `endpoints` object. Each path must
start with `/` and stay on the application origin.

## Authentication

Every operation other than discovery requires:

```http
Authorization: Bearer <WORLDFIXTURE_TOKEN>
```

Return `401` when the header is missing or invalid. Follow all requirements in
`security.md`.

## Plan

Plan receives the same world envelope as seed. It validates the mapping but does
not change application state. Return `worldfixture.connector-plan/v1`. Every
field below is required:

```json
{
  "api_version": "worldfixture.connector-plan/v1",
  "summary": "Creates 22 users, 4 projects and 60 tasks",
  "mappings": [
    {"source": "identity.people", "target": "User", "status": "mapped"},
    {"source": "finance.invoices", "target": "", "status": "skipped",
     "reason": "this application has no billing model"}
  ],
  "counts": {"users": 22, "projects": 4, "tasks": 60},
  "warnings": []
}
```

`mappings` is named `mappings`, not `mapping`, and each entry needs `source`,
`target` and a `status` of `mapped`, `partial`, `skipped` or `blocked`. Use
`skipped` entries to report what will not be carried across, and `reason` to say
why. `counts` and `warnings` are required and may be empty.

The plan must identify required baseline dependencies. For example, a task
cannot arrive before its project and assignee exist.

## Seed

Seed receives canonical packs from the prepared artifact. The request has one
`idempotency_key` derived from the artifact identity. A connector must treat a
repeated key as the same operation and must not create duplicate records.
Connector implementations should accept at least 8 MiB for a local seed request
and can publish a larger limit in discovery.

Use application services when their side effects are part of the accepted
starting state. Use ORM bulk operations when they preserve application rules and
make large historical imports practical.

Return a `worldfixture.connector-receipt/v1`. `api_version`, `status`, `counts`
and `references` are all required:

```json
{
  "api_version": "worldfixture.connector-receipt/v1",
  "status": "applied",
  "idempotency_key": "seed:08b4b1f9…",
  "summary": "Created 22 users, 4 projects and 60 tasks",
  "counts": {"users": 22, "projects": 4, "tasks": 60},
  "references": [
    {"worldfixture_ref": "person/maya-chen", "application_ref": "user_01JABC"}
  ],
  "warnings": []
}
```

`status` is `applied` for work this request did, and `already_applied` when the
`idempotency_key` or `event_id` has been seen before. `references` is required
and may be empty, but a connector that returns none cannot receive live events
about the records it created. WorldFixture stores these references for later
event delivery.

## Live events

WorldFixture sends one event per request to `/__worldfixture/events`. Events use
`worldfixture.application-event/v1` and contain a stable `event_id`.

Delivery uses at-least-once semantics. Apply the event and record its `event_id`
in one transaction when possible. A repeated event returns `already_applied`.
Do not create the same business record twice.

An event can be scheduled by the world clock or delivered immediately by a user.
Immediate delivery changes delivery time, not `occurred_at` or event identity.

Use the application's normal service layer for live events when possible. This
lets notifications, audit records, and UI updates work as they do for real use.

## Status

Status returns `worldfixture.connector-status/v1`. `api_version`, `state` and
`receipts` are required:

```json
{
  "api_version": "worldfixture.connector-status/v1",
  "state": "seeded",
  "artifact_sha256": "08b4b1f9…",
  "receipts": []
}
```

`state` is one of `empty`, `planned`, `seeded`, `changed`, `resetting` or
`error`. It is a closed set, so do not invent a word for it.

It reports the connector state, the last accepted world artifact, and recent
receipts. It must not return the bearer token or application secrets.

## Reset

An application connector that writes to an app-owned database must declare
`reset: false`. It must not delete the application tenant or try to reverse
seeded records individually.

Normal `worldfixture reset` preserves database data, including data in a
WorldFixture-supplied database. A future destructive database rebuild must be
a separate, explicit service operation. The connector always declares
`reset: false` because it does not own the database lifecycle.

Never truncate an unknown, app-owned, or production database.

## Errors

Use a non-2xx status and a JSON body:

```json
{
  "error": {
    "code": "mapping_invalid",
    "message": "work.tasks.owner_id has no user mapping"
  }
}
```

Use `400` for invalid requests, `401` for a missing or invalid token, `409` for
a state conflict, `422` for an application mapping failure, and `500` for an
unexpected connector failure.

## Conformance

Run:

```sh
worldfixture connector check http://localhost:3000
```

The default check is read-only. It verifies discovery, authentication refusal,
planning, status, and that each response matches its published schema.
Application tests must also prove seed idempotency, event idempotency, reference
receipts, and reset behavior.

## How much of the world arrives

A seed or plan can carry a slice of the world rather than all of it, so that a
quick check does not have to import 3,069 emails. WorldFixture takes the slice;
a connector does not choose it and does not need to know how it was chosen.

A slice is always whole. It never contains a record that refers to a record it
does not contain, and it never empties a collection the world has records in. A
membership list such as `member_ids` is trimmed to the people who are present.
So a connector can treat a slice exactly as it treats a full world.

`options.scale` says what arrived:

```json
{
  "options": {
    "mode": "apply",
    "scale": {
      "preset": "smoke",
      "complete": false,
      "collections": [{"collection": "people", "sent": 26, "available": 161}]
    }
  }
}
```

A plan should report counts for what it was sent. When `complete` is `false`, say
so in the `summary` -- "22 of 161 people" rather than "22 people".

Each slice is its own seeding operation and carries its own `idempotency_key`.
Seeding a small slice and then a larger one is two operations, not a repeat, and
the second must apply the records the first did not carry.
