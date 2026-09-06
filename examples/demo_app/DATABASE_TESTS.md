# Account Desk database checks

Run from this example after `npm ci`:

```sh
ACCOUNT_DESK_TEST_IMAGE=ghcr.io/ben-ic/worldfixture:0.2.5 node scripts/check-databases.mjs
```

The image must already exist locally; `docker pull` it first, or name a local
build. This command does not build or publish it.

The check creates two temporary projects outside this repository. One selects
PostgreSQL. The other selects MariaDB. Both use the installed `worldfixture`
package in this example through `npx --no-install worldfixture`.

Each project starts only HTTP targets and its selected database. It then:

1. Refuses an incorrect database password.
2. Creates, reads, and updates an app draft through `createStore`.
3. Confirms that a failed transaction leaves no draft or receipt.
4. Closes and opens the database connection. The saved draft remains.
5. Runs `npx worldfixture reset` in that temporary project.
6. Confirms that the saved draft remains after reset.
7. Removes only records in its exact test namespace.
8. Runs `npx worldfixture down` in that temporary project.

It does not reset or stop the normal Account Desk demo world. It prints the
temporary project paths and a secret-free `report.json` location. Temporary
project files remain for inspection. The test containers are removed.

## Verified result

Both profiles passed on 2026-09-06 with Node 26.5.0, installed WorldFixture
0.2.3, and the published `ghcr.io/ben-ic/worldfixture:0.2.5`:

```text
sha256:de90b87caba05396b7570807fed2ae50d85e0f82ab302cfabc8ad1ed21d9d41e
```

This is the run that retired the locally built image. The PostgreSQL host
authentication fix this example used to need a private build for is in the
published image, so the check now passes on a tag anybody can pull.

They also passed on 2026-09-05 with the same CLI and a local build,
`sha256:0cc583df8dec71b84b58b143558b418884a8285dcb75180d9e136c0590a4b080`.

| Check | PostgreSQL | MariaDB |
| --- | --- | --- |
| Generated bindings and password refusal | Passed | Passed |
| Create, read, update, and transaction rollback | Passed | Passed |
| Saved data after reconnect | Passed | Passed |
| App data preserved by normal world reset | Passed | Passed |
| Exact test-record cleanup and own instance shutdown | Passed | Passed |

The PostgreSQL result uses the corrected host authentication policy in
`emulators/postgres/worldfixture-entrypoint.sh`. TCP clients must use SCRAM.
The earlier local image refused host connections from the Docker bridge.

## Limits

This proves the app storage path with the installed CLI and a corrected local
image. It does not prove that the published default image contains this fix.
The check reuses installed dependencies; it is not a clean npm installation
test. It does not test production databases, backup recovery, high load, or
data retention after `worldfixture down`.

The app records are separate from provider state. Database reset and provider
reset are not interchangeable.
