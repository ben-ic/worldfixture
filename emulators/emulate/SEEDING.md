# Provider emulator seeding

The provider composer builds one seed object in this order:

1. Read the base YAML file from `WORLDFIXTURE_SEED`, or `seed.yaml`.
2. Merge the verified world projection from
   `$WORLDFIXTURE_WORLD_PATH/projections/emulator-overlay.json`.
3. Merge the JSON object in `WORLDFIXTURE_SEED_OVERLAY`, when present.

Later values replace earlier values. Objects merge recursively. Arrays replace
arrays.

## World projection

The composer accepts only a `worldfixture.world-artifact/v1` artifact. Its
manifest must list the emulator overlay with the correct byte size and SHA-256
digest. A missing, changed, or invalid overlay stops startup before a provider
listener opens.

The compiled world owns provider users, identities, messages, repositories,
customers, and other provider records. The base seed is only a standalone
development fallback.

## Tokens

The top-level `tokens` object maps each bearer token to a provider login and a
scope list:

```yaml
tokens:
  slack_token_maya:
    login: maya
    scopes: []
```

The login must exist in the selected vendor seed. Use a separate token for each
vendor identity. The composer refuses unknown bearer tokens.

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
