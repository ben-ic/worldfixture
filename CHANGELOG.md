# Changelog

## 0.2.5

- Streaming now loops without restoring provider state. The existing `--repeat`
  option keeps provider data and delivery history. Reset remains a separate action.
- Workbench Overview puts the clock and connection values first. Email messages
  and GitHub issues expand in place, and the timeline legend explains grouped events.
- `worldfixture up` reports its launch as it happens. Each part of the world
  gets a line the moment it can actually be used -- the emulators it started
  and how many, mail over SMTP and IMAP, object storage, the databases it
  seeded -- each with the port it answers on, above a single line carrying the
  clock and what the wait is currently spent on. `up --direct` reports the same
  way; it used to run its whole startup in silence.
- The compiler's Python dependency is pinned in `requirements.txt`, which
  `pyproject.toml` now reads, so `pip install .` and
  `pip install -r requirements.txt` install the same versions and cannot drift.
  CONTRIBUTING and CI install through it.
- A world that cannot be rebased onto today because the compiler could not run
  now names the repair. Without `jsonschema` installed for the `python3` on
  PATH, `up` reported a bare `ModuleNotFoundError` on a line about world dates
  and then started the world weeks behind today; it now says which dependency
  is missing and the command that installs it, and says so separately for a
  `python3` that is not on PATH at all. A compiler that ran and rejected the
  source is left alone, because advice invented for it would be wrong.
- `up` no longer prints the Workbench address while the world is still loading.
  It appeared about two seconds in, roughly a hundred seconds before the world
  behind it had any mail, files, or databases, so the one actionable thing in
  the terminal was an invitation into a world that was not there yet. The
  address is now reported once, on the ready screen, with everything else.

- Linux container starts, resets, and world switches retain the host user's
  ownership of private runtime state. This fixes permission failures when the
  host CLI reads files written by the root container process. Private file modes
  and provider service ownership remain intact.
- CI checks runtime state access as a non-root Linux user and prints redacted
  CLI diagnostics when world selection fails. Fixed the example app's lint errors.

### Release record

- Package: `worldfixture@0.2.5` on npm, also tagged `latest`.
- Image: `ghcr.io/ben-ic/worldfixture:0.2.5`, `linux/amd64` and `linux/arm64`,
  also tagged `latest`.
- Digest: `sha256:de90b87caba05396b7570807fed2ae50d85e0f82ab302cfabc8ad1ed21d9d41e`
- Source commit: `c62ebcefd3abf55f0be5e9b9492753e56622130a`, recorded in the
  image as `org.opencontainers.image.revision`.
- Verified: both architectures carry the `0.2.5` version label and that
  revision; `up --only slack` against the published tag reached readiness and
  stopped cleanly on native arm64. 488 runtime tests and 269 compiler tests
  passed on the source commit.

## 0.2.4

- Package builds prepare a local Python environment and install the compiler's
  declared dependencies, so publishing does not require a separate `jsonschema`
  installation in system Python.
- Worlds can run without a company profile. Provider selection, identities,
  domain records, and Workbench views use the selected world's declarations.
- Timeline controls support setup, starting positions, advance, and repeat.
  World switching replaces provider state and credentials while preserving
  application databases and accepted connector receipts.
- Corrected payment dates, provider API coverage, and reset behavior. Removed
  obsolete code and added checks across shipped and generated worlds.
- The package selects `ghcr.io/ben-ic/worldfixture:sha-d9139dc`, the published
  coupling image for AMD64 and ARM64. Its existing container version label is
  `0.2.3`; the source revision identifies this build. Full default-world checks
  passed on native ARM64. AMD64 checks passed on smaller worlds; default-world
  startup exceeded the limits under Rosetta. Native AMD64 default-world runtime
  verification remains open.

## 0.2.3

This release combines an audit of existing behavior with documentation,
verification, security fixes, and Workbench improvements. The support claims
below come from code inspection, tests, and checks against a running world.

### Added

- **A Stripe billing surface**, with 18 routes and 11 webhook events, pinned
  against a recorded subset of Stripe's published OpenAPI description. Billing
  integration code is mostly failure handling, and a Stripe world that cannot
  decline a card leaves the half nobody worries about untested. The contract
  file carries its source, API version, retrieval date and digest, and has the
  third-party notice and trademark disclaimer the Notion contracts already had.
  Documented in `docs/providers/stripe.md`.
- **A documentation site**, stored in this repository, built with VitePress,
  and served by the Workbench at `/docs`. It carries a five-minute
  start, a connect-an-application page, troubleshooting, guides for bindings,
  worlds, the Workbench, HTTP targets, events and webhooks, and reset, plus one
  page per provider stating exactly which operations are supported, which are
  partial and which are not. `scripts/check-docs.mjs` verifies internal links,
  support labels, support references, and architecture diagram references. It
  runs in CI.
- **`docs/architecture.md`** as two C4 diagrams written in D2 and rendered to
  SVG by a pinned container, with `--check` failing a committed SVG that no
  longer matches its source.
- **Continuous integration**: both linters, all three test suites and a
  determinism job that builds every world twice under different
  `PYTHONHASHSEED` values and diffs the output.
- **A lint configuration for both languages**, chosen for the mistakes it
  catches rather than for style, with the rules that were measured wrong here
  named and excluded.
- **`SECURITY.md`**, which says where to report privately and what is not a
  vulnerability.
- **Onboarding examples** in curl, JavaScript and Python that read this run's
  bindings, send one message and read it back.
- **Live Linear and Twilio surfaces in the Workbench**, read from the running
  services rather than from the prepared projection, so a write through either
  API appears on its own screen.
- **The world's HTTP targets** are listed on the Website screen: the RSS feed,
  the changing pages, each probe with its configured status sequence, the
  OpenAPI document, the JSON routes and the metrics endpoint.

### Security

- Provider tokens and mail passwords are now generated per project before
  startup. Artifacts retain readable identity references and permissions; the
  compiler and parity fixtures are unchanged. Every running service and runtime
  consumer uses the same private credential snapshot. Store writes are locked
  and atomic; later commands cannot generate replacement secrets. This also
  replaces declared Twilio secrets and Clerk passwords. Stripe, Resend, and
  MongoDB Atlas now check API keys, and Linear no longer assigns an unknown
  caller to the first admin. OAuth-issued tokens retain their own lifecycle.
- **Postgres and MariaDB shared one password with every installation.** The
  manifests bound `worldfixture-local` as a constant, so the database password
  on your machine was the database password on everyone's. It is now 24 random
  bytes generated on first launch and kept in
  `.worldfixture/generated-secrets.json` at 0600 -- per project, so two projects
  do not share one, and stable across launches, so nothing has to be re-copied
  into an application. The compiled world is untouched, so every world still
  builds to the same bytes. These two enforce the password, so this is a
  credential change.
- **The S3 keys are generated the same way, and that is not a security fix.**
  SeaweedFS runs with no authorization: an unsigned request, a forged signature
  and an anonymous write all succeed, measured against this release's image. The
  generated keys replace two shared constants in client construction and nothing
  more. Authenticated object storage is separate work; `docs/providers/s3.md`
  states the position.
- **The Workbench withheld the credentials and then offered "Copy .env".** It
  filtered out 15 of the 28 provider bindings, so the file that button produced
  had addresses and no way to authenticate. A world's own credentials are
  synthetic world data and are shown now, masked behind a per-row Show toggle,
  including the connection URLs that carry a password inside them. The connector
  token is still never sent to the browser: it writes into your application, not
  into the world.

- **Sample credentials from the upstream seed authenticated in every world.**
  `seed.yaml` ships `lin_test_admin`, a Linear token with admin scope belonging
  to a person no world declares, and Okta, Clerk, Vercel, Apple and Twilio each
  carried a sample client secret or API key the same way. Only slack, github and
  google were being swept, and the sweep ran over the world's overlay rather than
  over the seed -- so a vendor the world says nothing about, which is every
  vendor whose credentials leaked, was never visited.
- **Six more vendors served an account no world declares.** apple, github,
  linear, okta, slack and vercel each inserted a convenience user that an
  application enumerating people was handed: Vercel's owned the world's team,
  GitHub's was `site_admin`, Slack's was the first member of `users.list`. The
  sweep also runs before the world is seeded, because upstream attributes the
  world's own content to whichever user is first -- all 28 Slack channels and all
  404 Linear issues were created by an injected admin.
- **`--limit people=0` sent sixteen people.** A slice that would empty a
  collection puts one record back with everything it needs, which is right for a
  preset cap and wrong for a number the caller typed.

### Fixed

- **A quarter of the world's task titles read "the the".** A template carrying
  its own article filled with a subject that also had one, so 119 of 514 titles
  came out as "Write the the lease heartbeat design note". A task tracker seeded
  from this world showed the error on nearly a quarter of its rows.
- **Stripe objects had no ids**, so nothing could address a Stripe customer,
  price or subscription and a client had to match on name. Every object now
  carries a deterministic id derived from the world record it projects, so an
  invoice in finance and a customer in Stripe are the same thing seen twice. The
  projection also gained the subscriptions and invoices a subscription business
  obviously has and this one did not. Declared as a parity migration.
- **Three Workbench sidebar counts were wrong in every world.** Code summed a
  field the GitHub projection has never carried, so it read 0 however much code
  the world held. The nav badge fell back to a surface's subtitle when there was
  no count, so the Website row displayed the word "http". Gmail and Mail were two
  indistinguishable entries with two different numbers.
- **The mail service could restart for ever.** Its entrypoint installed the
  cleanup trap 84 lines after Cyrus was already running, so any failure in
  between left this shell dead and Cyrus holding the IMAP port. The supervisor
  restarted the service, the new Cyrus could not bind, and the loop repeated. A
  test now asks the ordering question of every entrypoint.
- **A world compiled to a different artifact on a different machine** if any
  authored Slack time omitted its `Z`. Measured: three digests from one source
  under three time zones. No shipped world trips it.
- **Prose dates on the far side of a year boundary never rebased**, ordinals
  lost their suffix -- `the 3rd March` became `the 10 March` -- and a number that
  is not a day, such as `62 June`, failed the whole build with a bare
  `ValueError` naming no world or field.
- **A projection selected on one world's team names.** The AWS projection
  filtered operators on `team == "engineering"`, which v3 does not have, so its
  IAM users collapsed from four to one out of 99 members. A world can declare
  its own operator teams, queues and service roles now.
- **A world with no `site` died on a bare `KeyError`** out of a projection,
  because the fallback HTTP targets are built from records only v2 has.
- **`--as maya` acted as the wrong Maya.** v3 has 161 people and four shared
  first segments, and a single `.find` returned whichever came first in the
  array. An ambiguous reference is now reported, and the `slack send` line the
  first screen offers uses a handle that command will accept.
- **A stalled SMTP server hung the scheduler for ever.** The timeout rejected a
  promise that had already resolved, so no waiter was ever failed. Body lines
  beginning with a dot were also under-escaped, so `.hidden` was delivered as
  `hidden`.
- **One stray directory under `src/vendors/` stopped all thirteen vendors**
  before a listener bound, with no prefix on the error because the handler is
  installed on the last line of the module that was still importing.
- **Every Slack message in the Workbench was attributed to a raw member id** --
  all 1,517 of them in v3 -- because history carries `user` and no `user_name`
  and the world's own `slack_id` values are in an id space the emulator never
  issues.
- **`open_issues_count` was 0 for every repository in every world**, in the API
  and on the Code screen, beside issues the same request could fetch.
- **Stripe list endpoints accepted `limit=0`, `limit=abc` and an unknown
  `starting_after`**, the last of which re-served page one -- so a client paging
  until `has_more` goes false never terminates.
- **A Google batch sub-response said `HTTP/1.1 404 OK`.** Hono leaves
  `statusText` empty, and `|| "OK"` fired on every part.
- **Notion pagination**: `/v1/users`, the two legal-hold admin lists and three
  MCP readers each turned an empty or invalid request into a full one, and two
  admin routes answered 500 on an unknown cursor.
- **The Workbench reported every service a reduced world does not run as a
  failure**, so `up --only slack` opened on a wall of errors.
- **Thirty-four Workbench buttons submitted the form they sat in**, because a
  `<button>` with no `type` is a submit button.
- **A container that mounts no world was given the host path to `dist/`**, which
  does not exist inside it.
- **A long first start printed nothing while it built an image**, and a port
  Docker refused printed `Fetching    [object Object]`.
- **`status --verbose` said "next arrival at t+0s"** under "0 pending".
- **The Atlas data explorer showed blank titles and "No collections"** for
  databases holding four, and marked every healthy cluster with a warning badge.
- **The Stripe product catalogue printed "recurring" in its interval column** on
  every row, which says a price repeats without saying how often.

### Release record

- Package: `worldfixture@0.2.3` on npm, also tagged `latest`.
- Image: `ghcr.io/ben-ic/worldfixture:0.2.3`, `linux/amd64` and `linux/arm64`,
  also tagged `latest`.
- Digest: `sha256:912d8be39685f08e517d2d78c9d8a6e18fc635e53231206c9c971ac686ed1661`

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

### Release record

- Package: `worldfixture@0.2.2` on npm, also tagged `latest`.
- Image: `ghcr.io/ben-ic/worldfixture:0.2.2`, `linux/amd64` and `linux/arm64`,
  also tagged `latest`.
- Digest: `sha256:98e1c990f86364df37a9eaf10f278201e995b7bc8bae678fa18744c924d4a09d`

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
  Python traceback. It now prepares the world artifact and discards it, so
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
