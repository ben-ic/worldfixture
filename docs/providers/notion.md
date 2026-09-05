# Notion provider support

Verification date: 2026-09-03

Overall status: **Supported and contract-tested** for the named inventories
below. This is not a claim for the complete Notion product.

WorldFixture implements this provider locally. [emulate.dev](https://emulate.dev/)
does not list a Notion emulator as of the verification date.

## What works

This page uses the five labels in the [support policy](./support-policy.md).
Public REST and Admin tests use official schemas and SDK types. They do not use
production request and response recordings. These surfaces are also **Not
verified against the production provider**. The hosted MCP `tools/list` capture
is the only production-provider recording.

| Surface | What works | What does not work or is not verified | Test proof |
| --- | --- | --- | --- |
| Public REST and OAuth | All 61 operations in the pinned public OpenAPI inventory; authorization, token refresh, introspection, and revocation | Other API versions; every possible error branch; multipart body schema validation | **Supported and contract-tested** by `notion-openapi-lifecycle.test.mjs` and the SDK tests |
| Public Agent API | All 13 methods in `@notionhq/client` 5.26.0 and their named branches | Deprecated alpha thread/chat and internal `external_agent_stub` routes | **Supported and contract-tested** by `notion-agent-branches.test.mjs` and `notion-agents.test.mjs` |
| Admin API | All 39 operations in the pinned Admin OpenAPI inventory | Other Admin API versions and uncaptured production behavior | **Supported and contract-tested** by `notion-admin-api.test.mjs` |
| Hosted MCP | Exact 41-tool Free Plan `tools/list`; every advertised local tool dispatches through shared world state | Hosted result-envelope parity; legacy SSE | Definitions are **Supported and contract-tested** by `hosted-contract.test.mjs`; results are **Not verified against the production provider** |
| Webhooks | 31 event schemas, HMAC signatures, and local delivery capture | External network delivery | **Supported and contract-tested** by `notion-webhooks.test.mjs` and `notion-admin.test.mjs` |
| Workers | Local deterministic adapter for `@notionhq/workers` 0.9.0 | Notion-hosted build, deployment, sandbox, secrets, logs, and remote commands | Local adapter is **Supported but partial** and tested by `notion-workers.test.mjs`; hosted behavior is **Not supported** |
| Workbench | Live Notion state and selected provider writes; private subscription and secret controls | Live Workers runtime view | Provider views use shared state; private controls are **Workbench-only**; Workers view is **Not supported** |

## What does not work

- Other Notion API versions are not covered.
- External webhook delivery does not work.
- Notion-hosted Workers build, deployment, and sandbox behavior do not work.
- Hosted MCP result envelopes are not verified.
- Production REST and Admin request and response recordings are not available.

<details>
<summary>Architecture, bindings, and world isolation</summary>

## Architecture

Every Notion surface goes through one domain layer:

```text
Notion REST routes ---+
                      +--> Notion domain services --> fixture state
Notion MCP tools -----+             |
                                    +--> change journal and runtime events
```

The MCP adapter does not read or write emulator storage directly. It calls the
same domain services as the REST routes, so a page created through MCP is
visible through REST and the Workbench, and a REST change is immediately visible
through MCP search and fetch. Anything that only one of the two surfaces could
see would be a bug in this arrangement rather than a feature of one protocol.

The provider carries no condition in the runtime resolver or the supervisor.
What it needs from a run is declared in its service manifest -- profile names,
bindings, ports and readiness checks -- like every other service.

## Configuration

The provider uses one HTTP listener.

```text
NOTION_BASE_URL=<resolved notion.pages-read.v1/base_url>
NOTION_TOKEN=<resolved notion.pages-read.v1/token>
NOTION_ADMIN_BASE_URL=<resolved notion.admin.v1/base_url>
NOTION_ADMIN_TOKEN=<resolved notion.admin.v1/token>
Notion-Version: 2026-03-11
Admin Notion-Version: 2026-06-01
MCP endpoint: ${NOTION_BASE_URL}/mcp
MCP protocol: 2025-11-25
```

The default world includes the Northstar Relay workspace. Its users, project
pages, document pages, comments, and uploaded files come from the same world
records as the other providers. A document file uses the same owner, bytes,
bucket, and object key as its S3 world record. A chat message becomes a Notion
comment only when its world entity reference identifies a Notion page.

### Multiworld isolation

Each prepared world artifact owns one complete Notion projection. When a
runtime selects a world, it replaces the fallback `notion` seed as one unit.
It does not deep merge pages, users, databases, data sources, or views from
another world.

Notion IDs are stable for repeated builds of one world. The world ID is part of
each generated Notion ID, so two worlds that use the same local record ID still
get different Notion IDs. Each world member also gets
`notion_token_<person-id>`. The shared `notion_token` remains for consumers that
do not select an actor. If a world has no Notion projection, the provider gets
an empty Notion fixture and no fallback Notion credentials.

</details>

## Quick start

For a REST client, set its API base URL to `NOTION_BASE_URL`, use
`Authorization: Bearer ${NOTION_TOKEN}`, and send
`Notion-Version: 2026-03-11`. For example:

```sh
curl -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2026-03-11" \
  "${NOTION_BASE_URL}/v1/users/me"
```

For an MCP client, set its remote-server URL to
`${NOTION_BASE_URL}/mcp`. The client must use OAuth discovery, dynamic client
registration, authorization code with PKCE S256, and the
`${NOTION_BASE_URL}/mcp` resource value. The server returns MCP `2025-11-25`
during negotiation.

<details>
<summary>Request headers, authentication, and protocol contracts</summary>

## Request contracts

| Surface | Authentication | Required request contract | Exact evidence | Known difference |
| --- | --- | --- | --- | --- |
| REST content API | `Authorization: Bearer <integration-or-public-OAuth-token>` with route capabilities | `Notion-Version: 2026-03-11`; JSON mutation routes use `Content-Type: application/json`; File Upload send routes use their upload body contract | `notion-openapi-lifecycle.test.mjs`, `notion-sdk-all-methods.test.mjs`, `notion-block-contract.test.mjs`, `notion-exhaustive-gaps.test.mjs` | All 61 success/header paths are green. Multipart upload is lifecycle-tested, but its request body is not JSON-schema validated. Not every documented error status is forced for every operation. |
| Public OAuth | Consent uses the registered client. Token, introspection, and revocation use HTTP Basic client credentials. Returned access tokens use bearer authentication on REST calls. | `/v1/oauth/authorize` uses query or form fields. `/v1/oauth/token`, `/v1/oauth/introspect`, and `/v1/oauth/revoke` require `Notion-Version: 2026-03-11` and JSON bodies. | `notion-admin.test.mjs`, `notion-openapi-lifecycle.test.mjs`, `notion-sdk-all-methods.test.mjs`; `@notionhq/client` 5.26.0 | Success schemas and SDK flows pass. Not every possible OAuth error response is forced. |
| MCP Streamable HTTP and MCP OAuth | OAuth bearer access token. A 401 response includes `WWW-Authenticate` with protected-resource metadata. | MCP POST requires `Content-Type: application/json` and `Accept: application/json, text/event-stream`. Initialization returns `2025-11-25`. A later explicit `MCP-Protocol-Version` must be `2025-11-25`. `Mcp-Session-Id` is optional and opaque; missing or unknown values are accepted. OAuth token exchange and refresh use `application/x-www-form-urlencoded`, PKCE S256, and the MCP resource value. | `hosted-contract.test.mjs`, `notion.test.mjs`, `mcp-content.test.mjs`, `mcp-write.test.mjs`, `mcp-agents.test.mjs` | Legacy SSE is unsupported. The server returns JSON responses and `GET /mcp` returns 405. The 41 `tools/list` objects are exact for the captured Free Plan profile. Exact hosted tool result envelopes are unverified. |
| Webhooks | Delivery has no bearer credential. The receiver verifies the per-subscription secret. The private local subscription control routes require a non-MCP REST bearer token. | Delivery body is JSON. `X-Notion-Signature` is `sha256=<HMAC-SHA256(raw-body, verification-token)>`. Verification uses the one-time token. | `notion-admin.test.mjs`, `notion-webhooks.test.mjs` | All 31 event schemas pass. Deliveries are signed and captured locally. External network delivery is disabled. |
| Public Agent API | REST bearer token with `interact:agents` capability | `Notion-Version: 2026-03-11`; JSON mutation bodies use `application/json`; the session stream response uses `text/event-stream` | `notion-agent-branches.test.mjs`, `notion-agents.test.mjs`; `@notionhq/client` 5.26.0 | Exhaustive documented Agent/session filter, event, lifecycle, access, pagination, and limit branches pass. Deprecated alpha thread/chat and internal `external_agent_stub` routes are unsupported. |
| Workers | The local runtime injects configured OAuth access tokens into the SDK environment. Webhook handlers receive the manifest-defined request. | No public provider-wide header contract exists. Database, sync, tool, OAuth, and webhook contracts come from the pinned `@notionhq/workers` 0.9.0 manifest. | `notion-workers.test.mjs` | This is a local deterministic adapter. It is not the Notion-hosted runtime. |
| Admin API | `Authorization: Bearer <organization-token>` with the operation-specific organization scope | `Notion-Version: 2026-06-01`; JSON mutations use `Content-Type: application/json` | `notion-admin-api.test.mjs`; vendored `admin-api-2026-06-01.openapi.json` | All 39 behavior and schema paths pass by default. An environment override can test another explicit snapshot. |

</details>

<details>
<summary>Exact REST, Agent, Admin, and Workers support</summary>

## Current REST support

Only `Notion-Version: 2026-03-11` is supported in the current profile.

Declared profiles:

- `notion.users.v1`
- `notion.oauth.v1`
- `notion.webhooks.v1`
- `notion.pages-read.v1`
- `notion.pages-write.v1`
- `notion.blocks-read.v1`
- `notion.blocks-write.v1`
- `notion.meeting-notes.v1`
- `notion.databases.v1`
- `notion.data-sources.v1`
- `notion.views.v1`
- `notion.custom-emojis.v1`
- `notion.async-tasks.v1`
- `notion.markdown.v1`
- `notion.comments.v1`
- `notion.file-uploads.v1`
- `notion.agents.v1`
- `notion.sessions.v1`
- `notion.admin.v1`

`notion.file-uploads.v1` selects `aws.s3.objects.v1` as a manifest dependency.
Clients see only Notion upload IDs and URLs. WorldFixture stores the bytes in
the selected world's S3 bucket and does not expose its bucket or object key in
Notion responses.

| Endpoint | Status | Contract evidence |
| --- | --- | --- |
| `GET /v1/users` | **Supported and contract-tested** | [`notion.test.mjs`](../../emulators/emulate/src/vendors/notion/notion.test.mjs) |
| `GET /v1/users/:user_id` | **Supported and contract-tested** | [`notion.test.mjs`](../../emulators/emulate/src/vendors/notion/notion.test.mjs) |
| `GET /v1/users/me` | **Supported and contract-tested** | [`notion.test.mjs`](../../emulators/emulate/src/vendors/notion/notion.test.mjs) |
| `POST /v1/search` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `GET /v1/pages/:page_id` | **Supported and contract-tested** | [`notion.test.mjs`](../../emulators/emulate/src/vendors/notion/notion.test.mjs) |
| `GET /v1/pages/:page_id/properties/:property_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `POST /v1/pages` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-content-rest.test.mjs`, `notion-sdk.test.mjs` |
| `PATCH /v1/pages/:page_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `POST /v1/pages/:page_id/move` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `GET`, `PATCH /v1/pages/:page_id/markdown` | **Supported but partial** | `notion-content-rest.test.mjs`; supports common Markdown blocks and update commands |
| `GET /v1/blocks/:block_id` | **Supported and contract-tested** | [`notion.test.mjs`](../../emulators/emulate/src/vendors/notion/notion.test.mjs) |
| `GET /v1/blocks/:block_id/children` | **Supported and contract-tested** | [`notion.test.mjs`](../../emulators/emulate/src/vendors/notion/notion.test.mjs) |
| `PATCH /v1/blocks/:block_id/children` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `PATCH /v1/blocks/:block_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `DELETE /v1/blocks/:block_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `POST /v1/blocks/meeting_notes` | **Supported and contract-tested** | `notion-sdk.test.mjs` |
| `POST /v1/blocks/meeting_notes/query` | **Supported and contract-tested** | `notion-sdk.test.mjs` |
| `POST /v1/databases` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `GET`, `PATCH /v1/databases/:database_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `POST /v1/data_sources` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `GET`, `PATCH /v1/data_sources/:data_source_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `GET /v1/data_sources/:data_source_id/templates` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `POST /v1/data_sources/:data_source_id/query` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `POST`, `GET /v1/views` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `GET`, `PATCH`, `DELETE /v1/views/:view_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `POST /v1/views/:view_id/queries` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `GET`, `DELETE /v1/views/:view_id/queries/:query_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `GET /v1/custom_emojis` | **Supported and contract-tested** | `notion-rest-write.test.mjs`, `notion-sdk.test.mjs` |
| `GET /v1/async_tasks/:task_id` | **Supported and contract-tested** | `notion-rest-write.test.mjs` |
| `POST`, `GET /v1/comments` | **Supported and contract-tested** | `notion-content-rest.test.mjs` |
| `GET`, `PATCH`, `DELETE /v1/comments/:comment_id` | **Supported and contract-tested** | `notion-content-rest.test.mjs` |
| `POST`, `GET /v1/file_uploads` | **Supported and contract-tested** | `notion-content-rest.test.mjs` |
| `GET /v1/file_uploads/:file_upload_id` | **Supported and contract-tested** | `notion-content-rest.test.mjs` |
| `POST /v1/file_uploads/:file_upload_id/send` | **Supported and contract-tested** | `notion-s3-upload.test.mjs`, `runtime/src/supervisor.test.mjs` |
| `POST /v1/file_uploads/:file_upload_id/complete` | **Supported and contract-tested** | `notion-s3-upload.test.mjs` |
| `GET`, `POST /v1/oauth/authorize` | **Supported and contract-tested** | `notion-admin.test.mjs` |
| `POST /v1/oauth/token` | **Supported and contract-tested** | `notion-admin.test.mjs`, `notion-openapi-lifecycle.test.mjs` |
| `POST /v1/oauth/introspect` | **Supported and contract-tested** | `notion-admin.test.mjs`; official SDK 5.26.0 |
| `POST /v1/oauth/revoke` | **Supported and contract-tested** | `notion-admin.test.mjs` |
| Older `Notion-Version` values | **Not supported** | Use a future separate profile |

The provider rejects an absent or different `Notion-Version`. It rejects an
unknown token. An MCP access token cannot call the REST API.

Webhook subscriptions are created and verified through the private
`/__worldfixture/notion-admin` surface because Notion manages subscriptions in
connection settings rather than through its public REST API. The emulator
creates current event payloads and HMAC-SHA256 signatures. It captures delivery
records locally. It does not send world data to an external URL unless that
network action is enabled explicitly in a future delivery mode.

The subscription validator accepts 31 current event names: eight page events,
six database events, six data-source events, three comment events, four File
Upload events, one transcript-deletion event, and three view events.
Implemented mutations emit the matching current event, including lock,
unlock, trash, restore, move, schema, content, and comment transitions. Event
payloads include the current common fields, `api_version: "2026-03-11"`, UUID
identifiers, the world workspace, integration, author, accessibility, entity,
and event-specific `data`. Evidence: `notion-admin.test.mjs`.

### Public Agent API

The provider implements the 13 Agent/session methods exposed by
`@notionhq/client` 5.26.0:
agent query, retrieve, insights, status update, credit-limit update, delete, and
batch; session update, retrieve, query, stream, event query, and cancel.
The 12 HTTP routes use the same world-backed Agents, sessions, events,
identities, permissions, and clock as MCP and the Workbench. The exhaustive
branch test covers favorite filters, all documented Agent/session/event
filters and operators, sorting, pagination, event variants, approval and
continue flows, terminal conflicts, batch actions, access, and documented
limits. Evidence: `notion-agent-branches.test.mjs` and
`notion-agents.test.mjs`.

Deprecated alpha thread/chat routes and the SDK's internal
`external_agent_stub` routes are not supported.

### Admin API

All 39 operations in the official Admin OpenAPI snapshot are implemented under
`/admin/v1` with `Notion-Version: 2026-06-01`. They require the separate
organization token and operation-specific scopes.

| Official operation group | Operations | Status and evidence |
| --- | ---: | --- |
| Legal holds, users, workspaces, pages, release, and export | 11 | **Supported and contract-tested** in `notion-admin-api.test.mjs` |
| Workspace export and managed-user session revocation | 3 | **Supported and contract-tested** |
| MCP client connection listing, policy, and revocation | 3 | **Supported and contract-tested** |
| Workspace users | 1 | **Supported and contract-tested** |
| Permission groups and direct memberships | 9 | **Supported and contract-tested** behavior and default official OpenAPI validation |
| Personal access token listing and revocation | 2 | **Supported and contract-tested** |
| Agent governance, permissions, credit use, limits, policy, status, and delete | 10 | **Supported and contract-tested** behavior and default official OpenAPI validation |

The executable test also asserts that it calls 39 unique official operation
IDs. It validates every successful request and response against the vendored
official schema during a normal run. `NOTION_ADMIN_OPENAPI` is an optional
override for a different explicit snapshot, not a switch that enables schema
validation.

### Workers

`@notionhq/workers` 0.9.0 is supported as a local deterministic runtime
adapter. It reads the real SDK manifest and supports managed and attached
database declarations, pacers, replace and incremental sync, tools, webhook
ingress and verification, retries, blocking, and OAuth token injection.
Evidence: `notion-workers.test.mjs`.

Notion-hosted build, deployment, sandbox, public webhook URL, remote `ntn`
commands, managed migration, encrypted secret storage, and hosted log behavior
are not emulated. Workers do not add public Notion REST routes.

</details>

<details>
<summary>Exact MCP tools and production capture</summary>

## MCP development status

The exact hosted Free Plan `tools/list` profile is pinned for MCP `2025-11-25`
over Streamable HTTP. Legacy SSE is not supported. Tool result parity remains
partial because the safe hosted capture did not call workspace tools.
After OAuth capture, normalize the raw response with:

```sh
node runtime/bin/normalize-mcp-tools.mjs \
  --input /path/to/notion-tools-list.json \
  --provider notion \
  --endpoint https://mcp.notion.com/mcp \
  --captured-at YYYY-MM-DD \
  --client worldfixture-capture \
  --client-version 1+mcp-remote-0.1.38 \
  --protocol-version 2025-11-25 \
  --plan PLAN \
  --output emulators/emulate/contracts/notion/hosted-mcp-tools-PLAN-YYYY-MM-DD.json
```

Store the normalized result, its SHA-256 digest, and the exact client and plan
in `emulators/emulate/contracts/notion/`. Never store the OAuth grant.

Current normalized capture:

- file: `hosted-mcp-tools-free-2026-09-03.json`
- SHA-256: `5f417aa0b77a168737d4c680733c2492dee57583fb8909ecdaefed223c8cf8bc`
- client: `worldfixture-capture` through `mcp-remote` 0.1.38
- account: Free Plan
- request boundary: `initialize`, `notifications/initialized`, and `tools/list`

| Capability | Status | Contract evidence |
| --- | --- | --- |
| OAuth Protected Resource Metadata | Implemented, hosted-schema parity unverified | `notion.test.mjs` |
| OAuth Authorization Server Metadata | Implemented, hosted-schema parity unverified | `notion.test.mjs` |
| Dynamic client registration | Implemented, hosted-schema parity unverified | `notion.test.mjs` |
| Authorization Code with PKCE S256 | Implemented, hosted-schema parity unverified | `notion.test.mjs` |
| Refresh-token rotation | Implemented, hosted-schema parity unverified | `notion.test.mjs` |
| `initialize` for MCP `2025-11-25` | Implemented; an unsupported requested version negotiates to `2025-11-25` | `notion.test.mjs` |
| `notifications/initialized` | Implemented, hosted-schema parity unverified | Protocol route contract |
| `ping` | Implemented, hosted-schema parity unverified | Protocol route contract |
| `tools/list` | Exact 41-tool Free Plan capture; no client-specific aliases | `hosted-contract.test.mjs`, `notion.test.mjs` |
| `tools/call` | All advertised names dispatch; exact hosted result envelopes remain unverified | `notion.test.mjs`, `mcp-write.test.mjs`, `mcp-content.test.mjs`, `mcp-agents.test.mjs` |
| `notion-search` | Implemented and advertised to normal MCP clients | `notion.test.mjs` |
| `notion-fetch` | Implemented and advertised to normal MCP clients | `notion.test.mjs` |
| OpenAI `search` and `fetch` aliases | **Not verified against the production provider**; official documentation describes client-specific aliases, but the capture did not use an OpenAI client | `hosted-contract.test.mjs`, `notion.test.mjs` |
| `notion-search-skills` | Implemented for accessible Skill pages | `notion.test.mjs` |
| `notion-create-file-upload` | Implemented | `mcp-content.test.mjs` |
| `notion-create-attachment` | Implemented; inline text uses S3, and external URLs and completed upload references are supported | `mcp-content.test.mjs`, `notion-s3-upload.test.mjs` |
| `notion-download-attachment` | Implemented for UTF-8 text up to 200 KiB | `mcp-content.test.mjs`, `notion-s3-upload.test.mjs` |
| `notion-create-pages` | Implemented, including `allow_async` | `mcp-write.test.mjs` |
| `notion-update-page` | Implemented, including `allow_async` | `mcp-write.test.mjs` |
| `notion-convert-page-to-skill` | Implemented | `notion.test.mjs` |
| `notion-move-pages` | Implemented | `mcp-write.test.mjs` |
| `notion-duplicate-page` | Implemented as an async task | `mcp-write.test.mjs` |
| `notion-create-database` | Implemented | `mcp-write.test.mjs` |
| `notion-create-folder` | Implemented | `mcp-write.test.mjs` |
| `notion-update-folder` | Implemented for file add, file remove, and nested Folder creation | `mcp-write.test.mjs` |
| `notion-update-data-source` | Implemented | `mcp-write.test.mjs` |
| `notion-create-view` | Implemented for direct data-source views | `mcp-write.test.mjs` |
| `notion-update-view` | Implemented | `mcp-write.test.mjs` |
| `notion-query-data-sources` | Rows, view, and read-only SQLite query modes implemented | `mcp-write.test.mjs` |
| `notion-query-multiple-data-sources` | Read-only SQLite SELECT and WITH queries support JOIN, UNION, filters, parameters, and aggregates on shared data-source state; hosted result-envelope parity is unverified | `mcp-write.test.mjs` |
| `notion-list-private-pages` | Implemented with cursor pagination | `mcp-write.test.mjs` |
| `notion-list-shared-pages` | Implemented with cursor pagination | `mcp-write.test.mjs` |
| `notion-list-favorite-pages` | Implemented with cursor pagination | `mcp-write.test.mjs` |
| `notion-list-recent-pages` | Implemented with recency order and cursor pagination | `mcp-write.test.mjs` |
| `notion-query-meeting-notes` | Implemented with attendee access | `notion.test.mjs`, `notion-sdk.test.mjs` |
| `notion-search-agents` | Implemented over the shared Agent store | `mcp-agents.test.mjs` |
| `notion-query-sessions` | Implemented with filters, sorts, and pagination | `mcp-agents.test.mjs` |
| `notion-search-sessions` | Implemented over current shared session state | `mcp-agents.test.mjs` |
| `notion-spawn-session` | Implemented; creates an in-progress shared REST session | `mcp-agents.test.mjs` |
| `notion-get-session-status` | Implemented | `mcp-agents.test.mjs` |
| `notion-wait-session` | Implemented with deterministic fixture completion | `mcp-agents.test.mjs` |
| `notion-stop-session` | Implemented with a terminal canceled state | `mcp-agents.test.mjs` |
| `notion-send-message-to-session` | Implemented; continues the shared session | `mcp-agents.test.mjs` |
| `notion-list-session-events` | Implemented with pagination | `mcp-agents.test.mjs` |
| `notion-read-session-event` | Implemented | `mcp-agents.test.mjs` |
| `notion-create-comment` | Implemented | `mcp-content.test.mjs` |
| `notion-get-comments` | Implemented | `mcp-content.test.mjs` |
| `notion-get-teams` | Implemented with membership state | `notion.test.mjs` |
| `notion-get-users` | Implemented with ID, name, email, and `self` lookup | `notion.test.mjs` |
| `notion-get-async-task` | Implemented | `mcp-write.test.mjs` |
| `notion-show-advanced-analysis-next-steps` | Implemented with the captured output schema and UI metadata | `hosted-contract.test.mjs`, `mcp-write.test.mjs` |
| `notion-check-mcp-next-steps` | Implemented with the captured output schema and UI metadata | `hosted-contract.test.mjs`, `mcp-write.test.mjs` |

The authenticated hosted capture contains 41 tools on the verification date.
WorldFixture advertises those exact 41 tool definitions. It does not advertise
the old local-only `notion-get-self`, `notion-list-agents`, `search`, or `fetch`
names. Use `notion-fetch` with `id: "self"` for connection identity. Exact hosted
tool result compatibility remains unclaimed.

</details>

## Official SDK compatibility

`notion-sdk-all-methods.test.mjs` asserts the exact 63-method public surface of
`@notionhq/client` 5.26.0 and runs every applicable method through a real
emulator lifecycle. The focused SDK, Agent, and Admin tests add branch and
schema evidence. This is an exact tested SDK version. It is not a claim for all
past or future SDK versions.

<details>
<summary>Schema evidence and known differences</summary>

## Response-shape evidence

| Surface | Realism source | Current result |
| --- | --- | --- |
| REST content API | Vendored official `2026-03-11` public OpenAPI, SHA-256 `1542bad104f5ca9f559e34400a9206fdb672a98f5a7a9e6ae01f1a3c81655888`, and `@notionhq/client` 5.26.0 | All 61 success/header operation paths and the exact 63-method SDK lifecycle pass. Block tests cover all 31 request and 36 response branches. Exhaustive template, view, emoji, meeting-note, and MCP identity branches pass. Multipart request encoding is lifecycle-tested, but it is not JSON-schema validated. |
| Public Agent API | Public OpenAPI and generated types in `@notionhq/client` 5.26.0 | All 13 SDK methods and exhaustive Agent/session branches pass |
| Admin API | Vendored official Admin OpenAPI, SHA-256 `3379d21cf33cad65a5fe9719ebfaf66cc884bf26de6745e9bd542171a419a772` | All 39 operations pass behavior and default request/response schema validation. |
| Workers | Real `@notionhq/workers` 0.9.0 manifest and validation builders | Nine runtime contract tests pass |
| Webhooks | Official current event list, common payload fields, and HMAC-SHA256 rules | Current names, fields, signatures, and state transitions pass; external delivery is disabled |
| Hosted MCP | Authenticated normalized 41-tool Free Plan capture and MCP `2025-11-25` | Exact `tools/list` JSON objects pass. Behavior dispatch is implemented. Exact hosted result envelopes are unverified. |

## Known differences

- Search uses deterministic fixture ranking. It does not reproduce Notion AI
  ranking or connected-source search.
- The exact hosted input schemas are pinned from the authenticated `tools/list`
  capture. Exact hosted result envelopes are not captured.
- Advanced search sorting and plan-gated filter variants remain unclaimed.
- Enhanced Markdown parsing supports common blocks. Large-page MCP truncation
  and every hosted Markdown conversion edge case remain unclaimed.
- External URL File Upload imports keep the external reference. They do not
  copy remote bytes into the world S3 service.
- Multipart upload request encoding has a real SDK lifecycle test. The
  multipart request body is not validated as a JSON schema.
- The OpenAPI lifecycle forces success and required header contracts. It does
  not force every possible documented error status on every operation.
- CIMD and the JWT-bearer grant are not implemented. Codex and Claude can use
  dynamic client registration.
- `notion-wait-session` settles a deterministic fixture response; it does not
  run a model. Session search reads current state and does not add hosted search
  indexing delay.
- The Workbench shows pages, databases, data sources, views, comments, File
  Upload metadata, users, Agents, Agent sessions, async tasks, mutations, MCP
  sessions, MCP calls, OAuth tokens, webhooks, and Admin governance. It does
  not expose internal S3 keys.
- General Workbench responses redact webhook verification tokens and full
  signatures. Set `WORLDFIXTURE_WORKBENCH_REVEAL_WEBHOOK_SECRETS=1` only in a
  trusted development run to enable explicit Reveal controls. The reveal
  response contains one selected verification token or one selected captured
  request, and it uses `Cache-Control: no-store`. The default product image
  sets the value to `0`.
- Webhook delivery is signed and captured locally. External delivery is
  disabled so world data cannot leave the local system.
- Link preview blocks can be returned when present in fixture content. Notion
  documents them as read-only; create and append are not applicable.

</details>

## Source evidence

- [Notion documentation index](https://developers.notion.com/llms.txt)
- [Notion API versioning](https://developers.notion.com/reference/versioning)
- [Notion changelog](https://developers.notion.com/page/changelog)
- [Notion page Markdown](https://developers.notion.com/reference/retrieve-page-markdown)
- [Notion comments](https://developers.notion.com/guides/data-apis/working-with-comments)
- [Notion File Uploads](https://developers.notion.com/reference/create-file)
- [Notion MCP overview](https://developers.notion.com/guides/mcp/overview)
- [Notion MCP client guide](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Notion MCP supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
