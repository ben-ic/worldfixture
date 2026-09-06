# Microsoft Entra ID and Microsoft Graph

WorldFixture uses `@emulators/microsoft` 0.10.0.

| Question | Answer |
| --- | --- |
| Overall API status | **Supported but partial** |
| Production comparison | **Not verified against the production provider** |
| Workbench | **Not supported** |
| State and reset | Local OAuth state; reset restores the accepted snapshot |
| Implementation owner | emulate.dev |

“Partial” means that only the routes in the next table are registered.

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

## What works

You can use local OAuth and OpenID Connect flows. You can also read the current
user, one user by ID, or a paginated user list from Microsoft Graph.

## What does not work

You cannot write Graph data. Mail, calendar, Teams, OneDrive, SharePoint,
groups, subscriptions, and webhooks do not work. The Workbench does not show a
Microsoft provider view. Use the registered Graph routes to read Microsoft user
state.

## Connection and authentication

Use `MICROSOFT_BASE_URL` and `MICROSOFT_TOKEN`. Send
`Authorization: Bearer <token>` for Graph reads. `GET /v1.0/users/:id` does
not check authentication. This differs from Microsoft Graph.

`GET /v1.0/users` requires a known token with `User.ReadBasic.All` or a higher
directory read scope. The generated directory token includes this scope.

## Registered routes

| HTTP method and path | Required input | Important response fields |
| --- | --- | --- |
| `GET /.well-known/openid-configuration` | None | Issuer, authorization, token, userinfo, JWKS, logout endpoints |
| `GET /:tenant/v2.0/.well-known/openid-configuration` | Tenant path value | Tenant discovery document |
| `GET /discovery/v2.0/keys` | None | `keys` JWKS array |
| `GET /oauth2/v2.0/authorize` | OAuth query values such as `client_id`, `redirect_uri`, `response_type`, `state`, and PKCE values | Local consent or redirect response |
| `POST /oauth2/v2.0/authorize/callback` | Local selected user and OAuth values | Authorization redirect with `code` and `state` |
| `POST /oauth2/v2.0/token` | Form body for authorization code, refresh token, or client credentials | `access_token`, `token_type`, `expires_in`, and applicable `refresh_token` or `id_token` |
| `POST /:tenant/oauth2/token` | Legacy tenant token form body | Local token response |
| `GET /oidc/userinfo` | Bearer token | Local OIDC user claims |
| `GET /v1.0/me` | Known bearer token | User `id`, `displayName`, `mail`, and `userPrincipalName` |
| `GET /v1.0/users` | Directory read token; optional `$top`, `$select`, and returned `$skiptoken` | `value` user array and `@odata.nextLink` when another page exists |
| `GET /v1.0/users/:id` | User ID; authentication is not enforced | User `id`, `displayName`, `mail`, and `userPrincipalName` |
| `GET /oauth2/v2.0/logout` | Optional post-logout redirect values | Local redirect |
| `POST /oauth2/v2.0/revoke` | Token form body | Local revocation result |

The token flow accepts authorization code, refresh token, client credentials,
client secret, and PKCE `plain` or `S256` paths. These flows do not have a
full production contract comparison.

## Detailed limits

All Graph writes are **Not supported**. OData query options other than the user
list's `$top`, `$select`, and `$skiptoken`,
mail, calendar, Teams, OneDrive, SharePoint, groups, subscriptions, and webhooks
are **Not supported**.

No official Microsoft SDK version is tested.

## Evidence and authority

Tests: `emulators/emulate/src/overrides/identity-lists.test.mjs`,
`emulators/emulate/src/overrides/declared-oauth-extra.test.mjs`, compiler
contract tests under `tests/contracts/`, and the readiness check in
`emulators/emulate/service.json`.

Authority: [Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
and [List users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0).
