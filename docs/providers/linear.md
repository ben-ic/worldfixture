# Linear

## What works

WorldFixture supports a small Linear GraphQL schema, a local OAuth flow, and
selected webhooks. You can read and change issues, comments, labels, webhooks,
and agent data. Support label: **Supported but partial**.

## What does not work

The complete Linear schema, strict production scopes, file uploads, sync APIs,
failed-webhook retry, and the `Linear-Timestamp` webhook header do not work.
These operations are **Not supported**. Production behavior and an official
Linear SDK are **Not verified against the production provider**.

## Connect

Use `LINEAR_BASE_URL` and `LINEAR_TOKEN`. Send
`Authorization: Bearer TOKEN_VALUE`. Standard worlds do not apply strict
scope checks. Some anonymous requests can work. Do not depend on this.

WorldFixture uses the internal Linear module from `emulate` 0.10.0.

## Route reference

| Method and path | Input | Output | Proof |
| --- | --- | --- | --- |
| `GET /graphql` | GraphQL query in the `query` URL parameter | GraphQL `data` or `errors` envelope | Registered route source |
| `POST /graphql` | JSON `query` and `variables` | GraphQL `data` or `errors` envelope | Registered route source |
| `GET /oauth/authorize` | OAuth query parameters | Local authorization HTML | Registered route source |
| `POST /oauth/authorize/callback` | Local authorization decision | Redirect with a code or error | Registered route source |
| `POST /oauth/token` | Authorization-code form data | Local access-token response | Registered route source |
| `POST /oauth/revoke` | Token form data | Empty success response | Registered route source |

The GraphQL query resources are viewer, organization, users, teams, workflow
states, issues, comments, issue labels, projects, cycles, webhooks, agent
sessions, and agent activity. Connections use `nodes`, `edges`, and
`pageInfo` where the local schema defines them. The local schema has selected
create, update, and delete mutations for issues, comments, issue labels,
webhooks, agent sessions, and agent activity.

## State, events, reset, and Workbench

GraphQL mutations change the store that later GraphQL reads and the Workbench
use. The Workbench reads the organization, teams, workflow states, and issues
with live GraphQL requests. It has no Linear write control.

Selected issue, comment, issue-label, and agent mutations can send webhook
requests. Delivery is local and has no retry. Reset restarts and reseeds the
store. Stop does not preserve this state.

Implementation: emulate.dev. WorldFixture adds no Linear API route. Proof is
the registered route source, compiler projection tests, and live reads in
`runtime/src/workbench.mjs`. There is no Linear endpoint contract test or
production recording.

Provider authority: [Linear GraphQL](https://linear.app/developers/graphql) and
[Linear webhooks](https://linear.app/developers/webhooks).
