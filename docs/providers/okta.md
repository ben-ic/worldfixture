# Okta

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

## What works

WorldFixture supports selected users, groups, applications, assignments,
lifecycle actions, authorization servers, OIDC, OAuth, and selected event hooks. Support label:
**Supported but partial**.

## What does not work

System Log queries, Identity Engine flows, devices, factors, policies,
zones, brands, and the other Okta APIs do not work. Complete `SSWS` parsing,
production scopes, permissions, and rate limits also do not work. These operations are **Not supported**. Production behavior and an
official Okta SDK are **Not verified against the production provider**.

## Connect

Use `OKTA_BASE_URL` and `OKTA_TOKEN`. Management calls accept the generated token with `Authorization: SSWS TOKEN_VALUE`
or a Bearer header. The local parser does not prove all production authentication rules.

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

Proof for this table is the registered route source. The event hook tests use a local HTTP receiver. Other routes have no Okta
response-contract test or production recording.

## Event hooks

Register a receiver with `POST /api/v1/eventHooks`. The same object can be
supplied in `okta.event_hooks` in the provider configuration:

```json
{
  "name": "User stream",
  "events": {
    "type": "EVENT_TYPE",
    "items": ["user.lifecycle.create", "group.user_membership.add"]
  },
  "channel": {
    "type": "HTTP",
    "version": "1.0.0",
    "config": {
      "uri": "http://127.0.0.1:9000/okta-events",
      "authScheme": {
        "type": "HEADER",
        "key": "Authorization",
        "value": "receiver-secret"
      },
      "headers": [{"key": "X-Receiver", "value": "stream"}]
    }
  }
}
```

New hooks have `ACTIVE` status and `UNVERIFIED` verification status. Call
`POST /api/v1/eventHooks/:id/lifecycle/verify`. The receiver must return
`{"verification":"CHALLENGE"}` for the GET request. Copy `CHALLENGE` from
`x-okta-verification-challenge`. Delivery starts only after this check succeeds.
Seeded hooks must also pass this check.

The API supports list, get, replace (`PUT`), verify, activate, deactivate, and
delete. Deactivate a hook before deletion. A change to the channel requires a
new verification. Responses omit the authentication secret.

Accepted local user changes send `user.lifecycle.create`,
`user.account.update_profile`, and `user.lifecycle.{activate,deactivate,suspend,unsuspend,reactivate}`.
User deletion sends `user.lifecycle.delete.initiated`. The first DELETE of an
active user only deactivates the user, as the local user API specifies.
Group changes send `group.lifecycle.{create,delete}`, `group.profile.update`,
and `group.user_membership.{add,remove}`. App assignment changes send
`application.user_membership.{add,remove}`. Repeated membership writes with no
state change send no event.

POST requests use the Okta `com.okta.event_hook` envelope, `eventId`,
`cloudEventsVersion: "0.1"`, and `data.events[]` LogEvent objects. Event targets
use the IDs and names from the changed records. Actor data comes from the
request user. Unknown location and authentication details are null.
The receiver gets the configured authentication and custom headers. Okta
uses header authentication for these hooks; there is no payload signature.

A 200 or 204 response completes delivery. A timeout, connection error, or 5xx
response gets one retry with the same event body and IDs. The local timeout is
three seconds; the local retry delay is one second. Inactive and unverified
hooks receive no events. `events.items` selects event types.

Limitations: HTTP is allowed for local receivers; production requires HTTPS.
Expression filters are rejected. System Log storage, event batching, quotas,
all other event types, and production delivery timing are not implemented.
Delivery queues and hook records are held in memory.

Contract sources: [Okta event hooks](https://developer.okta.com/docs/concepts/event-hooks/),
[Event Hooks API](https://developer.okta.com/docs/api/openapi/okta-management/management/tag/EventHook/),
and [event types](https://developer.okta.com/docs/reference/api/event-types/).

## State, reset, and Workbench

Management writes change the in-memory store. The Workbench reads users,
groups, and applications from the live API. It has no Okta write control. Reset
restarts and reseeds the store. Stop does not preserve this state.

Implementation: emulate.dev with WorldFixture event hook routes and delivery.
Compiler tests cover the projection.

Provider authority: [Okta API](https://developer.okta.com/docs/api/).
