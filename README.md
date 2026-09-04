# WorldFixture

WorldFixture runs reproducible software worlds on a local computer. A world can
contain people, messages, repositories, mail, files, and a live timeline.
Applications, MCP servers, tests, scripts, people, and AI agents use normal
provider-shaped APIs and protocols to work with that world.

> [!WARNING]
> WorldFixture is pre-release software. See the
> [release checklist](docs/release-checklist.md) for the external-use proof.

## What you get

- One local Docker container with a complete synthetic world.
- Slack, GitHub, Google, Stripe, S3, SMTP, IMAP, and other service interfaces.
- A CLI for lifecycle, health, people, messages, mail, and events.
- An optional Workbench for inspection and manual actions.
- A deterministic world compiler and schema-validated artifacts.
- A world-relative clock and scheduled arrivals that use the same provider
  interfaces as manual actions.
- No hosted runtime and no model calls in the default experience.

All included people, organizations, messages, and financial records are
synthetic.

## Quick start

### Requirements

- Docker with Buildx
- Node.js 22 or later
- An `arm64` or `amd64` computer

Build the local image:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  worlds/business.saas-company.v3/world.json \
  --output dist/business.saas-company.v3
docker buildx build --load -t worldfixture:local .
```

Start the default `business.saas-company:v3` world:

```sh
node runtime/bin/worldfixture.mjs up
```

The command starts one background container. It uses the preferred local ports
when they are free and selects free ports when they are in use. It records and
prints the actual addresses.

A full v3 start takes about a minute and a half, because the mail service
creates a mailbox for every person and delivers all 3,069 seeded messages over
LMTP. The Workbench URL is printed after a second or so and is usable while the
rest of the world is still loading.

Start only the parts you need and that wait mostly disappears:

```sh
node runtime/bin/worldfixture.mjs up --only slack,github
```

Measured on an arm64 machine, with the image already pulled: every part 92s,
`slack,github` 3s. The parts are `slack`, `github`, `site`, `mail`, `s3` and
`providers`; the default is all of them.

Almost all of that wait is mail, which creates a mailbox for every person and
delivers all 3,069 messages over LMTP. It is not the size of the world: the
two-person starter world takes 35s to start every part, because the cost is the
number of services, not the number of records. So `--only` is the lever, and a
smaller world is not.

Use the world from another terminal:

```sh
node runtime/bin/worldfixture.mjs status
node runtime/bin/worldfixture.mjs people
node runtime/bin/worldfixture.mjs slack history --channel general
node runtime/bin/worldfixture.mjs mail inbox --as maya
node runtime/bin/worldfixture.mjs open
node runtime/bin/worldfixture.mjs events --follow
```

Run `node runtime/bin/worldfixture.mjs env` to print application bindings. Use
Ctrl-C to stop `events --follow`. The background world continues to run.

Restore or stop the instance:

```sh
node runtime/bin/worldfixture.mjs reset
node runtime/bin/worldfixture.mjs down
```

`reset` restores provider, mail, storage, runtime, clock, and timeline state to
the accepted start. It preserves PostgreSQL and MySQL application data. `down`
stops and removes the container but keeps the local diagnostic state in
`.worldfixture/`.

If startup or a service fails, run:

```sh
node runtime/bin/worldfixture.mjs doctor
```

`doctor` reports problems and recommended commands. It does not change state.

## Example applications

Start WorldFixture first. Then use one of these examples:

- [Relay Digest](examples/regular-app/README.md) is a normal Node.js SaaS
  application. It reads and changes the world through provider APIs.
- [Renewal Copilot](examples/mcp-server/README.md) is an MCP server with a review
  UI and a human approval step.
- [The protocol application](examples/protocol-app/README.md) is a small Python
  release gate for SMTP, IMAP, HTTP, and S3.

## Connect your application

An application connector maps neutral world packs to an application's existing
domain model. It can seed a starting state and accept live events. The connector
is enabled only for local development or tests.

Run these commands from the application root:

```sh
npx worldfixture up
npx worldfixture connector prompt http://localhost:3000
npx worldfixture run -- npm run dev
```

Give the generated prompt to a coding agent. The portable
`add-worldfixture-connector` skill is in `skills/add-worldfixture-connector`.
After the agent adds the connector, check and seed it:

```sh
npx worldfixture connector check http://localhost:3000
npx worldfixture connector plan http://localhost:3000
npx worldfixture connector seed http://localhost:3000
```

The Workbench provides the same connect, prompt, preview, seed, and live event
operations under **Target**. See the
[connector overview](docs/connectors/overview.md).

### Seed less than the whole world

A full seed of the v3 world sends 13,385 records. A quick check does not need
them, so `plan`, `seed` and `check` take a slice:

```sh
npx worldfixture connector seed http://localhost:3000 --scale smoke
npx worldfixture connector seed http://localhost:3000 --limit people=25,messages=5
```

`smoke` keeps at most 25 of anything and sends about 570 records. `sample` keeps
at most 250. `full` is the default. `--limit` sets counts per collection and
overrides the preset for the collections it names; a nested list such as
`messages` is counted per parent, so `messages=5` means five per channel.

A slice is always whole. It never contains a record that refers to a record it
does not contain, and it never empties a collection the world has records in — a
membership list such as `member_ids` is trimmed to the people who are present
rather than the record being dropped. The command prints what it actually sent,
including any collection that came out short because something it depends on was
left out.

Each slice is its own seeding operation, so seeding `smoke` and then `full` is
two operations rather than a repeat, and the second carries the records the first
did not.

### Optional PostgreSQL or MySQL database

Select optional services in `.worldfixture/project.json`:

```json
{
  "api_version": "worldfixture.project/v1",
  "application_url": "http://localhost:3000",
  "services": ["mysql"]
}
```

Use `"postgres"` instead for PostgreSQL. `worldfixture run` supplies the active
connection bindings. MySQL-compatible MariaDB 10.11 provides `MYSQL_HOST`,
`MYSQL_PORT`, `MYSQL_USERNAME`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, and
`MYSQL_URL`. PostgreSQL provides the equivalent `POSTGRES_*` bindings. Ports can
change when a preferred port is in use, so applications must use these values.

Normal `worldfixture reset` preserves database data. The connector always
declares database reset unavailable and never deletes application records. A
future destructive database rebuild must use a separate, explicit command.

## Main commands

```text
worldfixture up [world]        Start or reuse a local instance
  --only <parts>               Start only these parts of the world
  --no-rebase                  Start the world at its authored anchor, not today
  --world-path <dir>           Start a world artifact you built yourself
worldfixture build <source>    Compile a world source into an artifact
  --output <dir>               Where to write it (default dist/<id>.<version>)
worldfixture validate <source> Check a world source without building it
worldfixture open              Open the recorded Workbench URL
worldfixture status            Show live service health
worldfixture env               Print application bindings
worldfixture doctor            Diagnose the local setup
worldfixture reset             Restore the accepted starting state
worldfixture down              Stop and remove the instance
worldfixture people            List people and provider identities
worldfixture slack ...         Read or send Slack messages
worldfixture mail ...          Read mail over IMAP
worldfixture events [--follow] Read the runtime event ledger
worldfixture new <dir>         Copy the starter world, ready to edit
  worldfixture connector ...     Check, seed, or send events to an application
  --scale <name>               How much of the world to send: smoke, sample, full
  --limit <list>               Per-collection counts, as people=25,messages=5
worldfixture run -- <command>  Run an application with active bindings
```

Run `node runtime/bin/worldfixture.mjs --help` for options.

## Build a world artifact

The default v3 world is the active product world. The smaller v2 world remains
the compatibility and byte-parity fixture.

`consumer.retail-brand:v1` is a second world of a different shape: a
direct-to-consumer homeware brand with a catalog, an order book, a subscription
club, product reviews and a public journal. It is deliberately small — 41 people
and about 150 messages — so it starts in seconds with every part running. It is
in the product image alongside the other two.

```sh
node runtime/bin/worldfixture.mjs up consumer.retail-brand:v1
```

### Build your own world

`worldfixture build` compiles a world source into an artifact. The compiler runs
inside the WorldFixture image, so this needs Docker and Node and nothing else —
no Python, and no checkout of this repository.

A world source is a directory holding a `world.json`: either a self-contained
`worldfixture.world-source/v1` world, or a `worldfixture.world-manifest/v1`
manifest naming fragment files beside it. The worlds under `worlds/` are worked
examples of the second shape at full size.

`worldfixture new` hands you the smallest world that runs -- two people, one
channel, two messages, one project and one task -- ready to edit. It works the
same whether WorldFixture came from npm or from a checkout.

```sh
npx worldfixture new ./my-world
```

See [`examples/minimal-world`](examples/minimal-world/README.md) for what each
file is and which rules the compiler enforces.

`validate` compiles the world and throws the result away, so anything it accepts
will build. The `business.operations/v1` profile compiles seven domains and
indexes rather than defaults them, so a world declares `communication`,
`finance`, `software`, `support`, `work`, `agentic` and `stories` even when it
has no records for one; `validate` names any that are missing.

```sh
npx worldfixture validate ./my-world
npx worldfixture build ./my-world
npx worldfixture up ./dist/demo.my-world.v1
```

`build` writes to `dist/<id>.<version>` unless `--output` says otherwise, and
prints the `up` command for what it wrote. `up` takes the artifact directory as
its first argument or as `--world-path`, and the world source is mounted
read-only, so a build can only ever write to the output directory.

Because the image compiles the world, the artifact always matches the runtime
that will serve it. A world started this way starts at its authored anchor
rather than today: rebasing needs the world source, and `up` is given the
artifact.

Validate and compile v3 from a checkout, with Python:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler validate \
  worlds/business.saas-company.v3/world.json
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  worlds/business.saas-company.v3/world.json \
  --output dist/business.saas-company.v3
```

Create one deterministic bundle:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler bundle \
  worlds/business.saas-company.v3/world.json \
  --output dist/business.saas-company.v3.tar
```

Bundle members have fixed ownership, permissions, timestamps, and order. The
same source produces the same artifact bytes.

### The world's clock

A world is authored at a fixed anchor, and every date in it is relative to that
anchor. `up` rebases the world onto the day it is started, so the world's own
"now" follows the session: history ends a day or two before today, scheduled
arrivals are still ahead, and a message you send lands at the top of the list
instead of a year below it. The first screen prints both dates.

This is the one thing about a running instance that is not a function of the
source alone. The compiler is unchanged: the same source at the same anchor
still produces the same bytes, and `worldfixture up --no-rebase` starts the
world exactly as it was built.

## Architecture

```text
world definition -> deterministic artifact -> environment lock -> instance
                                                               -> reset
```

The runtime has three main concepts:

1. A **world** is immutable starting data, relationships, identities, history,
   and optional scheduled arrivals.
2. A **service** provides a real interface, such as Slack, SMTP, IMAP, GitHub,
   or S3, from a projection of the world.
3. The **runtime** owns the clock, commands, observations, schedules, causal
   rules, and local lifecycle.

The default image uses `tini` as PID 1. One Node.js supervisor starts the
provider composer, HTTP targets, Cyrus IMAP, SMTP, SeaweedFS, SQLite runtime,
and Workbench. Applications do not read internal stores. They use the published
interfaces.

## Repository guide

```text
compiler/worldfixture_compiler/   deterministic world compiler
schemas/                          public JSON Schema contracts
worlds/                           reviewed synthetic world sources
runtime/                          CLI, resolver, supervisor, state, and UI
emulators/                        provider, HTTP, mail, and S3 services
examples/                         normal app, MCP server, and protocol client
tests/                            contracts, parity, and image tests
docs/                             release checks
```

Each service in `emulators/` has a README with its protocol, ports, test command,
and current limits.

Provider coverage is documented by provider. See the
[Notion support matrix](docs/providers/notion.md) and the
[provider implementation process](docs/providers/adding-a-provider.md).

## Development

Run the dependency-free compiler and contract tests:

```sh
PYTHONPATH=compiler python3 -m unittest discover -s tests -t .
```

Run the runtime tests:

```sh
cd runtime
npm test
```

Some runtime and protocol tests require Docker or a built
`worldfixture:local` image. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
test groups and change rules.

## Open-source foundations

| Project | Role | Pinned version | License |
| --- | --- | --- | --- |
| [`emulate`](https://github.com/vercel-labs/emulate) | Provider-shaped APIs | `0.10.0` | Apache-2.0 |
| [Cyrus IMAP](https://github.com/cyrusimap/cyrus-imapd) | Mailbox storage and IMAP | `3.6.1` | BSD-3-Clause-CMU and component notices |
| [SeaweedFS](https://github.com/seaweedfs/seaweedfs) | S3-compatible object storage | `4.41` | Apache-2.0 |
| [PostgreSQL](https://www.postgresql.org/) | Optional PostgreSQL database | `15.19` | PostgreSQL License |
| [MariaDB](https://mariadb.org/) | Optional MySQL-compatible database | `10.11.18` | GPL-2.0 |
| [SQLite](https://sqlite.org/) | Runtime events, schedules, cursors, and state | System package | Public domain |

Dependency versions stay pinned.

**Vendored interface descriptions.** The Notion emulator's contract tests assert
against fixed copies of Notion's published OpenAPI documents and one recorded
hosted MCP `tools/list` response, so that a test failure means the emulator
drifted rather than that the network did. These are interface descriptions, not
Notion software; their source, retrieval date, digest, and redistribution basis
are recorded in
[`emulators/emulate/contracts/notion/THIRD_PARTY_NOTICES.md`](emulators/emulate/contracts/notion/THIRD_PARTY_NOTICES.md).
Notion is a trademark of Notion Labs, Inc.; this project is not affiliated with
or endorsed by Notion.

**On MariaDB and the GPL.** MariaDB and PostgreSQL are unmodified distribution
packages installed into the container image and run as separate server
processes. WorldFixture reaches them over their wire protocols; no WorldFixture
code links against, statically or dynamically, or derives from either of them,
and neither is redistributed as part of the WorldFixture source. The image is an
aggregate of separately licensed works, each of which keeps its own licence:
MariaDB stays GPL-2.0, PostgreSQL stays under the PostgreSQL License, and
WorldFixture's own code stays Apache-2.0. Using WorldFixture in a commercial
setting therefore does not put a GPL obligation on your application.

Third-party notices for the mail, S3, and Notion contract material are in their
own directories.

## Project status

The product scope is the local runtime, v3 world, compiler, Workbench, and
examples that work today. The release proof is one outside developer who can
build the image, start the world, use it, reset it, and stop it from this README.
See the [release checklist](docs/release-checklist.md) for that proof.

WorldFixture is available under the [Apache License 2.0](LICENSE). Attribution
and the third-party notice index are in [NOTICE](NOTICE).
