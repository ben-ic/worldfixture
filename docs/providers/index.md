# Provider API support

Use this page before you select an API operation. Select a provider name for
the exact methods, paths, requests, responses, and test files.
For outgoing events, read [native webhook setup and coverage](../guides/native-webhooks.md).

> Except for the Notion MCP `tools/list` inventory, no provider has production
> request and response recordings. These APIs are **Not verified against the
> production provider**.

## Fast choices

| You must test | Start with | Proof |
| --- | --- | --- |
| Slack messages | [Slack](./slack.md) | Live API and Workbench flow; JavaScript, Python, and curl examples |
| Notion REST or Admin | [Notion](./notion.md#what-works) | Pinned OpenAPI inventories and official SDK tests |
| Stripe billing | [Stripe](./stripe.md#worldfixture-billing-route-reference) | Named billing contracts and official SDK tests |
| S3 objects | [S3](./s3.md) | Core object protocol tests |
| Local email | [Local Mail](./local-mail.md) | Tested SMTP delivery and IMAP subset |

## Support compared with the real API

“Works now” names local behavior. “Real API gap” names important behavior that
is absent or does not have proof. **Supported but partial** is only an overall
summary. It does not replace these two columns.

| Provider | Works now | Real API gap | Test proof |
| --- | --- | --- | --- |
| [Slack](./slack.md) | Named auth, message, conversation, user, file, reaction, pin, bookmark, view, and OAuth operations. Workbench reads and sends messages. Native HTTP notifications for the documented event set. | No Socket Mode, Slack Connect, Enterprise Grid, Audit Logs, or SCIM. Scope checks are relaxed. | Auth and override tests; no complete route-contract or official SDK test |
| [GitHub](./github.md) | Named repository, content, commit, issue, pull request, organization, team, release, Actions, checks, search, and webhook operations. Workbench reads issues and creates an issue. Native HTTP notifications for the documented event set. | Many enterprise, billing, security, package, project, and administration APIs. | Issue override and compiler tests; no complete route-contract or Octokit test |
| [Google](./google.md) | OAuth/OIDC and named Gmail, Calendar, and Drive operations. Workbench reads and sends Gmail. | Many Workspace APIs and production OAuth branches. | Focused signing, batch, user, push, and compiler tests; no end-to-end provider or `googleapis` test |
| [Notion](./notion.md#what-works) | Pinned 61-operation REST, 39-operation Admin, 13-method Agent, 31-event webhook, Workers, and 41-tool MCP inventories. Workbench uses shared state. Native HTTP notifications for the documented event set. | Other API versions, hosted Workers behavior, and hosted MCP result parity. | Named inventories are **Supported and contract-tested**; `@notionhq/client` 5.26.0 and `@notionhq/workers` 0.9.0 are tested |
| [Linear](./linear.md) | Selected GraphQL reads and mutations for issues, comments, labels, webhooks, and agents. Workbench reads live GraphQL state. Native HTTP notifications for the documented event set. | Complete GraphQL schema, strict authorization, agent-session webhooks, and official SDK proof. | Route source and Workbench tests; no route-contract or official SDK test |
| [Microsoft](./microsoft.md) | OAuth, user reads and writes, subscriptions, and basic user change notifications. | Mail, calendar, Teams, rich notifications, and lifecycle notifications. The Workbench provider view is **Not supported**. | Focused local tests; no official SDK test |
| [Apple](./apple.md) | OAuth discovery, authorization, grant, refresh, revoke, and signed account-event notifications. | Complete production consent behavior and official SDK proof. | Focused local tests; no official SDK test |
| [Okta](./okta.md) | Named user, group, app, authorization-server, and OAuth operations. Workbench reads live state. Native HTTP notifications for the documented event set. | Complete scope enforcement, expression filters, and broad management API. | Focused local tests; no official SDK test |
| [Clerk](./clerk.md) | Named user, email, organization, membership, invitation, and session operations. Workbench reads live state. Native HTTP notifications for the documented event set. | Full webhook event coverage and broad Backend API. | Focused local tests; no official SDK test |
| [Vercel](./vercel.md) | Named team, project, deployment, domain, environment, Blob, and OAuth operations. Workbench reads live state. Native HTTP notifications for the documented event set. | Webhook management API, full event coverage, and official SDK proof. | Focused local tests; no official SDK contract test |
| [MongoDB Atlas](./mongodb-atlas.md) | Named project, cluster, database-user, and retired Data API operations. Workbench reads Admin state. Native HTTP notifications for the documented event set. | Production auth and versioned `Accept` rules. The implemented Data API is retired. | Focused local tests; no official SDK test |
| [AWS IAM, SQS, and STS](./aws.md) | Named local Query API actions with run bearer credentials. | No AWS SDK/SigV4 authentication or production IAM policy evaluation. | Operator, route, authentication, and reset tests; **Supported but partial** |
| [Stripe](./stripe.md#worldfixture-billing-route-reference) | Named customer, catalog, checkout, invoice, subscription, and payment operations. Workbench has selected writes. Native HTTP notifications for the documented event set. | Broad Stripe API and authentication enforcement. | Named branches are **Supported and contract-tested** with `stripe` 22.6.1 |
| [Twilio](./twilio.md#core-route-reference) | Named message, call, phone-number, Verify, and Conversations operations. Workbench reads live REST state. Native HTTP notifications for the documented event set. | Complete Twilio API and official SDK proof. | Route tests; no official SDK or production recording test |
| [Resend](./resend.md) | Named email, domain, API-key, audience, and old audience-contact operations. Workbench reads live state. Native HTTP notifications for the documented event set. | Current global Contact API and authentication enforcement. | Focused local tests; no official SDK test |
| [S3](./s3.md) | Exact bucket listing, object reads, put, and delete with run SigV4 credentials. Workbench lists and puts objects. | Native multipart has no contract test. | Core object operations and signature enforcement are **Supported and contract-tested** |
| [Local Mail](./local-mail.md) | Named SMTP delivery and IMAP mailbox operations. Workbench reads and sends mail. | TLS, `STARTTLS`, SMTP `AUTH`, network relay, and complete IMAP proof. | Named IMAP subset is **Supported and contract-tested** |
| [PostgreSQL and MariaDB](./databases.md) | Real wire services. Named MariaDB CRUD and reset persistence. PostgreSQL connection and authentication. | PostgreSQL CRUD proof, complete SQL semantics, events, and Workbench database browser. | Named protocol operations are **Supported and contract-tested** |

## Local request limits

WorldFixture sets the emulate.dev core request budget to **100,000 per token
per provider server per hour**. Gmail, Calendar, and Drive share the Google
server and its budget. Anonymous requests share a separate anonymous budget.
The Notion API also uses this core budget. Its separate MCP and search limits
are unchanged. S3, Local Mail, HTTP targets, and databases do not use this
core limiter. Responses served before core middleware are outside this budget.

This is a local demo limit, not a reproduction of production-provider quotas.
The response headers report `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` (Unix seconds). The pinned upstream limiter returns HTTP
`403` when the remaining count reaches zero, including the request that uses
the last count. Its existing cutoff behavior is unchanged.

The higher budget requires an image built from this source. An existing
container or older image keeps its previous limit. Restarting an application
alone does not change the provider limit.

The version-checked patch is in
[`patch-core-rate-limit.mjs`](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/scripts/patch-core-rate-limit.mjs).
[`core-rate-limit.test.mjs`](https://github.com/ben-ic/worldfixture/blob/main/emulators/emulate/src/core-rate-limit.test.mjs)
tests the cutoff, separate tokens, hourly recovery, and unchanged authentication.

## Official SDK proof

| Provider | Tested version |
| --- | --- |
| Notion | `@notionhq/client` 5.26.0 and `@notionhq/workers` 0.9.0 |
| Stripe | `stripe` 22.6.1 |
| All other providers | No official SDK contract test |

<details>
<summary>Implementation ownership</summary>

- WorldFixture supplies Notion, Local Mail, HTTP targets, and runtime behavior.
- emulate.dev 0.10.0 supplies the base Slack, GitHub, Google, Microsoft, Apple,
  Okta, Clerk, Resend, Vercel, MongoDB Atlas, Linear, Twilio, and Stripe APIs.
- WorldFixture adds measured overrides for named gaps, including Stripe billing.
- SeaweedFS 4.41 supplies S3.

</details>

Read [how support is measured](./support-policy.md). A contract test proves only
its named operation or branch.
