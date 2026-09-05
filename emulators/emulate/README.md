# WorldFixture provider emulator

This service composes the pinned `emulate` 0.10.0 packages into provider-shaped
local APIs. The default WorldFixture image uses it for Slack, GitHub, Google,
Stripe, Resend, Clerk, Okta, Microsoft, Vercel, MongoDB Atlas, Apple, Linear
and Twilio. Notion is WorldFixture's own vendor, written here rather than taken
from upstream, and is loaded the same way: a directory under `src/vendors/`
exporting a plugin is discovered by its name, and a local directory shadows an
upstream vendor of the same name.

Each vendor starts only when its `WORLDFIXTURE_PORT_<VENDOR>` value is set. Each
listener uses `WORLDFIXTURE_BIND_<VENDOR>`, or `127.0.0.1` when no bind address
is set.

AWS is not started by the default environment. Its S3 routes conflict with the
SeaweedFS service, which is the selected S3 owner.

## Run the service

The normal path is the product image from the repository README. For a
standalone Slack development run, first build the v3 artifact from the
repository root, then run:

```sh
cd emulators/emulate
npm ci
WORLDFIXTURE_WORLD_PATH=../../dist/business.saas-company.v3 \
WORLDFIXTURE_PORT_SLACK=4703 \
node src/main.mjs
```

The service reads and verifies
`projections/emulator-overlay.json` against the artifact manifest before it
starts a listener.

## Configuration

- `WORLDFIXTURE_WORLD_PATH` selects a compiled world artifact.
- `WORLDFIXTURE_SEED` selects the base YAML seed. The default is `seed.yaml`.
- `WORLDFIXTURE_SEED_OVERLAY` adds one JSON object after the world projection.
- `WORLDFIXTURE_PORT_<VENDOR>` enables a vendor on that port.
- `WORLDFIXTURE_BIND_<VENDOR>` sets its bind address.
- `WORLDFIXTURE_STATE_PATH` stores the accepted reset snapshot.
- `WORLDFIXTURE_PUBSUB_PUSH_URL` sets the Gmail push target.
- `WORLDFIXTURE_TIMELINE_OWNER=runtime` makes the runtime the only timeline
  owner.

See [SEEDING.md](SEEDING.md) for seed precedence and validation.

## Readiness

Every started listener serves `GET /_worldfixture/ready`. The response reports
each selected vendor and the result of its own protocol check. A vendor without
a measured check makes the aggregate response not ready.

The service manifest in `service.json` lists the per-vendor checks, ports,
bindings, and capabilities.

## Authentication and reset

Tokens identify one seeded provider user. An unknown bearer token is refused;
it does not become the default user. OAuth access tokens minted by a provider
are added to the same token map.

On first start, the service records the accepted stores and token map. Reset
restores that snapshot. It does not seed a second copy over changed state.

## Tests

Run from this directory:

```sh
npm test
```

The suite checks identity, seed verification, Slack history, GitHub issues,
Google behavior, Gmail push, reset data and aggregate readiness. It also runs
the Stripe billing contract tests and the Notion suite under
`src/vendors/notion/`, which is the largest part of it.

## License and dependencies

WorldFixture code is available under Apache License 2.0. Upstream provider
packages are pinned in `package-lock.json`. `npm ci --ignore-scripts` installs
the exact recorded package bytes for the image build.

The Notion provider supports REST, OAuth, Admin, Workers, webhooks, and the
exact 41-tool hosted `tools/list` contract for Streamable HTTP MCP. The
tool-result envelope coverage is partial and is documented in
[`docs/providers/notion.md`](../../docs/providers/notion.md).
