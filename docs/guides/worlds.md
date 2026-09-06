# How worlds work

A world is a versioned source dataset for a synthetic environment. It can include
people, organizations, provider identities, domain records, and scheduled arrivals.
An organization or a company profile is not required.

`worldfixture build` validates the source and creates a prepared,
content-addressed artifact.
The artifact contains the normalized world and one JSON projection for each
service. The runtime selects service implementations, assigns host ports,
supplies the projections, and waits for declared readiness checks.

List the available artifacts, then select one by its manifest identity:

```sh
npx worldfixture worlds
npx worldfixture worlds --json
npx worldfixture up consumer.retail-brand:v1
```

The catalogue uses the manifest's ID and version, so a renamed artifact
directory keeps its identity. Invalid artifacts remain visible in the list
and cannot start.

Use one explicit selector: `up <id:version>`, `up <artifact-directory>`,
`up --world <name-or-path>`, or `up --world-path <artifact-directory>`.
Conflicting or unknown selectors fail before project or run files are written.
Both direct and container starts use the same selection.

Without an explicit selector, `up` uses the optional `world` string in
`.worldfixture/project.json`, then the default `business.saas-company:v3`.
For example, add `"world": "consumer.retail-brand:v1"` to the project config.
A relative artifact path in that setting starts from the project directory.
Startup prints the selected identity, artifact path, and selection source.

By default, the runtime attempts to rebase dates from a verified source to the
current time. If the source is unavailable or the rebuild fails, it uses the
original artifact. Add `--no-rebase` to keep the selected artifact's original
dates in either launch mode.

## Switch a running world

Open the world picker in Workbench, or use the CLI:

```sh
worldfixture switch consumer.retail-brand:v1 --no-rebase
worldfixture switch ./my-built-world --no-rebase
worldfixture switch --status
```

Switch checks and copies the candidate before it stops providers. It then waits
for accepted operations, replaces provider state, rotates provider credentials,
checks readiness, and publishes a new generation. Application database processes
and rows remain. Manual provider changes are removed.

The picker includes packaged and imported artifacts. A host path is copied into
the session catalogue before the container reads it. An ambiguous identity needs
an exact artifact path. Invalid artifacts remain visible with their errors.

After a switch, the clock is in setup mode. Update the application's bindings and
token from `worldfixture env`, then confirm its connector for this generation:

```sh
worldfixture switch --connect http://localhost:3000
worldfixture clock start 0s
```

For a world that needs no application connector, use
`worldfixture switch --without-application` before starting the clock. Workbench
also has connection confirmation and starting-position controls. Old connector
mappings are not reused. Already accepted connector event receipts remain, so
returning to a world does not repeat mutations into preserved application data.

A failed switch restores the previous world's baseline in a new setup generation
when possible. This removes its earlier manual provider changes. If recovery also
fails, providers remain stopped and the transition record gives a repair action.
An interrupted transition must be inspected before another startup can seed data.

A running container is reused only when its original selected
world ID, version, and digest match the requested artifact. Stop the current
run before starting a different artifact.

Use `worldfixture new` to copy the small starter source:

```sh
npx worldfixture new ./my-world
npx worldfixture validate ./my-world
npx worldfixture build ./my-world
npx worldfixture up ./dist/demo.minimal.v1
```

The copy keeps the starter ID and version until you edit `world.json`.
The build output path follows that identity, not the source directory name.

If an artifact fails validation, `worldfixture doctor --world-path <directory>`
uses a verified source path in its repair command, including for a renamed
artifact. If the source cannot be verified, it reports that the source path
is unavailable.

World data is dynamic. Application and Workbench code must discover people,
channels, pages, repositories, products, and identifiers from the active world
or provider API. Code must not depend on names from the default world.

See [how WorldFixture fits your development loop](../architecture.md) for what
happens before and during a run, and the [CLI reference](../reference/cli.md)
for selection options and catalogue JSON fields.

## Declare OAuth clients

Declare local applications under `software.oauth_clients`, keyed by provider.
A provider with no declared clients rejects client authorization and token
exchange. Source files contain client IDs and callback URLs. The runtime creates
client secrets and resolves them only when it starts the provider.

```json
{
  "software": {
    "oauth_clients": {
      "google": [
        {
          "client_id": "my-local-app",
          "name": "My local application",
          "redirect_uris": ["http://localhost:3000/auth/callback"],
          "scopes": ["openid", "email", "profile"]
        }
      ]
    }
  }
}
```

Build and start the world, then use `worldfixture env` to read
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Other providers use the same
uppercase prefix. These bindings are added only when the provider is selected.
A single declared client is the default. With multiple clients, set
`"primary": true` on exactly one client to select the application's bindings.
Without a primary client, all declared clients can be used, but no default
client bindings are added.

Callback URLs must match exactly, including their port and path. Wildcards and
fragments are rejected. Do not put `client_secret` in world source. The generated
reference is `oauth-client-secret:<provider>:<client_id>`; it is not a usable
secret. Changing the application callback requires a source change and rebuild.

| Provider | Local grants | Additional client fields |
| --- | --- | --- |
| Apple | Authorization code, refresh token | A generated shared secret, or `public_key`, `team_id`, and `key_id` for an ES256 client assertion |
| Clerk | Authorization code | `is_public: true` selects a public client and requires S256 PKCE |
| Okta | Authorization code, refresh token, confidential client credentials | Optional `auth_server_id`; `token_endpoint_auth_method: "none"` selects a public client with S256 PKCE |
| Google | Authorization code, refresh token | Confidential client |
| Microsoft | Authorization code, refresh token, client credentials | `tenant_id` for the local tenant |
| GitHub | Authorization code | Confidential client |
| Slack | Authorization code | Confidential client; requested user scopes are separate from bot scopes |
| Linear | Authorization code, refresh token | Declared user actor only; application actors are not supported |
| Vercel | Authorization code | Confidential client |

These are local provider flows. Reset restores the accepted starting state and
invalidates codes and refresh tokens issued after that state was saved. The
provider pages list the supported routes and remaining limits.

## Finance dates and one-time purchases

`finance.payments` contains explicit successful settlements with a stable `id`,
`customer_id`, `amount_cents`, `paid_on`, `status: "succeeded"`, and an
`invoice_id` or `order_id`. Refunds use `finance.refunds` with a stable `id`,
`payment_id`, `amount_cents`, `refunded_on`, and `status: "succeeded"`.
Currency can be declared on each record; otherwise it follows its finance
relationship and the world's finance currency.

A paid invoice needs dated settlements for its full amount. A payment cannot
precede its invoice or order, or follow the world's starting anchor. A refund
cannot precede its payment, follow the anchor, or exceed the payment amount.
The due date does not specify when payment occurred. Use explicit synthetic
payment dates for early and late settlements.

For legacy monthly history, an authored payment that names a generated invoice
replaces that invoice's generated default payment. An empty `finance.payments`
array adds no authored settlements; it does not remove the declared monthly
history. A one-time customer declares `billing_mode: "one_time"` and a
`revenue_account` and creates no recurring history or subscription.

When dates are rebased, the original generated invoice, payment, and bill
schedule moves by the same whole-week date offset as authored records. IDs,
amounts, currencies, and record links stay stable. The rebased artifact records
`clock.rebase.finance_history.origin_anchor` and cumulative `day_shift` so a
second rebase preserves the same schedule. These values are generated by rebase;
authors do not need to add them to the original source.
