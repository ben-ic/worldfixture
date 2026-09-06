# Okta

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

## What works

WorldFixture supports selected users, groups, applications, assignments,
lifecycle actions, authorization servers, OIDC, and OAuth. Support label:
**Supported but partial**.

## What does not work

System Log, event hooks, Identity Engine flows, devices, factors, policies,
zones, brands, and the other Okta APIs do not work. Complete `SSWS` parsing,
production scopes, permissions, rate limits, and webhook delivery also do not
work. These operations are **Not supported**. Production behavior and an
official Okta SDK are **Not verified against the production provider**.

## Connect

Use `OKTA_BASE_URL` and `OKTA_TOKEN`. Management calls accept the generated
bearer-like token. Okta normally uses `Authorization: SSWS TOKEN_VALUE` for an
API token. The local parser does not prove the production authentication rules.

WorldFixture uses `@emulators/okta` 0.10.0.

## Management route reference

All create and update calls use JSON. List calls return JSON arrays or
Okta-like list data.

| Resource | Exact methods and paths | Output | Proof |
| --- | --- | --- | --- |
| Users | `GET, POST /api/v1/users`<br>`GET, PUT, POST, DELETE /api/v1/users/:userId`<br>`GET /api/v1/users/me`<br>`GET /api/v1/users/:userId/groups` | Users, one user, or group list | Registered route source |
| User lifecycle | `POST /api/v1/users/:userId/lifecycle/{activate,deactivate,suspend,unsuspend,reactivate}` | Updated local user status | Registered route source |
| Groups | `GET, POST /api/v1/groups`<br>`GET, PUT, DELETE /api/v1/groups/:groupId` | Groups or one group | Registered route source |
| Group members | `GET /api/v1/groups/:groupId/users`<br>`PUT, DELETE /api/v1/groups/:groupId/users/:userId` | Members or an empty success response | Registered route source |
| Applications | `GET, POST /api/v1/apps`<br>`GET, PUT, DELETE /api/v1/apps/:appId` | Applications or one application | Registered route source |
| App assignments | `GET /api/v1/apps/:appId/users`<br>`PUT, DELETE /api/v1/apps/:appId/users/:userId` | Assignments or an empty success response | Registered route source |
| App lifecycle | `POST /api/v1/apps/:appId/lifecycle/{activate,deactivate}` | Updated local app status | Registered route source |
| Authorization servers | `GET, POST /api/v1/authorizationServers`<br>`GET, PUT, DELETE /api/v1/authorizationServers/:authServerId` | Servers or one server | Registered route source |
| Server lifecycle | `POST /api/v1/authorizationServers/:authServerId/lifecycle/{activate,deactivate}` | Updated local server status | Registered route source |

User objects include `id`, `status`, `created`, `lastUpdated`, `profile`,
and `_links`. Group objects include `id`, timestamps, `profile`, and
`_links`. Application objects include `id`, `name`, `label`, `status`,
`settings`, and `_links`.

## OIDC and OAuth route reference

| Operation | Organization path | Custom-server path | Input and output |
| --- | --- | --- | --- |
| Discovery | `GET /.well-known/openid-configuration` | `GET /oauth2/:id/.well-known/openid-configuration` | Discovery JSON |
| JWKS | `GET /oauth2/v1/keys` | `GET /oauth2/:id/v1/keys` | `keys[]` |
| Authorize | `GET /oauth2/v1/authorize` | `GET /oauth2/:id/v1/authorize` | OAuth query; local HTML |
| Decision | `POST /oauth2/v1/authorize/callback` | `POST /oauth2/:id/v1/authorize/callback` | Form decision; redirect |
| Token | `POST /oauth2/v1/token` | `POST /oauth2/:id/v1/token` | Form grant; token JSON |
| User information | `GET /oauth2/v1/userinfo` | `GET /oauth2/:id/v1/userinfo` | Claims JSON |
| Revoke | `POST /oauth2/v1/revoke` | `POST /oauth2/:id/v1/revoke` | Token form; empty success |
| Introspect | `POST /oauth2/v1/introspect` | `POST /oauth2/:id/v1/introspect` | Token form; active-state JSON |
| Logout | `GET /oauth2/v1/logout` | `GET /oauth2/:id/v1/logout` | Redirect |

Proof for this table is the registered route source. No route has an Okta
response-contract test or production recording.

## State, reset, and Workbench

Management writes change the in-memory store. The Workbench reads users,
groups, and applications from the live API. It has no Okta write control. Reset
restarts and reseeds the store. Stop does not preserve this state.

Implementation: emulate.dev. WorldFixture adds no Okta API route. Compiler
tests cover the projection.

Provider authority: [Okta API](https://developer.okta.com/docs/api/).
