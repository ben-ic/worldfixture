# Changelog

## 0.2.2

Both of these were found by installing 0.2.1 from npm in an empty directory and
using it as a stranger would, with no checkout and no local image.

### Added

- `worldfixture new <directory>` copies the starter world, ready to edit. The
  README told the reader to `cp -r examples/minimal-world`, which works from a
  checkout and leaves an npm install with nothing to copy: the starter world sits
  inside `node_modules` at a path nobody should have to name. It is now shipped
  in the package and reachable by one command either way.

- **`up` now says what it is doing while it loads.** A full start takes about a
  minute and a half; it printed the Workbench URL after a second and then nothing
  at all until it finished. Ninety seconds of silence reads as a hang, and the
  useful answer -- everything is up except mail, which is delivering 3,069
  messages over LMTP -- was known inside the container the whole time and had
  nowhere to go. The runtime now publishes its phase and every service state, and
  `up` names the service still working rather than turning a spinner. On a
  terminal it rewrites one line; piped to a log or CI it prints each distinct
  state once and never repeats itself.

### Fixed

- **The first screen suggested a command that did not exist.** It ended with
  "Try this" and a bare `worldfixture slack send ...`, and somebody who installed
  the documented way -- `npx worldfixture up` -- has no `worldfixture` on their
  PATH, so the very first thing the product invited them to do answered
  `command not found`. Every suggested command is now written the way the reader
  actually invokes it: `npx worldfixture` for an npm install, `worldfixture` for
  a global one, and the file itself from a checkout.
- One repair message told the reader to rebuild with
  `python3 -m worldfixture_compiler`, which an npm install does not have.

## 0.2.1

0.2.0 reached npm before these landed. Both are in first-use error paths, which
is the worst place for a product to be second-rate.

### Fixed

- **A launch failure printed a stack trace.** `HostLauncherError` carries a
  written repair line for every case -- the image cannot be pulled, a port is
  held, a container of that name is not ours -- and the command line caught
  every other error type but not that one. So the most likely first failure of
  all, `worldfixture up` before the image is reachable, showed a Node stack
  trace naming an internal frame and buried the sentence that says what to do.
- **`build` and `validate` fetched the image before checking the source.** A
  mistyped path cost a 190 MB download before the command said the path does not
  exist, and when the registry itself was unreachable it reported the registry
  rather than the typo. The local check now runs first, and the message names
  the command that was actually typed rather than always saying `build`.
- `schemas/environment.v1.schema.json` described its `rules` field by citing a
  design document that is not published. It now describes the field.

## 0.2.0

The first release proved against applications this project did not write.
Connectors were built for Vikunja (Go, SQLite), Ghost (Node, MySQL),
Rocket.Chat (Node, MongoDB), Chatwoot (Rails, PostgreSQL) and Plane
(Django, PostgreSQL). Most of what follows was found by doing that.

### Added

- **Seed a slice of the world.** `connector check`, `plan` and `seed` take
  `--scale smoke|sample|full` and `--limit people=25,messages=5`. A smoke slice
  of the default world is about 570 records instead of 13,385. A slice is always
  whole: it never contains a record that refers to a record it does not contain,
  it never empties a collection the world has records in, and a membership list
  is trimmed to the people who are present rather than the record being dropped.
  Each slice is its own seeding operation, so seeding a small slice and then a
  larger one is two operations rather than a repeat. The Workbench offers the
  same choice.
- **Deliver an event the world produced.** `connector replay <url>` takes an
  observation from the runtime ledger and delivers it, resolving names to the
  identifiers the application was seeded with. `--list` shows the kinds this
  world produces, `--print` writes the event instead of sending it. The
  Workbench event control is built from the kinds the world has actually
  produced. Before this, nothing joined the two halves of the protocol, and the
  product's headline demonstration ended at a JSON file the user wrote by hand.
- **Build a world of your own.** `worldfixture build <source>` and
  `worldfixture validate <source>` run the compiler inside the product image, so
  authoring a world needs Docker and Node and nothing else — no Python and no
  checkout. `examples/minimal-world` is the smallest world that runs.
- **`consumer.retail-brand:v1`**, a consumer world: a direct-to-consumer brand
  with a catalog, an order book, a subscription club, reviews and a public
  journal. Deliberately small, so it starts in seconds.
- **A reference for what a connector receives.** `docs/connectors/packs.md`
  lists every pack, collection and field with a real record of each. It is
  generated from the artifact and checked by a test, so it cannot drift.
- `connector docs` now installs that reference alongside the protocol.

### Fixed

- **The local secret could reach the terminal.** It was passed to Docker as
  `--env NAME=value`, which puts it in `argv` — readable by any user through
  `ps`, and copied into the error `execFile` throws, so a failed `docker run`
  printed it in cleartext into scrollback and CI logs. It is now passed by name
  through the child's environment, and every line the CLI prints goes through a
  redaction step. `bindings.json` held a second copy at mode `0644` and is now
  `0600`.
- **A conformance check could fail a correct connector.** The response validator
  resolved only same-file schema references, and `connector-status` describes its
  receipts with a reference to `connector-receipt`. A connector passed the check
  while its status was empty and failed it the moment it seeded anything, and
  `connector status` exited with a stack trace.
- **The finance pack referred to records it did not carry.** Invoices and bills
  name a customer and a supplier, and those records were in the world source and
  never exported. A connector saw an opaque key with no name, no billing terms
  and no route to the organization.
- **A world could be seeded that was not the world running.** The artifact a
  connector is seeded from and the artifact the emulators serve are resolved
  separately and could differ, which also derived the idempotency key from the
  wrong artifact. A mismatch is now refused for a seed and reported for a plan.
- **`--world-path` was ignored** whenever an instance was running in the same
  directory, so a command that named a world read a different one.
- **A port Docker refused was not retried.** Reserving a host socket does not
  prove Docker can publish the port; a container from another project holding
  3306 made `worldfixture up` fail outright.
- **Launch failures printed a stack trace.** `HostLauncherError` carries a
  repair line for every case — the image cannot be pulled, a port is held, a
  container of that name is not ours — and nothing caught it, so the most likely
  first-use failure of all buried the sentence that says what to do.
- **`validate` accepted worlds that `build` refused**, sometimes with a bare
  Python traceback. It now compiles the world and discards the result, so
  anything it accepts will build.
- **`worldfixture connector` with no action** answered "an application URL is
  required", which is true of the action it was not given.
- Neither client showed a whole plan: the CLI dropped the mappings and the
  Workbench dropped the counts and warnings. A repeated seed was indistinguishable
  from a real one in both, so the only way to confirm idempotency was to count
  rows in the application's own database.
- The Workbench reported a refused token as an unreachable application, and
  crashed on a plan response that omitted a required field.
- The ready screen printed "Stop with Ctrl-C" and then continued for three more
  lines.
- Every world other than `business.saas-company` failed to start, because the
  default environment named that world's primary person.
- `cyrus-imapd` is pinned to `3.6.1-4+deb12u5`, the current Debian security
  build.

### Changed

- The protocol documentation names every required response field, including the
  closed `state` and `status` sets. It described the responses in prose that
  omitted fields the schemas required, so a connector written from the prose
  passed a superficial check and then failed against a strict one.
- `worldfixture connector check` validates every response against its published
  schema and names the missing field.
- The image carries all three worlds.

### Release record

- Image: `ghcr.io/ben-ic/worldfixture:0.2.1`, `linux/amd64` and `linux/arm64`,
  also tagged `0.2.0` and `latest`.
- Digest: `sha256:5e61a55700c9c455578fac98b3a9ff22cb8cd1bdea5c95a456766d040b087989`
