# Account Desk service coverage

This file is generated from the same registry that the app shows. It records
named local workflows, not the full API of each production provider.

Reference check: 2026-09-05, business.saas-company:v3.
Corrected image: `sha256:0cc583df8dec71b84b58b143558b418884a8285dcb75180d9e136c0590a4b080`.

A reference test is not a result for your running world. Use Verification to
check the current connections and approved writes. No production-provider
equivalence is claimed.

| Service | App writes | SDK or client version |
| --- | --- | --- |
| slack | Send Slack message | @slack/web-api: 7.12.0 |
| github | Create GitHub issue | @octokit/rest: 22.0.1 |
| gmail | Send Gmail message | googleapis: 178.0.0 |
| calendar | Create follow-up event | googleapis: 178.0.0 |
| drive | Create Drive document | googleapis: 178.0.0 |
| notion | Append Notion note; Verify local Notion webhook capture | @notionhq/client: 5.26.0 |
| notion-mcp | Authorize local Notion MCP test client; Create account note through Notion MCP | transport: JSON-RPC / OAuth PKCE S256; protocol: 2025-11-25 |
| notion-admin | No app write workflow | HTTP/protocol reads; no official SDK claim |
| notion-agent | Run local Notion Agent session | @notionhq/client: 5.26.0 |
| stripe | Create draft invoice | stripe: 22.6.1; apiVersion: 2026-08-26.dahlia |
| linear | Create Linear issue | @linear/sdk: 93.0.1; mode: public client.rawRequest with explicit fields |
| resend | Send local Resend email | resend: 6.26.0 |
| twilio | Create local SMS | twilio: 6.1.0 |
| clerk | No app write workflow | HTTP/protocol reads; no official SDK claim |
| okta | No app write workflow | HTTP/protocol reads; no official SDK claim |
| microsoft | No app write workflow | HTTP/protocol reads; no official SDK claim |
| apple | No app write workflow | HTTP/protocol reads; no official SDK claim |
| vercel | No app write workflow | HTTP/protocol reads; no official SDK claim |
| mongoatlas | No app write workflow | HTTP/protocol reads; no official SDK claim |
| s3 | Save S3 object | @aws-sdk/client-s3: 3.1127.0 |
| mail | Send Local Mail to this inbox | imapflow: 1.7.8; nodemailer: 10.0.0 |
| http | No app write workflow | HTTP/protocol reads; no official SDK claim |

## slack

Reads used by the app:

- `POST /api/users.list`
- `POST /api/conversations.list`
- `POST /api/conversations.history`

Writes used by the app:

- **Send Slack message** (`slack.send`): tested locally. Inputs: `channel`, `text`.

Limits:

- Latest message is compared across all visible conversations; histories contain at most 30 messages.
- The current provider ignores history timestamp filters. Write readback follows bounded cursor pages to find the exact saved timestamp and text.
- No Socket Mode or full Slack API claim.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## github

Reads used by the app:

- `GET /user/repos`
- `GET /search/repositories?q=size:>=0`
- `GET /repos/{owner}/{repo}/issues`

Writes used by the app:

- **Create GitHub issue** (`github.issue`): tested locally. Inputs: `owner`, `repo`, `title`, `body`.

Limits:

- Issue reads cover at most 30 repositories. Repository and issue IDs are discovered.
- No production Actions execution.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## gmail

Reads used by the app:

- `GET /gmail/v1/users/me/messages`
- `GET /gmail/v1/users/me/messages/{id}`
- `GET /gmail/v1/users/me/threads/{id}`

Writes used by the app:

- **Send Gmail message** (`gmail.send`): tested locally. Inputs: `to`, `subject`, `text`, `threadId` (optional), `inReplyTo` (optional), `references` (optional).

Limits:

- At most 100 message bodies are read. HTML-only mail uses a marked excerpt.
- Threaded replies require the original Message-ID, References, matching subject and thread ID; local send is not remote mail delivery.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## calendar

Reads used by the app:

- `GET /calendar/v3/users/me/calendarList`
- `GET /calendar/v3/calendars/{id}/events`

Writes used by the app:

- **Create follow-up event** (`calendar.event`): tested locally. Inputs: `calendarId`, `summary`, `start`, `end`.

Limits:

- Calendar seed correction is required; this workflow fails on the older image.
- Create is confirmed through event list; no meeting-notification parity claim.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`

## drive

Reads used by the app:

- `GET /drive/v3/files`
- `GET /drive/v3/files/{id}`

Writes used by the app:

- **Create Drive document** (`drive.file`): tested locally. Inputs: `name`, `text`.

Limits:

- Upload passes rootUrl per call and uses a transport-level local-origin guard.
- Docs and Sheets APIs are not supported.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## notion

Reads used by the app:

- `POST /v1/search`
- `GET /v1/pages/{id}`
- `GET /v1/blocks/{id}/children`

Writes used by the app:

- **Append Notion note** (`notion.note`): tested locally. Inputs: `pageId`, `text`.
- **Verify local Notion webhook capture** (`notion.webhook-capture`): tested locally. Inputs: `parentPageId`, `title`. Subscription setup is Workbench-only; this is not a public provider operation.

Limits:

- REST version 2026-03-11 only.
- Webhook subscription controls are Workbench-only local controls; external delivery is disabled.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-notion.test.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## notion-mcp

Reads used by the app:

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /mcp initialize`
- `POST /mcp tools/list`

Writes used by the app:

- **Authorize local Notion MCP test client** (`notion-mcp.connect`): tested locally. Inputs: `userId`.
- **Create account note through Notion MCP** (`notion-mcp.page`): tested locally. Inputs: `parentPageId`, `title`, `text`.

Limits:

- Consent is explicit. REST tokens cannot be used as MCP tokens.
- Page creation is read back with the official REST SDK; hosted tool-result parity is not proved.

Evidence:

- `examples/demo_app/tests/providers-notion.test.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`

## notion-admin

Reads used by the app:

- `GET /admin/v1/legal_holds`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- Read-only legal-hold inventory, not all 39 Admin operations.
- Requires separate organization token and Notion-Version 2026-06-01.

Evidence:

- `examples/demo_app/tests/providers-notion.test.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`

## notion-agent

Reads used by the app:

- `POST /v1/agents/query`
- `POST /v1/sessions/query`
- `GET /v1/agents/{id}`
- `GET /v1/sessions/{id}`
- `POST /v1/sessions/{id}/events/query`

Writes used by the app:

- **Run local Notion Agent session** (`notion-agent.session`): tested locally. Inputs: `agentId`, `message`.

Limits:

- Agent responses are deterministic local results. No external AI model runs.
- An active visible seeded Agent is required.

Evidence:

- `examples/demo_app/tests/providers-notion.test.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`

## stripe

Reads used by the app:

- `GET /v1/customers`
- `GET /v1/invoices`
- `GET /v1/subscriptions`

Writes used by the app:

- **Create draft invoice** (`stripe.draft`): tested locally. Inputs: `customer`, `description`.

Limits:

- The app creates manual draft invoices only. It does not charge customers.
- Refunds, taxes, disputes and broad production payment states are not supported.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## linear

Reads used by the app:

- `POST /graphql: issues and teams`

Writes used by the app:

- **Create Linear issue** (`linear.issue`): tested locally. Inputs: `teamId`, `title`, `description`.

Limits:

- Generated SDK model queries request unsupported fields such as Team.ledInitiativeCount.
- Only the named issue/team fields and create/readback mutation are tested.

Evidence:

- `examples/demo_app/tests/providers-secondary.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## resend

Reads used by the app:

- `GET /emails`
- `GET /emails/{id}`

Writes used by the app:

- **Send local Resend email** (`resend.send`): tested locally. Inputs: `from`, `to`, `subject`, `text`.

Limits:

- Public SDK resource methods use a guarded local transport.
- No external delivery, current global Contacts API or outbound webhook claim.

Evidence:

- `examples/demo_app/tests/providers-secondary.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## twilio

Reads used by the app:

- `GET /2010-04-01/Accounts/{sid}/Messages.json`
- `GET /2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json`

Writes used by the app:

- **Create local SMS** (`twilio.send`): tested locally. Inputs: `from`, `to`, `text`.

Limits:

- Named Messaging methods only, at most 1000 messages and numbers.
- Local SMS records do not mean carrier delivery.

Evidence:

- `examples/demo_app/tests/providers-secondary.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## clerk

Reads used by the app:

- `GET /v1/users`
- `GET /v1/organizations`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- First provider page only. App writes and official Clerk SDK methods are not tested.
- No Clerk webhooks.

Evidence:

- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## okta

Reads used by the app:

- `GET /api/v1/users`
- `GET /api/v1/groups`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- First provider page only. App writes and official Okta SDK methods are not tested.
- Production SSWS authentication is not supported.

Evidence:

- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## microsoft

Reads used by the app:

- `GET /v1.0/me`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- Local sign-in is tested separately. Graph list/write APIs are not supported.
- No Teams, Outlook, OneDrive or SharePoint workflow.

Evidence:

- `examples/demo_app/tests/oauth.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## apple

Reads used by the app:

- `GET /.well-known/openid-configuration`
- `GET /auth/keys`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- Local sign-in is tested separately; client-secret and redirect checks differ from production.
- No other Apple product APIs.

Evidence:

- `examples/demo_app/tests/oauth.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## vercel

Reads used by the app:

- `GET /v10/projects`
- `GET /v6/deployments`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- First provider page only. Empty inventories are not deployment-execution proof.
- No actual hosted build, domain verification, SDK or app-write coverage.

Evidence:

- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## mongoatlas

Reads used by the app:

- `GET /api/atlas/v2/groups`
- `GET /api/atlas/v2/groups/{id}/clusters`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- First provider page only. This is Admin metadata, not a MongoDB wire database.
- Retired Data API is not used. Production authentication and SDK parity are not proved.

Evidence:

- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## s3

Reads used by the app:

- `ListObjectsV2 in generated S3_BUCKET`
- `GetObject`

Writes used by the app:

- **Save S3 object** (`s3.put`): tested locally. Inputs: `bucket`, `key`, `text`.

Limits:

- Path-style endpoint and generated bucket required. Bytes are read back after put.
- Bucket discovery, multipart, versioning and notifications are not app coverage.

Evidence:

- `examples/demo_app/tests/providers-sdk.test.mjs`
- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## mail

Reads used by the app:

- `IMAP LOGIN, SELECT INBOX, FETCH envelope, SEARCH Message-ID`

Writes used by the app:

- **Send Local Mail to this inbox** (`mail.send`): tested locally. Inputs: `subject`, `text`.

Limits:

- Last 100 inbox messages only. Send targets the generated local inbox.
- No TLS, SMTP AUTH, external relay or mail webhooks.

Evidence:

- `examples/demo_app/tests/providers.test.mjs`
- `examples/demo_app/tests/providers-live.mjs`

## http

Reads used by the app:

- `GET root and discovered local paths`
- `RSS 2.0 parsing and stable GUID readback`
- `Repeated stable/failing/flapping probes`
- `GET paths from the advertised OpenAPI document`

Writes used by the app:

No write workflow is implemented in Account Desk for this service.

Limits:

- At most 30 links and 20 OpenAPI paths. Probe sequence values are not exposed; checks prove sampled behavior classes.
- Delayed RSS arrivals and reset timing require separate lifecycle tests.
- One hostname/listener, not multiple sites.

Evidence:

- `examples/demo_app/tests/providers-http.test.mjs`
- `examples/demo_app/tests/providers-advanced-live.mjs`

## Exclusions and checks not yet run

These entries do not mean that Notion is broken. Its REST, MCP, Agent, Admin,
and signed local capture workflows are listed above. A separate sample app,
a provider-local adapter, and outbound network delivery have different limits.

- **example-mcp.bridge** — Not included in the verified app workflows. Notion MCP coverage does not prove integration with the separate seven-tool application MCP example.
- **notion-workers.app-adapter** — Not available through this app’s supported interfaces. No public installed-package Worker runtime interface. Do not import private repository code or invent an HTTP route.
- **notion.webhook-network-delivery** — Not available through this app’s supported interfaces. Only signed local capture is implemented. No external callback is sent.
- **aws.iam-sqs-sts** — Not available through this app’s supported interfaces. The resolver rejects the conflicting AWS listener. S3 uses the separate SeaweedFS service.
- **http.delayed-rss-arrival** — Not included in the verified app workflows. Provider clock tests exist. Account Desk has not yet proved timed arrivals through the installed-package workflow.

PostgreSQL and MariaDB app storage are checked separately. See
[Database checks](DATABASE_TESTS.md). For the complete installed-package test,
see [First-run checks](FIRST_RUN_TESTS.md).
