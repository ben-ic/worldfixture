# Provider emulator seeding

The provider composer builds one seed object in this order:

1. Require a world artifact and read its verified projection from
   `$WORLDFIXTURE_WORLD_PATH/projections/emulator-overlay.json`.
2. Merge the JSON object in `WORLDFIXTURE_SEED_OVERLAY`, when present.
3. In a managed run, replace credential references with values from
   `WORLDFIXTURE_CREDENTIALS`. A missing value stops startup.

Later values replace earlier values. Objects merge recursively. Arrays replace
arrays.

## World projection

The composer accepts only a `worldfixture.world-artifact/v1` artifact. Its
manifest must list the emulator overlay with the correct byte size and SHA-256
digest. A missing, changed, or invalid overlay stops startup before a provider
listener opens.

The prepared world artifact owns provider users, identities, messages, repositories,
customers, and other provider records. An absent source section cannot inherit
sample records from a base seed. The service refuses startup without a world.

The exported `loadSeedConfig` helper retains YAML parsing for library callers
and parser tests that supply no `worldPath`. `seed.yaml` is its explicit legacy
test fixture. This helper path cannot start the service without a world.

## Tokens

In an artifact, the top-level `tokens` object maps each readable identity
reference to a provider login and a scope list:

```yaml
tokens:
  slack_token_maya:
    login: maya
    scopes: []
```

The login must exist in the selected vendor seed. Use a separate token for each
vendor identity. The compiler and `tests/parity` do not change for this scheme:
the artifact keeps these references and the same bytes. Only a standalone
composer without a credential file uses the references as bearer tokens.

Managed startup generates the full credential set before services start. The
project store is `.worldfixture/generated-secrets.json` (mode 0600, ignored by
Git and Docker). Atomic replacement and a directory lock protect concurrent
starts. Values are keyed by world identity and credential reference, not by
artifact digest. They remain stable across launches and date changes. Different
projects get different credentials, even when they use the same world.

Each run gets a private `credentials.json` snapshot. Seeding, `worldfixture env`,
Slack commands, arrivals, mail, and Workbench all use that snapshot. A second
terminal must select the same project or `--state` directory. It must not create
replacement credentials. A missing run file fails with a restore/restart error;
a missing project store does not change a running service's accepted values.
To recover a lost project store without changing credentials, restore its backup.
Starting a new run with no project store generates a new set.

Mail passwords, the Cyrus admin password, Twilio account/API-key secrets, and
declared Clerk passwords follow the same rule. OAuth-issued access tokens keep
their provider lifecycle; this scheme does not replace them with a seed token.
The API-key boundary for Stripe, Resend, and MongoDB Atlas refuses unknown and
anonymous requests. Linear GraphQL also refuses an unknown caller instead of
using the first admin. This does not add production-grade provider authorization
or replace the separate S3 service's signature checks.

## Session overlay

`WORLDFIXTURE_SEED_OVERLAY` is useful for values that belong to one run, such as
an OAuth client with the target application's actual callback address:

```sh
WORLDFIXTURE_SEED_OVERLAY='{"slack":{"oauth_apps":[{"client_id":"local-client","redirect_uris":["http://127.0.0.1:3000/callback"]}]}}'
```

Do not put real credentials in the base seed, a world source, an artifact, or
an image.

## Timeline ownership

The WorldFixture runtime owns scheduled v3 arrivals. It starts the composer with
`WORLDFIXTURE_TIMELINE_OWNER=runtime` so one arrival cannot run twice.

## Tests

Run from `emulators/emulate`:

```sh
npm test
```
