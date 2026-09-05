# How WorldFixture fits your development loop

## What you get

- Local provider APIs and protocols for your application.
- Generated URLs, ports, credentials, and tokens for the active run.
- A Workbench that shows and changes the same state as your application.
- Repeatable starting data, time, scheduled events, and failure targets.
- One reset command for WorldFixture-owned state.

## The development loop

![WorldFixture development loop. The up command starts a local world and prints bindings. An application and the Workbench then use the same local service state.](/architecture/containers.svg)

Run `worldfixture up`. Use the printed bindings in your application. Read or
write through a provider API, then inspect the same state in the Workbench. Run
`worldfixture reset` when you need the accepted starting state again.

## What happens to the world JSON

WorldFixture does not compile executable code. `worldfixture build` validates
and prepares source JSON as a versioned world artifact. The artifact contains
normalized data, service-specific JSON projections, and file digests.

WorldFixture does not stream the source JSON because each service needs a
different input shape. Preparing it first also finds invalid data before any
service starts and gives reset a fixed baseline.

Shipped worlds are prepared before release. On each normal start, WorldFixture
prepares a session copy of a shipped world so relative dates match the current
time. Use `--no-rebase` to use its original dates. A custom `--world-path` must
already point to a prepared artifact.

During the run, services read their projections from the artifact. They keep
their live state after startup. The Workbench calls those same services; it does
not keep a separate copy of provider state.

Reset restores WorldFixture-owned service state from the same artifact. It does
not reset PostgreSQL or MariaDB data.

For the next steps, see [how worlds work](./guides/worlds.md),
[connect an application](./getting-started/connect-an-app.md), and
[reset and persistence](./guides/reset-and-persistence.md).
