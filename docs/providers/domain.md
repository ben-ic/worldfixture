# World records API

The domain service serves complete records from the selected world. It includes
declared commerce, social, finance, support, work, and identity collections.
Nested fields and source record IDs remain in each record. An absent collection
is not added. A declared empty collection remains available with a count of zero.

Use the current run's `DOMAIN_BASE_URL` and `DOMAIN_TOKEN` bindings. Send the token
in the `Authorization: Bearer <DOMAIN_TOKEN>` header. The service credential does
not select a person for a write.

| Request | Result |
| --- | --- |
| `GET /v1/collections` | Collection names, current counts, and write permissions |
| `GET /v1/collections/:collection` | Complete records in one collection |
| `GET /v1/collections/:collection/:id` | One complete record |
| `POST /v1/collections/:collection` | Create a record with `{actor_id, record}` |
| `PATCH /v1/collections/:collection/:id` | Update fields with `{actor_id, patch}` |
| `DELETE /v1/collections/:collection/:id` | Delete a record with `{actor_id}` |
| `GET /v1/events` | Accepted changes in event order |

List requests accept `limit` and `cursor`. Responses contain `data`,
`total_count`, `has_more`, and `next_cursor`. Continue with `next_cursor` while
`has_more` is true. Do not infer an empty collection from a failed request.
Record and list responses identify the world ID, version, and artifact digest.

Writes require an explicit `actor_id` that names a person in the world. The API
checks required fields, types, references, and supported state values. It rejects
duplicate IDs and deletion of a referenced record. PATCH cannot change an ID.
Identity and finance collections are read-only. Collection metadata states which
other collections permit writes. An accepted write returns `{ok, record, event}`.

Changes apply to the domain service. They do not update the separate records
seeded into Stripe, Linear, Notion, or other providers. Provider writes also do not
update domain records. Metadata reports this scope with `write_scope` and
`provider_sync`. Cross-provider change capture requires a provider change-journal
contract and is outside the current implementation.

The service saves records and events in the run's state directory. A normal
restart retains accepted changes. A world reset restores the seed baseline.
The service refuses to reuse saved state from a different artifact.

The Workbench **World records** screen reads this API. It provides collection
selection, pages of records, full record details, and write controls for supported
collections. Select a person before a write. Workbench changes and scheduled
domain operations also enter the runtime command and event log, where causal
rules can create later actions on the world clock. Direct API writes enter the
domain event log; they do not automatically enter the runtime event log.
