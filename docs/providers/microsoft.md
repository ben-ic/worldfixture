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

## What works

You can use local OAuth and OpenID Connect flows. You can also read the current
user or one user by ID from Microsoft Graph.

## What does not work

You cannot write Graph data. Mail, calendar, Teams, OneDrive, SharePoint,
groups, subscriptions, and webhooks do not work. The Workbench does not show a
Microsoft provider view. Use the registered Graph routes to read Microsoft user
state.

## Connection and authentication

Use `MICROSOFT_BASE_URL` and `MICROSOFT_TOKEN`. Send
`Authorization: Bearer <token>` for Graph reads. `GET /v1.0/users/:id` does
not check authentication. This differs from Microsoft Graph.

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
| `GET /v1.0/users/:id` | User ID; authentication is not enforced | User `id`, `displayName`, `mail`, and `userPrincipalName` |
| `GET /oauth2/v2.0/logout` | Optional post-logout redirect values | Local redirect |
| `POST /oauth2/v2.0/revoke` | Token form body | Local revocation result |

The token flow accepts authorization code, refresh token, client credentials,
client secret, and PKCE `plain` or `S256` paths. These flows do not have a
full production contract comparison.

## Detailed limits

All Graph writes are **Not supported**. Graph list-users, OData query behavior,
mail, calendar, Teams, OneDrive, SharePoint, groups, subscriptions, and webhooks
are **Not supported**.

No official Microsoft SDK version is tested.

## Evidence and authority

Tests: `emulators/emulate/src/overrides/microsoft-users.test.mjs`, compiler
contract tests under `tests/contracts/`, and the readiness check in
`emulators/emulate/service.json`.

Authority: [Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
and [Get user](https://learn.microsoft.com/en-us/graph/api/user-get?view=graph-rest-1.0).
