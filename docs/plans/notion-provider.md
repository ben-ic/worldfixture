# Notion provider implementation plan

Status: implementation is at the contract-correction, documentation, and
release-verification gate. REST, OAuth, Agent API, Admin API behavior, Workers,
31 webhook events, S3-backed File Uploads, and Workbench views are implemented.
The vendored public and Admin OpenAPI gates are green. Exact hosted MCP
`tools/list` parity is verified for the captured 41-tool Free Plan profile.
Exact hosted tool result envelopes and hosted-only Workers behavior remain
unsupported.

This plan adds Notion as the first new WorldFixture provider. It includes the
Notion REST API and the hosted Notion MCP server protocol. Both surfaces use the
same world state, identities, permissions, clock, and change journal.

## Goals

- Run existing Notion applications and agentic applications against a local,
  reproducible Notion world.
- Support the selected stable Notion REST API versions.
- Support the pinned official Notion MCP tool inventory through a remote MCP
  server.
- Reproduce OAuth, authorization, permissions, validation, pagination, errors,
  rate limits, and observable state changes that affect application behavior.
- Show Notion data, API requests, MCP sessions, and changes in the Workbench.
- Publish exact support and non-support statements. Do not use a general
  "Notion compatible" claim.
- Build reusable provider infrastructure so a later provider needs mostly a
  manifest, fixtures, protocol adapters, and contract evidence.

## Compatibility profiles

The implemented surfaces declare these tested profiles:

- `notion.users.v1`
- `notion.pages-read.v1`
- `notion.pages-write.v1`
- `notion.blocks-read.v1`
- `notion.blocks-write.v1`
- `notion.databases.v1`
- `notion.data-sources.v1`
- `notion.views.v1`
- `notion.async-tasks.v1`
- `notion.markdown.v1`
- `notion.comments.v1`
- `notion.file-uploads.v1`
- `notion.oauth.v1`
- `notion.webhooks.v1`
- `notion.meeting-notes.v1`
- `notion.agents.v1`
- `notion.sessions.v1`
- `notion.admin.v1`

The exact hosted MCP `tools/list` profile is declared for the authenticated
41-tool Free Plan capture with MCP `2025-11-25`. Notion does not publish its
complete hosted JSON Schemas, so the normalized capture is the pinned contract.
Tool result parity remains a separate partial profile.

Add a full REST, OAuth, or MCP profile only after its complete pinned inventory
passes contract tests. The support matrix gives the exact `Notion-Version`,
endpoints, MCP tools, and verification date for each profile.

Use these status terms in the plan, provider document, manifest, and
Workbench:

- **Supported**: the named behavior has a passing contract test against its
  stated version and evidence source.
- **Partial**: useful behavior exists, but a named branch, schema, or release
  gate is not verified.
- **Unsupported**: the named behavior is not implemented.

Current audited gaps are explicit:

- The public 61-operation success and required-header lifecycle is green
  against `public-api-2026-03-11.openapi.json`, SHA-256
  `1542bad104f5ca9f559e34400a9206fdb672a98f5a7a9e6ae01f1a3c81655888`.
  Multipart upload requests pass lifecycle tests, but their multipart bodies
  are not JSON-schema validated. The suite does not force every possible
  documented error status on every operation.
- The exact 63-method `@notionhq/client` 5.26.0 public lifecycle is green.
  Block coverage includes all 31 request and 36 response branches. Exhaustive
  templates, views, custom emoji, meeting notes, MCP identities, and
  Agent/session branches are green.
- Admin behavior and official schema validation cover all 39 operations by
  default against `admin-api-2026-06-01.openapi.json`, SHA-256
  `3379d21cf33cad65a5fe9719ebfaf66cc884bf26de6745e9bd542171a419a772`.
- All 31 current webhook event schemas are green.
- Hosted MCP `tools/list` parity is green for all 41 captured tools. Tool result
  parity is partial because no workspace content tools were called during the
  safe hosted capture.
- The local Workers adapter is tested. Notion-hosted build, deployment,
  sandbox, public webhook URL, remote command, secret-storage, and log behavior
  remain unsupported.

The profile names can change during implementation if the existing profile
naming rules require more precision. A profile must always map to contract
tests.

## Source policy

Use APIs.guru only to find a starting OpenAPI description. Treat the current
official Notion documentation as the source of truth. Record the source URL,
retrieval date, API version, MCP protocol version, and evidence for each claim.

Primary sources:

- [Notion API reference](https://developers.notion.com/reference/intro)
- [Notion API versioning](https://developers.notion.com/reference/versioning)
- [Notion authorization](https://developers.notion.com/docs/authorization)
- [Notion MCP overview](https://developers.notion.com/guides/mcp/overview)
- [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)
- [Notion MCP supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest)

Check emulate.dev before implementation and at the release gate. Record what
it supports, what it does not support, and the verification date. Do not infer
Notion coverage from support for a different provider.

## Architecture

Use one provider domain layer for all Notion surfaces:

```text
Notion REST routes ---+
                      +--> Notion domain services --> fixture state
Notion MCP tools -----+             |
                                    +--> change journal and runtime events
```

The MCP adapter must not read or write emulator storage directly. It calls the
same domain services as the REST routes. Thus, a page created through MCP is
visible through REST and the Workbench. A REST change is immediately visible
through MCP search and fetch.

Keep provider code behind the existing service and profile contracts. Do not
add a Notion condition to the runtime resolver or supervisor when the service
manifest can describe the behavior.

Use a provider manifest for declarative facts:

- profile names and bindings;
- ports and transports;
- routes and tool inventory;
- authentication modes and scopes;
- fixture projection requirements;
- Workbench resource and action descriptors;
- support status and evidence links.

Use code for behavior that a manifest cannot safely express:

- Notion validation and object rules;
- permission inheritance and content grants;
- search ranking and filtering;
- state transitions and side effects;
- OAuth protocol behavior;
- MCP protocol handling and tool execution.

The first provider will establish the manifest boundary. Do not make the
manifest a programming language.

## World model and fixtures

Extend the business world with a coherent Notion projection. Reuse the same
people, teams, projects, customers, dates, and story events that appear in
mail, Slack, GitHub, and other providers.

The projection must cover:

- workspace and bot identity;
- users and guests;
- teamspaces and permission boundaries;
- pages and nested blocks;
- databases and data sources for each selected API version;
- properties with representative Notion types;
- comments and discussions;
- files and file-upload state;
- archived and deleted content;
- connected-source search results only when that behavior is in the supported
  MCP profile;
- stable identifiers, timestamps, cursors, and version-specific shapes.

Add scenarios for permitted access, hidden content, read-only content,
conflicts, archived objects, invalid parents, pagination, expired cursors,
rate limits, and asynchronous work.

Treat a compiled world as the isolation boundary. A selected world's Notion
projection replaces the complete demo projection. It must never deep merge
provider records from two worlds. Include the world ID in derived provider IDs,
and issue actor-specific fixture credentials from that world's people. Test a
world with Notion, a second world with overlapping source record IDs, and a
world with no Notion projection.

## REST API work

1. Build an endpoint inventory from each selected official API version.
2. Classify every endpoint as supported, partial, unsupported, or not
   applicable.
3. Implement identity, users, search, pages, blocks, databases, data sources,
   comments, files, and other stable endpoint groups in dependency order.
4. Match request validation, response shape, headers, pagination, error shape,
   status code, permissions, and relevant rate-limit behavior.
5. Keep version adapters thin. They translate version-specific wire shapes to
   and from the shared domain model.
6. Test common official SDK operations against the local base URL.

## OAuth and authorization work

Implement the user-visible Notion authorization flow. Include authorization,
consent, code exchange, token refresh where the official flow supports it,
revocation, invalid and expired grants, workspace selection, bot identity, and
content access.

REST integration tokens and MCP user authorization are separate compatibility
cases. Do not accept any unknown bearer token. Every token must map to a world
identity and a recorded grant.

The Workbench must provide the local consent UI. It must show the application,
workspace, user, requested access, granted access, token state, and revoke
action.

## Request-contract release ledger

The provider support document owns the detailed request-contract table. The
release gate must verify these fixed boundaries:

| Surface | Required contract | Gate |
| --- | --- | --- |
| REST | Bearer token, `Notion-Version: 2026-03-11`, and the route media type | All 61 success/header operation paths pass against the pinned vendored public OpenAPI. The exact 63-method SDK lifecycle also passes. Multipart request bodies are lifecycle-tested, but not JSON-schema validated. Not every error status is forced for every operation. |
| Public OAuth | Registered client; HTTP Basic on token management; `Notion-Version: 2026-03-11`; JSON token-management bodies | SDK flow and public OpenAPI success validation pass. |
| MCP Streamable HTTP | OAuth bearer token; JSON POST; `Accept` lists JSON and event stream; `2025-11-25` negotiation; optional opaque session ID; form-encoded OAuth token requests with PKCE S256 | Protocol tests must pass. Exact hosted compatibility also needs an authenticated `tools/list` and result capture. Legacy SSE stays unsupported. |
| Webhooks | Raw JSON body and `X-Notion-Signature` HMAC-SHA256 with the per-subscription verification token | All 31 event names, verification, exact raw-body signing, and emitted transitions must pass. External delivery stays unsupported. |
| Agent API | REST bearer token with `interact:agents`, `Notion-Version: 2026-03-11`, JSON bodies, and event-stream session responses | Pinned official SDK methods and exhaustive documented filter, event, lifecycle, access, pagination, and limit branches pass. Deprecated alpha routes stay unsupported. |
| Workers | Pinned SDK manifest contracts and injected OAuth environment; no provider-wide public HTTP header contract | Local runtime tests can be supported. Hosted build, deploy, and sandbox stay unsupported. |
| Admin | Organization bearer token with operation scope, `Notion-Version: 2026-06-01`, and JSON mutation bodies | All 39 behavior and request/response schema paths pass by default against the pinned vendored Admin OpenAPI. |

## Notion MCP work

Notion MCP is a required part of the first provider. It is not an optional
follow-up.

Implement the official remote-server behavior through:

- the newest documented Streamable HTTP transport at the provider MCP
  endpoint;
- interactive OAuth and protected-resource discovery required by compatible
  MCP clients;
- MCP initialization and capability negotiation;
- tool discovery and tool calls;
- the complete tool names, input schemas, result shapes, errors, and side
  effects in the pinned official Notion tool inventory;
- asynchronous task behavior for tools that offer it;
- file-upload hand-off behavior for tools that offer it;
- Notion and tool-specific rate limits that are part of the selected profile;
- client-specific documented aliases only when the server is responsible for
  them.

Pin the MCP protocol version and the official Notion tool inventory in the
support matrix. MCP changes independently of the REST API, so REST completeness
does not imply MCP completeness.

Do not implement the legacy SSE MCP transport or other deprecated Notion MCP
behavior. When Notion replaces its current transport or protocol behavior,
create a new compatibility profile instead of adding legacy behavior to the
current profile.

Test the endpoint with a protocol test client and with representative real MCP
clients. The client set must include Codex and Claude Code. Add another client
only when it finds a distinct compatibility fault.

## Workbench work

Create reusable provider components before or with the Notion screens:

- resource list and detail views;
- actor and authorization selectors;
- request and response inspector;
- protocol session timeline;
- mutation form from a provider action descriptor;
- support status and evidence panel;
- reset and scenario controls.

The Notion area must show:

- workspace, users, pages, blocks, databases, data sources, comments, and
  files;
- OAuth clients, consent grants, tokens, expiry, and revocation;
- REST requests with actor, API version, route, result, and state changes;
- MCP clients, sessions, negotiated capabilities, tool calls, arguments,
  results, errors, and state changes;
- the exact support matrix and known differences.

All Workbench mutations must use a supported public Notion surface. The UI must
not write the provider store directly.

## Documentation deliverables

Publish these documents with the provider:

- a quick-start guide for REST applications;
- a quick-start guide for MCP clients;
- base URL, environment variable, token, and OAuth callback configuration;
- a REST endpoint support matrix by `Notion-Version`;
- an MCP capability and tool support matrix with a snapshot date;
- authentication and permission behavior;
- fixture-world contents and test identities;
- rate-limit and error behavior;
- known differences and unsupported surfaces;
- an evidence ledger that links every support claim to official documentation
  and contract tests;
- a guide for adding the next provider through the reusable manifest and
  component system.

Unsupported behavior must be visible by name. Do not hide it in a general
limitations paragraph.

## Delivery phases

### Phase 0: measured inventory

- Verify emulate.dev and APIs.guru coverage.
- Capture official REST endpoints, versions, OAuth behavior, MCP transports,
  protocol version, tools, schemas, errors, and rate limits.
- Commit the first support matrices with all rows marked planned or
  unsupported.

### Phase 1: provider foundation

- Add provider discovery and manifest data without provider-specific runtime
  branches.
- Add the Notion projection and deterministic seed validation.
- Add the shared Notion domain services and durable change journal.

### Phase 2: REST and authorization

- Implement REST endpoint groups in dependency order.
- Implement integration tokens, OAuth, permissions, and content grants.
- Add REST contract, SDK, reset, and cross-provider fixture tests.

### Phase 3: remote MCP server

- Add OAuth discovery and remote MCP transport.
- Implement the pinned complete Notion MCP tool inventory on the shared domain
  services.
- Add protocol tests and real-client tests.
- Prove bidirectional state visibility between REST and MCP.

### Phase 4: Workbench and documentation

- Add the reusable provider UI components and Notion screens.
- Publish quick starts, support matrices, known differences, and evidence.
- Verify that every UI action uses REST or MCP.

### Phase 5: release gate

- Run all existing tests to detect regressions.
- Run Notion REST, OAuth, MCP, SDK, Workbench, reset, and parity tests.
- Run the 61-operation public OpenAPI lifecycle against the vendored pinned
  snapshot. This gate is green for success responses and required headers.
- Run the exact 63-method official SDK lifecycle, all 31 block request and 36
  block response branches, exhaustive content and Agent/session branches, and
  all 31 webhook schemas. These gates are green.
- Run the default 39-operation Admin behavior and schema suite against the
  vendored pinned snapshot. This gate is green.
- Recheck official Notion documentation and emulate.dev.
- Change a support row to supported only when its contract test passes.
- Confirm that a Notion-free world has the same behavior and bindings as
  before this work.

## Acceptance criteria

The provider is ready only when all these statements are true:

- Existing tests and existing provider behavior remain unchanged.
- The service is selected through profiles and manifests, not a core Notion
  branch.
- REST and MCP use the same identities, permissions, domain logic, and state.
- A mutation through REST is visible through MCP and the Workbench.
- A mutation through MCP is visible through REST and the Workbench.
- OAuth works with the selected application and MCP client flows.
- Reset restores a byte-equivalent accepted fixture state.
- Each supported REST endpoint has a passing contract test. The complete
  public OpenAPI profile has no validation failure.
- Each supported MCP tool and capability has a passing contract test.
- Codex and Claude Code can connect, authorize, list tools, and complete
  representative read and write tasks.
- The Workbench shows protocol evidence and does not bypass public surfaces.
- The documentation names all supported, partial, and unsupported behavior.
- The evidence ledger contains a dated official source and test for every
  support claim.
- A normal Admin run includes official OpenAPI schema validation against the
  pinned vendored snapshot.
- Hosted MCP exact compatibility is not reported before an authenticated
  hosted `tools/list` and result capture are pinned.

## Explicit non-goals for this provider release

The first release does not claim support for a Notion surface that is not in a
declared profile. SCIM and undocumented internal APIs are not included.
Notion-hosted Workers deployment and sandbox behavior are not emulated.

The deprecated open-source `notion-mcp-server` is not the compatibility target.
It can be used only as research evidence. The actively maintained hosted Notion
MCP behavior is the target.
