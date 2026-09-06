# Domain API

The domain service reads `projections/domain.json` from the explicitly selected world artifact. It verifies the artifact identity and file digests before it creates state. There is no default world or sample credential.

The service stores full records and accepted events in `<WORLDFIXTURE_STATE_PATH>/domain/state.sqlite`. A normal process restart keeps changes. The supervisor stops the service before it restores the `domain` baseline directory. A different artifact cannot reuse an existing database.

## Ownership

`commerce.products`, `commerce.orders`, `social.posts`, `social.reviews`, `social.comments`, `work.projects`, `work.tasks`, `work.time_entries`, and `support.cases` support domain writes. The world must declare a collection before an application can write to it.

These writes affect the domain service only. They do not change seeded Linear, Stripe, Notion, or other provider records. Provider writes do not change domain records. Collection metadata states `owner: "domain"`, `write_scope: "domain-only"`, and `provider_sync: false`. Accepted events record this scope.

Identity, finance, provider-specific, and unknown collections are read-only canonical seed views. Finance amounts and settlement records are preserved exactly. An order write does not create an invoice, payment, refund, or ledger entry. Use the relevant provider API for provider state.

## Launch contract

The service manifest provides `domain.collections.v1`, `domain.commerce.v1`, `domain.social.v1`, `domain.finance.v1`, `domain.work.v1`, and `domain.support.v1`. All use the `http` port, normally 4717.

The runtime supplies:

- `WORLDFIXTURE_WORLD_PATH`: selected artifact directory.
- `WORLDFIXTURE_WORLD_SHA256`: expected artifact digest.
- `WORLDFIXTURE_STATE_PATH`: private instance state directory.
- `DOMAIN_TOKEN`: generated credential from `domain.token`.
- `WORLDFIXTURE_DOMAIN_LISTEN`: listener address as `host:port`.

The application bindings are `DOMAIN_BASE_URL` and `DOMAIN_TOKEN`. Start with `node src/server.mjs` from this directory.

## API contract

Every `/v1` request requires `Authorization: Bearer <DOMAIN_TOKEN>`. `GET /readyz` is an unauthenticated readiness check. It reports the verified world identity and artifact digest.

| Request | Result |
| --- | --- |
| `GET /v1/collections` | Collection metadata: `name`, `count`, `writable`, `id_field`, `owner`, `write_scope`, `provider_sync`. |
| `GET /v1/collections/:collection` | Full canonical records. Nested fields and references are preserved. |
| `GET /v1/collections/:collection/:id` | `{record, version, world}`. |
| `POST /v1/collections/:collection` | Create from `{actor_id, record}`. The caller supplies a unique canonical `record.id`. |
| `PATCH /v1/collections/:collection/:id` | Update from `{actor_id, patch, expected_version?}`. Patch fields replace the corresponding top-level fields. Other fields remain unchanged. `id` cannot change. |
| `DELETE /v1/collections/:collection/:id` | Delete with JSON body `{actor_id, expected_version?}`. References prevent deletion. |
| `POST /v1/collections/:collection/validate` | Validate a proposed create with `{actor_id, record}`. No records or events change. |
| `GET /v1/events` | Accepted events in sequence order. |

Metadata, record lists, and event lists return `{data, total_count, has_more, next_cursor, world}`. `world` is `{id, version, artifact_sha256}`. `total_count` is the actual collection size, including records before the cursor. `limit` is an integer from 1 through 1000 and defaults to 100. Cursors are signed, scoped to the selected collection and artifact, and opaque to clients. Record and metadata cursors reject concurrent changes with `409 stale_cursor`; restart the read. Event cursors can continue through later accepted writes because events are append-only.

Writes require an explicit `actor_id` from `identity.people`. The service credential does not name or invent a person. A world without people can be read but cannot accept these authored writes. Work task status names can use the world's vocabulary.

Writes validate field types, required fields, referenced records, dates, currency agreement, and order arithmetic. Amounts are integer currency minor units; the service does not assume USD or two decimal places. `subtotal_cents` must equal the sum of each quantity times its unit amount. `total_cents` must equal subtotal plus shipping minus discount. Product prices can change without rewriting historical order unit amounts. A product currency change cannot invalidate an existing order.

An accepted write returns `{ok: true, record, version, event, world}`. A delete returns `record: null`. The event uses `worldfixture.domain-event/v1`, carries explicit actor and artifact provenance, and includes full `before` and `after` records. Event types are `domain.record.created.v1`, `domain.record.updated.v1`, and `domain.record.deleted.v1`. Creation of `commerce.orders` uses `commerce.order.placed.v1`. Record changes and their event commit in one SQLite transaction. Rejected writes change neither.

Errors return `{ok: false, error: {code, message, field?}}`. Validation is HTTP 400, missing or incorrect credentials 401, read-only collections 403, missing records or collections 404, unsupported methods 405, conflicts 409, oversized requests 413, and unsupported content types 415. Request bodies are limited to 1 MiB. A duplicate record ID is a conflict. A stale `expected_version` is a conflict. Failed writes emit no accepted event.

## Tests

Run `node --test emulators/domain/src/*.test.mjs` from the repository root. The tests use temporary artifacts, isolated loopback listeners, and private SQLite state. No shared artifact or database is changed.
