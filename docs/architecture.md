# How WorldFixture fits your development loop

## What you get

- Local provider APIs and protocols for your application.
- Generated URLs, ports, credentials, and tokens for the active run.
- A Workbench that shows and changes the same state as your application.
- Repeatable starting data, time, scheduled events, and failure targets.
- One reset command for WorldFixture-owned state.

## The development loop

![WorldFixture development loop. The up command starts a local world and prints bindings. An application and the Workbench then use the same local service state.](/architecture/containers.svg)

Run `npx worldfixture up`. Use the printed bindings in your application. Read or
write through a provider API, then inspect the same state in the Workbench. Run
`npx worldfixture reset` when you need the accepted starting state again.

## From source to running services

![WorldFixture architecture. Source JSON becomes a prepared artifact. The runtime loads the artifact into local services. The application and Workbench use the same service state. Actions that the runtime originates and observes create events, and reset restores the artifact baseline.](/architecture/system.svg)

`worldfixture build` validates source JSON and prepares a versioned artifact.
The artifact contains the baseline, service projections, timeline, and file
digests. At startup, the runtime verifies this data and starts the selected
local services.

WorldFixture does not stream source JSON because each service needs a different
input shape. Preparation also finds invalid data before a service starts.

Your application calls the services through generated bindings. Workbench
actions reach the same services through the runtime API. Actions that the
runtime originates and observes enter its event ledger after the provider
accepts them. Reset restores WorldFixture-owned state from the prepared artifact.

## Session dates

Shipped worlds are prepared before release. On each normal start, WorldFixture
prepares a session copy of a shipped world so relative dates match the current
time. Use `--no-rebase` to use its original dates. A custom `--world-path` must
already point to a prepared artifact.

For the next steps, see [how worlds work](./guides/worlds.md),
[connect an application](./getting-started/connect-an-app.md), and
[reset and persistence](./guides/reset-and-persistence.md).
