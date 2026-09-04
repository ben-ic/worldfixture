# Adding an API provider

Use this process for each vendor. A provider is complete only when its public
support map, fixtures, protocol behavior, tests, and Workbench view agree.

## 1. Fix the target contract

Record these facts before implementation:

- vendor and product surface;
- current API and protocol versions;
- official base URLs and authentication flows;
- complete operation or tool inventory;
- official schema, SDK, and documentation URLs;
- retrieval date;
- emulate.dev coverage;
- supported, partial, unsupported, and not-applicable rows.

APIs.guru is a discovery source. An official OpenAPI document, official SDK,
or official vendor documentation is the contract source. Keep a downloaded
official schema as test input when the vendor publishes one. Do not infer one
surface from another. For example, REST coverage does not prove MCP coverage.

## 2. Define the manifest boundary

Put declarative facts in `service.json` and the public schemas:

- profile names and dependencies;
- ports and readiness checks;
- base URL and credential bindings;
- per-person or organization credential selection;
- fixture projection requirements.

Put state rules in provider code:

- request and response validation;
- permissions and identity mapping;
- search, pagination, and rate limits;
- state transitions and side effects;
- OAuth and protocol behavior.

A new HTTP API that uses an existing transport should usually need a manifest
entry, a fixture compiler, a provider module, contract tests, documentation,
and Workbench descriptors. It should not need a resolver or supervisor branch.

## 3. Compile one world projection

Build one complete vendor projection for each selected world. Never merge it
with demo records or records from another world.

- Derive stable vendor IDs from the world ID and source record ID.
- Reuse the world's people, teams, projects, messages, files, and dates.
- Issue actor credentials only for people who exist in that world.
- Keep organization credentials separate from person credentials.
- Use the world's shared object store for file bytes. Keep storage keys out of
  vendor responses.
- Compile an empty projection when the world does not select the provider.

Fixtures must tell one consistent story across APIs. Add cases for allowed and
hidden data, pagination, invalid input, conflicts, deleted records, expired
credentials, async work, and rate limits.

## 4. Build one domain model

REST, MCP, webhooks, SDK adapters, and the Workbench must use the same domain
state and permission checks. Do not make a second MCP-only or UI-only store.
Record mutations in the common journal so reset and inspection work in the
same way for all surfaces.

## 5. Prove wire compatibility

Use three levels of tests:

1. Operation tests cover each documented route or tool and its main failure
   modes.
2. Schema tests validate requests and responses against the official OpenAPI
   or captured JSON Schema when it exists.
3. Client tests run a pinned official SDK or a real protocol client against
   the local base URL.

For OAuth, test discovery, consent, PKCE where required, code exchange, refresh,
revocation, audience, scopes, expiry, and invalid grants. For MCP, test the
current Streamable HTTP protocol, initialization, `tools/list`, `tools/call`,
rate limits, client aliases, and cross-surface state. Do not add a legacy
transport to a current-only profile.

An authenticated vendor capture can prove undocumented hosted schemas. Store
its date, client, plan, tool inventory, and redacted request and response
shapes. If capture is not possible, mark exact hosted-schema parity as
unverified. Do not convert an implementation assumption into a support claim.
Normalize a raw `tools/list` response before it becomes a contract:

```sh
node runtime/bin/normalize-mcp-tools.mjs \
  --input /path/to/tools-list.json \
  --provider vendor \
  --endpoint https://mcp.vendor.example/mcp \
  --captured-at 2026-09-03 \
  --client worldfixture-capture \
  --client-version 1 \
  --protocol-version 2025-11-25 \
  --plan unknown \
  --output emulators/emulate/contracts/vendor/hosted-mcp-tools.json
```

The command removes the JSON-RPC request ID, sorts tools and object keys, keeps
schema array order, validates unique tool names and object input schemas, and
writes canonical JSON to `--output`, or to standard output when that option is
absent. Do not put OAuth tokens, cookies, or authorization headers in the input
file or the stored contract.

## 6. Add the Workbench view

Use repeatable list, detail, action, status, and protocol-timeline components.
Show public vendor IDs and responses. Keep credentials out of general overview
responses. A dedicated developer workflow can return a selected protocol
secret when the vendor workflow requires it, but it must use an explicit
action, a narrow response, and `Cache-Control: no-store`. An explicit
environment variable must enable the action. Keep it disabled in demo images
and other untrusted runs. Do not expose
object-store keys or internal collection IDs because they are emulator
implementation details. Workbench mutations must call a supported API surface
and must not write provider state directly.

## 7. Publish the support map

Each provider document must contain:

- quick starts and environment variables;
- exact API and protocol versions;
- all declared profiles;
- one row for each operation or tool;
- status and contract evidence for each row;
- authentication, permission, fixture, and storage behavior;
- known differences and named unsupported behavior;
- official source links and verification date.

Use `Supported` only when a passing contract test proves the row. Use `Partial`
when a documented branch or shape is missing. Use `Implemented, unverified`
when behavior exists but the required hosted capture is not available.

## 8. Release gate

- Run the full provider suite.
- Run compiler, manifest, binding, reset, parity, and Workbench tests.
- Build the Workbench production bundle.
- Run the repository regression suite and separate code failures from sandbox
  or base-branch failures.
- Check `git diff --check` and inspect all changed files.
- Recheck official documentation and emulate.dev on the release date.
- Confirm that an unselected provider does not change an existing world.

Do not mark the provider complete while the support map and executable evidence
disagree.
