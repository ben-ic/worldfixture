# Provider API support

Use this page before you select an API operation. Select a provider name for
the exact methods, paths, requests, responses, and test files.

> Except for the Notion MCP `tools/list` inventory, no provider has production
> request and response recordings. These APIs are **Not verified against the
> production provider**.

## Fast choices

| You must test | Start with | Proof |
| --- | --- | --- |
| Slack messages | [Slack](./slack.md) | Live API and Workbench flow; JavaScript, Python, and curl examples |
| Notion REST or Admin | [Notion](./notion.md#at-a-glance) | Pinned OpenAPI inventories and official SDK tests |
| Stripe billing | [Stripe](./stripe.md#support-map) | Named billing contracts and official SDK tests |
| S3 objects | [S3](./s3.md) | Core object protocol tests |
| Local email | [Local Mail](./local-mail.md) | Tested SMTP delivery and IMAP subset |

## Support compared with the real API

“Works now” names local behavior. “Real API gap” names important behavior that
is absent or does not have proof. **Supported but partial** is only an overall
summary. It does not replace these two columns.

| Provider | Works now | Real API gap | Test proof |
| --- | --- | --- | --- |
| [Slack](./slack.md) | Named auth, message, conversation, user, file, reaction, pin, bookmark, view, and OAuth operations. Workbench reads and sends messages. | No Socket Mode, Slack Connect, Enterprise Grid, Audit Logs, or SCIM. Scope checks are relaxed. | Auth and override tests; no complete route-contract or official SDK test |
| [GitHub](./github.md) | Named repository, content, commit, issue, pull request, organization, team, release, Actions, checks, search, and webhook operations. Workbench reads issues and creates an issue. | Many enterprise, billing, security, package, project, and administration APIs. | Issue override and compiler tests; no complete route-contract or Octokit test |
| [Google](./google.md) | OAuth/OIDC and named Gmail, Calendar, and Drive operations. Workbench reads and sends Gmail. | Many Workspace APIs and production OAuth branches. | Focused signing, batch, user, push, and compiler tests; no end-to-end provider or `googleapis` test |
| [Notion](./notion.md#at-a-glance) | Pinned 61-operation REST, 39-operation Admin, 13-method Agent, 31-event webhook, Workers, and 41-tool MCP inventories. Workbench uses shared state. | Other API versions, hosted Workers behavior, external webhook delivery, and hosted MCP result parity. | Named inventories are **Supported and contract-tested**; `@notionhq/client` 5.26.0 and `@notionhq/workers` 0.9.0 are tested |
| [Linear](./linear.md) | Selected GraphQL reads and mutations for issues, comments, labels, webhooks, and agents. Workbench reads live GraphQL state. | Complete GraphQL schema, strict authorization, production webhook delivery, and official SDK proof. | Route source and Workbench tests; no route-contract or official SDK test |
| [Microsoft](./microsoft.md) | OAuth, `/me`, and one-user Graph reads. | Graph list and write APIs. The projection view is **Workbench-only**. | Focused local tests; no official SDK test |
| [Apple](./apple.md) | OAuth discovery, authorization, grant, refresh, and revoke. | PKCE, client-secret validation, account events, and official SDK proof. | Focused local tests; no official SDK test |
| [Okta](./okta.md) | Named user, group, app, authorization-server, and OAuth operations. Workbench reads live state. | `SSWS`, complete scope enforcement, hooks, and broad management API. | Focused local tests; no official SDK test |
| [Clerk](./clerk.md) | Named user, email, organization, membership, invitation, and session operations. Workbench reads live state. | Webhooks and broad Backend API. | Focused local tests; no official SDK test |
| [Vercel](./vercel.md) | Named team, project, deployment, domain, environment, Blob, and OAuth operations. Workbench reads live state. | Webhook API and official SDK proof. | Focused local tests; no official SDK contract test |
| [MongoDB Atlas](./mongodb-atlas.md) | Named project, cluster, database-user, and retired Data API operations. Workbench reads Admin state. | Production auth and versioned `Accept` rules. The implemented Data API is retired. | Focused local tests; no official SDK test |
| [AWS IAM, SQS, and STS](./aws.md) | None in a resolved run. | The resolver rejects the conflicting AWS listener. | **Not supported** |
| [Stripe](./stripe.md#support-map) | Named customer, catalog, checkout, invoice, subscription, and payment operations. Workbench has selected writes. | Broad Stripe API and authentication enforcement. | Named branches are **Supported and contract-tested** with `stripe` 22.6.1 |
| [Twilio](./twilio.md#exact-support) | Named message, call, phone-number, Verify, and Conversations operations. Workbench reads live REST state. | Complete Twilio API and official SDK proof. | Route tests; no official SDK or production recording test |
| [Resend](./resend.md) | Named email, domain, API-key, audience, and old audience-contact operations. Workbench reads live state. | Current global Contact API and authentication enforcement. | Focused local tests; no official SDK test |
| [S3](./s3.md) | Core bucket and object reads, put, and delete. Workbench lists and puts objects. | Authentication enforcement; multipart has no contract test. | Core object operations are **Supported and contract-tested** |
| [Local Mail](./local-mail.md) | Named SMTP delivery and IMAP mailbox operations. Workbench reads and sends mail. | TLS, `STARTTLS`, SMTP `AUTH`, network relay, and complete IMAP proof. | Named IMAP subset is **Supported and contract-tested** |
| [PostgreSQL and MariaDB](./databases.md) | Real wire services. Named MariaDB CRUD and reset persistence. PostgreSQL connection and authentication. | PostgreSQL CRUD proof, complete SQL semantics, events, and Workbench database browser. | Named protocol operations are **Supported and contract-tested** |

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
