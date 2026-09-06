# Sign in with Apple

WorldFixture uses `@emulators/apple` 0.10.0.

| Question | Answer |
| --- | --- |
| Overall API status | **Supported but partial** |
| Production comparison | **Not verified against the production provider** |
| Workbench | **Not supported** |
| State and reset | Local OAuth state; reset restores the accepted snapshot |
| Implementation owner | emulate.dev |

“Partial” means that only the six routes below are registered.

## What works

You can run a local authorization-code flow, refresh a token, read the signing
keys, and revoke a token.

## What does not work

Server account-change events, user migration, user transfer, and email relay
do not work. There is no Apple
Workbench screen.

## Connection and authentication

Use `APPLE_BASE_URL` and `APPLE_TOKEN`. The local browser flow selects a
declared world user. [Declare the application in the world](../guides/worlds.md#declare-oauth-clients).
The token route requires the declared client and exact callback URL. It accepts
the generated shared secret or an ES256 assertion checked against the declared
`public_key`, `team_id`, and `key_id`.

## Registered routes

| HTTP method and path | Required input | Important response fields |
| --- | --- | --- |
| `GET /.well-known/openid-configuration` | None | Issuer and local endpoint URLs |
| `GET /auth/keys` | None | `keys` JWKS array |
| `GET /auth/authorize` | OAuth query values, including `client_id`, `redirect_uri`, `response_type`, and `state` | Local account selection page or redirect |
| `POST /auth/authorize/callback` | Selected local user and OAuth values | Redirect with local authorization code |
| `POST /auth/token` | Form body with an authorization code or refresh token | `access_token`, `refresh_token`, `id_token`, `token_type`, and `expires_in` |
| `POST /auth/revoke` | Form token value | Local revocation result |

Authorization-code and refresh-token responses include local access, refresh,
and RS256 ID tokens.

## Detailed limits

The local wrapper checks a supplied PKCE challenge during code exchange.
Apple production consent and token behavior remain **Not verified against the
production provider**.

Server account-change events, user migration, user transfer, email relay, and
other Apple APIs are **Not supported**. There is no Apple Workbench screen. No
official Apple SDK has a test.

## Evidence and authority

Evidence: `emulators/emulate/src/overrides/declared-oauth.test.mjs`,
compiler projection tests under `tests/contracts/`, the registered
routes in `@emulators/apple` 0.10.0, and the `GET /auth/keys` readiness check
in `emulators/emulate/service.json`.

Authority: [Sign in with Apple REST API](https://developer.apple.com/documentation/signinwithapplerestapi).
