# Clerk

## What works

WorldFixture supports selected users, email addresses, organizations,
memberships, invitations, sessions, and a small OAuth/OIDC flow. Support label:
**Supported but partial**.

## What does not work

Client management, phone numbers, OAuth application management, SAML and enterprise connections,
billing, machines, M2M tokens, roles, permissions, and sign-in tokens do not work. Complete production authorization, pagination, and errors
also do not work. These operations are **Not supported**. Production behavior
and `@clerk/backend` are **Not verified against the production provider**.

## Connect

Use `CLERK_BASE_URL` and `CLERK_TOKEN`. Send
`Authorization: Bearer TOKEN_VALUE` and JSON bodies.

WorldFixture uses `@emulators/clerk` 0.10.0 with declared-user and OAuth client
seeding. [Declare OAuth applications in world source](../guides/worlds.md#declare-oauth-clients).
Authorization-code exchange requires a registered client and exact callback.
Public clients require S256 PKCE. Refresh tokens are not supported.

## Route reference

| Resource | Exact methods and paths | Input and output | Proof |
| --- | --- | --- | --- |
| Users | `GET, POST /v1/users`<br>`GET, PATCH, DELETE /v1/users/:userId`<br>`GET /v1/users/count` | Query filters or user JSON; user objects or count | Registered route source |
| User state | `POST /v1/users/:userId/{ban,unban,lock,unlock}` | No body; updated user | Registered route source |
| User metadata and password | `PATCH /v1/users/:userId/metadata`<br>`POST /v1/users/:userId/verify_password` | Metadata or password JSON; updated user or check result | Registered route source |
| Email addresses | `POST /v1/email_addresses`<br>`GET, PATCH, DELETE /v1/email_addresses/:emailId` | Email JSON or ID; email object or delete result | Registered route source |
| Organizations | `GET, POST /v1/organizations`<br>`GET, PATCH, DELETE /v1/organizations/:orgId`<br>`PATCH /v1/organizations/:orgId/metadata` | Filters or organization JSON; organization data | Registered route source |
| Memberships | `GET, POST /v1/organizations/:orgId/memberships`<br>`PATCH, DELETE /v1/organizations/:orgId/memberships/:userId`<br>`PATCH /v1/organizations/:orgId/memberships/:userId/metadata` | Membership or metadata JSON; membership data | Registered route source |
| Invitations | `GET, POST /v1/organizations/:orgId/invitations`<br>`GET /v1/organizations/:orgId/invitations/:invitationId`<br>`POST /v1/organizations/:orgId/invitations/bulk`<br>`POST /v1/organizations/:orgId/invitations/:invitationId/revoke` | Invitation JSON; invitation data | Registered route source |
| Sessions | `GET, POST /v1/sessions`<br>`GET /v1/sessions/:sessionId`<br>`POST /v1/sessions/:sessionId/revoke`<br>`POST /v1/sessions/:sessionId/tokens`<br>`POST /v1/sessions/:sessionId/tokens/:template` | Session or token JSON; session or token data | Registered route source |
| OAuth/OIDC | `GET /.well-known/openid-configuration`<br>`GET /v1/jwks`<br>`GET /oauth/authorize`<br>`POST /oauth/authorize/callback`<br>`POST /oauth/token`<br>`GET /oauth/userinfo` | OAuth query or form data; discovery, keys, redirect, token, or claims | Registered route source |

User objects include `id`, names, email addresses, metadata, lifecycle state,
and timestamps. Organization objects include `id`, `name`, `slug`, metadata,
member limits, and timestamps. Session objects include `id`, `user_id`,
`status`, timestamps, and local token data.

`GET /v1/users` returns a user array. Use `limit` and `offset` for pagination.
Organization lists retain their `data` and `total_count` fields.

## State, reset, Workbench, and proof

API writes change the store that the API and Workbench read. The Workbench
reads users, organizations, and sessions from the live API. It has no Clerk
write control. Reset restarts and reseeds the store. Stop does not preserve this
state.

Implementation: emulate.dev, with WorldFixture's declared OAuth client checks
and public user-list response correction. Tests in
`emulators/emulate/src/overrides/identity-lists.test.mjs` check user list shape,
authentication, pagination, filtering, and organization response fields.
`emulators/emulate/src/overrides/declared-oauth.test.mjs` checks OAuth behavior.
Compiler tests cover the projection. No production recording or official SDK
version has a WorldFixture test.

Provider authority: [Clerk Backend API](https://clerk.com/docs/reference/backend-api).


## Native webhook delivery

Set `clerk.instance_id` and `clerk.webhooks` in the session seed overlay.
Each webhook has `url`, `signing_secret`, and an `events` array. The signing
secret uses Svix format: `whsec_` followed by a Base64 key. Set `enabled`
to `false` to disable an endpoint.

Supported triggers include user create, update, and delete; organization
create, update, and delete; membership create and update; invitation create
and revoke; and session create and revoke. Event bodies contain `data`,
`object: "event"`, `type`, `timestamp`, `instance_id`, and
`event_attributes.http_request`. The request attributes contain `user_agent`
and `client_ip`. The IP uses `0.0.0.0` when no socket address is available.
Event and resource timestamps use milliseconds. Svix header timestamps use
seconds. Session events include the associated public API user snapshot and
`actor: null`. User deletion events retain a stored `external_id`. Invitation
events include the stored expiry time. Passwords are excluded from user data. Requests carry
Svix signatures and use the published Svix retry schedule.

Webhook support remains partial. The pinned emulator omits fields from the
current Clerk resource types. User data lacks fields such as
`organization_memberships`, `enterprise_accounts`, `password_last_updated_at`,
`legal_accepted_at`, `locale`, lockout fields, and organization creation and
self-deletion settings. Invitation data lacks `role_name`, metadata,
and `url`. Organization and membership image and membership-limit values can
retain the emulator's null values. Deletion data retains the emulator's
`object: "deleted_object"`; `slug` is omitted when unavailable. Its exact production webhook
shape has not been checked with a Clerk recording. No production recording
or official Clerk SDK test establishes full payload compatibility.

Membership deletion, bulk invitation creation, implicit membership creation,
cascade events, and OAuth-created sessions do not emit native webhooks.
Dashboard management APIs, billing events, and complete nested resource event
coverage are not implemented.

Sources: [Clerk webhooks](https://clerk.com/docs/guides/development/webhooks/overview)
and [Svix retries](https://docs.svix.com/retries). See also
Clerk's current [webhook event types](https://github.com/clerk/javascript/blob/main/packages/backend/src/api/resources/Webhooks.ts)
and [resource JSON types](https://github.com/clerk/javascript/blob/main/packages/backend/src/api/resources/JSON.ts).
