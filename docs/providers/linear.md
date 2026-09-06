# Linear

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

## What works

WorldFixture supports a small Linear GraphQL schema, a local OAuth flow, and
selected webhooks. You can read and change issues, comments, labels, webhooks,
and agent data. Support label: **Supported but partial**.

## What does not work

The complete Linear schema, strict production scopes, file uploads, and sync APIs
do not work.
These operations are **Not supported**. Production behavior and an official
Linear SDK are **Not verified against the production provider**.

## Connect

Use `LINEAR_BASE_URL` and `LINEAR_TOKEN`. Send
`Authorization: Bearer TOKEN_VALUE`. The token identifies the selected world
person. Missing or unknown tokens return GraphQL errors without viewer data.
Production scope behavior is not verified.

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

Issue, comment, and issue-label mutations send native webhook POSTs to external
receivers. These requests are separate from WorldFixture Connector v1 events.
Reset restores the accepted provider state, including stored subscriptions.

## Native webhooks

Create a subscription with the native `webhookCreate` GraphQL mutation:

```graphql
mutation {
  webhookCreate(input: {
    url: "http://host.docker.internal:3000/webhooks/linear"
    allPublicTeams: true
    resourceTypes: ["Issue", "Comment", "IssueLabel"]
    secret: "local-linear-signing-secret"
  }) {
    success
    webhook { id enabled secret }
  }
}
```

Use an HTTP or HTTPS address that the emulator can reach. The local emulator
allows HTTP for test receivers; production Linear requires a public HTTPS URL.
You can also seed `linear.webhooks` with `url`, `secret`, `resource_types`, and
either `team` or `all_public_teams: true`. A missing secret is generated and
stored with the subscription.

Successful issue, comment, and issue-label create, update, and delete mutations
send `create`, `update`, and `remove` actions. Issue archive and unarchive send
`update` actions. The payload uses the actual resource IDs, actor, organization,
and state. `updatedFrom` contains previous values only for changed fields.
The resource filter and team filter control delivery. An all-public-teams
subscription does not receive private-team changes. Use `webhookDelete` to stop
delivery for a subscription.

Issue payloads include stored creator, project, cycle, label, and assignee IDs,
the issue number, due date, and workflow dates. Updates include previous values
for these fields when they change. Comment updates include `editedAt`, plus the
`edited` flag from the older example in the provider guide. User actors include
the same ID and URL as the local GraphQL user.

Requests include `Linear-Delivery`, `Linear-Event`, `Linear-Timestamp`,
`Linear-Signature`, and `User-Agent: Linear-Webhook`. The delivery ID is a UUID.
The timestamp is in milliseconds and matches `webhookTimestamp` in the body.
The signature is a hexadecimal HMAC-SHA256 of the exact request body, with the
subscription secret. These fields follow the
[Linear webhook contract](https://linear.app/developers/webhooks).

Delivery is asynchronous. The GraphQL response does not wait for the receiver.
The receiver must return HTTP 200 within five seconds. A failed request has up
to three retries, after one minute, one hour, and six hours. Retries keep the
delivery ID and resource data. They refresh the delivery timestamp and signature.
Automatic subscription disabling and retry persistence across process restart
are not implemented.

Coverage is **Supported and contract-tested locally** for `Issue`, `Comment`, and
`IssueLabel`. Agent session webhook payloads use a separate protocol and are not
sent by this data-change adapter. Other Linear resource event types are not
implemented. Full provider payload and scope parity is not claimed.

The current [official SDK webhook types](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.ts)
have fields that this adapter does not supply. These include issue `state`,
sort values, previous identifiers, reactions, subscribers, and releases; and
comment `reactionData`. Nested resource objects are partial. The supported
labels are flat and use `isGroup: false`. Issue priority labels use the stored
priority number.
The mutation handlers supply User records. These records, including app users,
use the User actor shape and their actual user ID. Production selection of
OAuth client or integration actor variants is not verified. Deletion of an issue
or label can change related local resources without sending a separate event
for each related change. Production behavior for those changes, global labels
on team subscriptions, wildcard resource filters, and retry identity is not
verified. There is no production recording or official SDK receiver test.

Provider authority: [Linear GraphQL](https://linear.app/developers/graphql) and
[Linear webhooks](https://linear.app/developers/webhooks).
