# WorldFixture provider API service

This document is for contributors who run the provider service by itself. For
product use, start with the [five-minute quick start](../../docs/getting-started/quick-start.md).

This service composes the pinned `emulate` 0.10.0 packages into provider-shaped
local APIs. The default WorldFixture image uses it for Slack, GitHub, Google,
Stripe, Resend, Clerk, Okta, Microsoft, Vercel, MongoDB Atlas, Apple, Linear
and Twilio. Notion is WorldFixture's own implementation, written here rather than taken
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
npm run build:worlds
cd emulators/emulate
npm ci
WORLDFIXTURE_WORLD_PATH=../../dist/business.saas-company.v3 \
WORLDFIXTURE_PORT_SLACK=4703 \
node src/main.mjs
```

Port `4703` is a fixed standalone test port. A normal `worldfixture up` run uses
a dynamic host port. Read it from `SLACK_BASE_URL`.

The service reads and verifies
`projections/emulator-overlay.json` against the artifact manifest before it
starts a listener.

## Configuration

- `WORLDFIXTURE_WORLD_PATH` selects a prepared world artifact.
- The service requires a verified world artifact. It does not read a base YAML seed.
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

Authentication behavior is provider-specific. Some tested routes map a token
to a seeded user, and some routes do not enforce production authentication.
Read the provider support page before you depend on an authentication branch.
OAuth access tokens minted by a provider are added to its token map.

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
