# Microsoft Entra ID and Microsoft Graph

WorldFixture uses `@emulators/microsoft` 0.10.0.

| Question | Answer |
| --- | --- |
| Overall API status | **Supported but partial** |
| Production comparison | **Not verified against the production provider** |
| Workbench | **Not supported** |
| State and reset | Local OAuth, users, deleted users, and subscriptions; reset restores the accepted snapshot |
| Implementation owner | emulate.dev; WorldFixture adds user writes and Graph notifications |

“Partial” means that only the routes in the next table are registered.

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

## What works

You can use local OAuth and OpenID Connect flows. You can also read the current
user, one user by ID, or a paginated user list from Microsoft Graph.
You can create users, change basic user properties, soft delete users, and
permanently delete those users. User subscriptions send native Graph change
notifications to a local HTTP receiver when delivery is enabled.

## What does not work

Mail, calendar, Teams, OneDrive, SharePoint, and groups do not work.
Subscriptions to those resources are rejected. The Workbench does not show a
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
| `POST /v1.0/users` | Directory write token; `accountEnabled`, `displayName`, `mailNickname`, `userPrincipalName`, and `passwordProfile.password` | `201` and the basic user fields |
| `PATCH /v1.0/users/:id` | Directory write token; basic user properties | `204` |
| `DELETE /v1.0/users/:id` | Directory write token | `204`; user moves to deleted state |
| `DELETE /v1.0/directory/deletedItems/:id` | Directory write token; deleted user ID | `204`; permanent deletion |
| `POST /v1.0/subscriptions` | User read token; native subscription body | `201` and subscription |
| `GET /v1.0/subscriptions` | User read token | `value` with active subscriptions owned by this user and application |
| `GET /v1.0/subscriptions/:id` | Subscription owner | Subscription |
| `PATCH /v1.0/subscriptions/:id` | Subscription owner; `expirationDateTime` or `notificationUrl` | Updated subscription |
| `DELETE /v1.0/subscriptions/:id` | Subscription owner | `204`; future delivery stops |
| `GET /oauth2/v2.0/logout` | Optional post-logout redirect values | Local redirect |
| `POST /oauth2/v2.0/revoke` | Token form body | Local revocation result |

The token flow accepts authorization code, refresh token, client credentials,
client secret, and PKCE `plain` or `S256` paths. These flows do not have a
full production contract comparison.

## User change notifications

Set the Microsoft seed configuration to:

```json
{
  "webhooks": {
    "live_delivery": true,
    "allow_insecure_http": true
  }
}
```

`WORLDFIXTURE_MICROSOFT_WEBHOOK_DELIVERY=1` also enables delivery. HTTP is
accepted only with `allow_insecure_http: true`. Use HTTPS without this local
option. The default is capture mode: the service records native request bodies
in `webhooks.microsoftDelivery.deliveries` and sends no HTTP requests. Capture
mode does not validate the receiver.

Create a subscription with this body:

```json
{
  "resource": "users",
  "changeType": "updated,deleted",
  "notificationUrl": "http://127.0.0.1:8080/graph",
  "expirationDateTime": "2026-09-07T12:00:00Z",
  "clientState": "receiver-secret"
}
```

Use an expiration date suitable for your test. The subscription lifetime has a
45-minute minimum and a 41,760-minute maximum. Renew with `PATCH` before it
expires. The service removes expired subscriptions and stops delivery.

In delivery mode, creation sends `POST` to the callback with a URL-encoded
`validationToken` query value. The receiver must return `200`, `text/plain`,
and that decoded token within 10 seconds. An incorrect response prevents
subscription creation. A changed callback URL must pass the same check.

Notifications use `Content-Type: application/json` and a native `value` array.
Each item has `id`, `subscriptionId`, `subscriptionExpirationDateTime`,
`tenantId`, `clientState`, `changeType`, `resource`, and `resourceData`.
`resourceData` contains the user ID, `@odata.id`, and
`@odata.type: "#microsoft.graph.user"`. It does not contain profile values or
passwords. Read the user route after an update to obtain the current values.

For users, creation, a property change, and soft deletion emit `updated`.
Permanent deletion emits `deleted`. The `changeType` filter selects these
notifications. Changes in another tenant do not notify the subscription.
Failed writes and writes with no property change do not emit notifications.
The receiver must compare `clientState` with its subscription value.

Any 2xx response completes delivery. Other responses and network errors cause
retries with the same body. Local retry delays are 1, 2, 4, 8, and 16 seconds;
requests have a 10-second timeout. These short test limits differ from Graph's
four-hour retry period and initial three-second timeout. Subscription deletion,
expiration, or a changed callback URL prevents pending retries.

## Detailed limits

Subscriptions require `User.Read.All`, `User.ReadWrite.All`,
`Directory.Read.All`, or `Directory.ReadWrite.All`. New write routes require
`User.ReadWrite.All` or `Directory.ReadWrite.All`. The token must identify a
local tenant. Subscriptions are private to the application and creating user.
OAuth-issued tokens retain their application identity across token renewal.
Client credentials tokens use the declared application's tenant. They do not
select a user whose email matches the client ID. Subscription lists return
`clientState: null`; creation, single-subscription reads, and notifications retain
the value supplied by the client.
Static fixture tokens use the local `fixture` application identity unless
`client_id` is present in the runtime token map.

The emulator does not have service principal objects. For client credentials
tokens, `creatorId` is the local token actor ID (`"0"`), not a Graph service
principal ID. Application tokens do not list subscriptions created with
delegated tokens. `Subscription.Read.All` and administrator listing rules are
not implemented.

User creation stores the native identity fields. It accepts the required
password field but does not store or validate the password. User updates
support `displayName`, `givenName`, `surname`, `mail`, and
`userPrincipalName`. New write routes check the user's tenant. Existing read
routes retain their earlier access rules: the list spans local tenants, and
the single-user route has no authentication check. Directory administrator roles,
password policy, deleted-user restoration, and automatic deleted-user retention
are not implemented.

Only `users` and `/users` subscriptions are supported. Resource query filters,
rich notifications, lifecycle notifications, batching, subscription query
options, and production endpoint throttling are not implemented. The service
rejects `notificationUrlAppId`, encryption certificate options, and an explicit
`latestSupportedTlsVersion` other than `v1_2`. Receiver access-token expiry and
reauthorization are not simulated. The service
does not simulate mail, calendar, Teams, or other absent resources. OData query
options other than the user list's `$top`, `$select`, and `$skiptoken` are
**Not supported**.

No official Microsoft SDK version is tested.

## Evidence and authority

Tests: `emulators/emulate/src/webhooks/microsoft.test.mjs`,
`emulators/emulate/src/overrides/identity-lists.test.mjs`,
`emulators/emulate/src/overrides/declared-oauth-extra.test.mjs`, compiler
contract tests under `tests/contracts/`, and the readiness check in
`emulators/emulate/service.json`.

Authority: [Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc)
and [List users](https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0).


The notification implementation follows [Graph webhook delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks),
[subscription properties](https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0),
and [change notification properties](https://learn.microsoft.com/en-us/graph/api/resources/changenotification?view=graph-rest-1.0).
The subscription list follows the `clientState` rule in
[List subscriptions](https://learn.microsoft.com/en-us/graph/api/subscription-list?view=graph-rest-1.0).
Application token tenant selection follows the
[client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow).
User write routes follow [Create user](https://learn.microsoft.com/en-us/graph/api/user-post-users?view=graph-rest-1.0),
[Update user](https://learn.microsoft.com/en-us/graph/api/user-update?view=graph-rest-1.0),
[Delete user](https://learn.microsoft.com/en-us/graph/api/user-delete?view=graph-rest-1.0),
and [Permanently delete a directory object](https://learn.microsoft.com/en-us/graph/api/directory-deleteditems-delete?view=graph-rest-1.0).
