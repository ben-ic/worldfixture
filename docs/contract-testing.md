# Contract testing policy

The real provider API is the authority. WorldFixture does not treat a provider
name, a route registration, or a seed projection as proof of parity.

## Add support evidence

For each operation:

1. Pin the provider API version and verification date.
2. Save an official schema or a safe production recording when its license and
   data policy permit this.
3. Test required headers, authentication, request encoding, required fields,
   response fields, errors, state changes, reset, and emitted events.
4. Run the applicable official SDK against the local base URL and pin its exact
   tested version.
5. Add the test file to `docs/providers/support-matrix.json`.
6. Use one local support label. Add **Not verified against the production
   provider** when no production recording exists.

Production recordings are the strongest evidence. Remove credentials, personal
data, and tenant identifiers before a recording enters the repository. Store
its source, capture date, plan, client version, API version, and digest.

## Release checks

`npm run docs:check` checks internal Markdown links, provider page references,
allowed support labels, cited test files, and provider coverage against the
service manifest. `npm run docs:build` makes VitePress check website routes.

The provider test suite must pass before a support label becomes stronger.
Readiness tests stay narrow. They prove that a service can answer one diagnostic
request. They do not prove the other registered routes.

## Node-RED integration follow-up

The external report dated 2026-09-07 tested Node-RED 4.1.10 with WorldFixture
image 0.2.5 and `business.saas-company:v3`. It confirmed GitHub-to-Slack and
Notion-to-GitHub workflows, manual editor triggers, independent HTTP read-back,
and isolation in a second fresh container. It did not test OAuth, webhooks,
scheduled delivery, complete pagination, or reset with Node-RED still running.

The repository has separate coverage for those contracts:

| Area | Test evidence | Scope |
| --- | --- | --- |
| CLI environment selection | [`cli-environment.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/runtime/src/cli-environment.test.mjs) | Validates the environment file, preserves container and world-switch selection, exports ready bindings, and verifies provider process shutdown through the real CLI. |
| Combined application lifecycle | [`provider-app.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/runtime/src/provider-app.test.mjs) | A separate HTTP client process keeps its bindings while the real supervisor starts GitHub, Slack, and Notion. The test crosses discovery page boundaries, runs both provider workflows, reads a scheduled Slack arrival, and checks state after reset. |
| GitHub and Slack OAuth | [`declared-oauth-extra.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/overrides/declared-oauth-extra.test.mjs) | Declared clients, callback validation, token exchange, identity, and snapshot behavior. |
| Notion OAuth | [`notion.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/vendors/notion/notion.test.mjs), [`notion-admin.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/vendors/notion/notion-admin.test.mjs) | MCP discovery, PKCE, refresh, audience checks, and public REST OAuth. |
| Native webhooks | [GitHub tests](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/webhooks/github.test.mjs), [Slack tests](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/webhooks/slack.test.mjs), [Notion tests](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/vendors/notion/notion-webhooks.test.mjs) | Real local HTTP receivers, provider signatures, filters, delivery, and reset or retry cases. |
| Notion pagination | [`coupling-notion-probes.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/tests/image/coupling-notion-probes.test.mjs), [`notion-rest-write.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/vendors/notion/notion-rest-write.test.mjs) | Source-content readers, cursor errors, and REST query pagination. |
| Clock and reset control | [`timeline-control.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/runtime/src/timeline-control.test.mjs), [`session-manager-live.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/runtime/src/session-manager-live.test.mjs) | Serialized clock changes, delivery failures, reset, and an application database process that survives provider replacement. |

Run the combined application check from a checkout with the compiled worlds
and emulator dependencies installed:

```sh
node --test runtime/src/provider-app.test.mjs
```

It needs Node.js 22 or later and permission to open local listeners. It uses
temporary state and stops its own processes. It does not need Docker or a
production account. Internal runtime imports belong to the test harness; the
application process uses only HTTP and environment bindings.

These checks do not establish end-to-end coverage inside Node-RED. Before
extending that demo's claims, add an OAuth callback flow and a native webhook
receiver to its recipe. Check signatures and duplicate delivery handling. Run
the flows with small page sizes, advance an authored event, and reset while
the same Node-RED process stays active. Read back the resulting provider state
through a separate client. Record the image pins, world digest, and results.
Keep this evidence separate from the product-image checks described in
`tests/image/README.md` in the source repository.
