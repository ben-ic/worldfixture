# Image checks

Run these commands from the repository root. Docker must be available.

`protocol-test.mjs` checks the existing product-image lifecycle, protocols, and
reset. `coupling-test.mjs` checks content for each artifact found under `dist/`,
plus generated alien worlds. They test different contracts.

```sh
npm run build:worlds
docker buildx build --load -t worldfixture:local .
npm run test:coupling:unit
PYTHONPATH=compiler python3 -m unittest tests.contracts.test_coupling_fixture
npm run test:coupling -- --image worldfixture:local
```

The matrix uses exact artifact paths and authored dates. Each world gets a new
container, private state, and host ports allocated on loopback. It does not reuse
a developer's running world. It removes only containers with its owner label.
All provider reads go through APIs. It never edits emulator databases.

Before startup, the matrix copies each manifest and its declared files into the
report's `inputs` directory. It verifies the copy against the original identity
and hashes. Every process reads this saved copy, so another build cannot change
the input during the run.

Delayed RSS checks start separate HTTP processes from the same image and
immutable artifacts. These processes run in parallel. The test reads each feed
before and after its declared delays and records the observed transition window.
It does not claim an exact delivery instant or alignment with the runtime clock.
The longest shipped delay is nine minutes. The selected image digest is fixed
before any test container starts.

The strict matrix exits with status 1 if any check fails, including a failed
build, failed boot, incomplete API reader, or collection with no consumer. Its
initial run recorded existing defects and incomplete coverage. Current runs must
pass every required check. A successful HTTP read alone does not prove that
all source records were served. Tests for the harness itself must pass.

The console prints the report directory. `SUMMARY.md` groups audit finding
references and explicitly unimplemented readers. A failed boot or unavailable
capability is not counted as an unimplemented reader. The full report still
fails for either condition. `report.json` contains world identities,
image identity, generation seeds, expected and actual results, collection
coverage, and an inventory of API response digests. Raw response bodies and run
bindings are not saved. Logs have credentials removed. Generated alien sources
and artifacts remain beside the report so failures can be reproduced.

Unknown collections and missing reader evidence are `reader_gap` failures.
Reviewed data with no public API consumer is a `product_gap`; it remains a strict
failure. Source records preserved only in packs do not pass API coverage.

The default run includes a fixed regression seed and a fresh seed, each with a
short and a long timeline. To repeat a failed run, use its recorded fresh seed:

```sh
npm run test:coupling -- --image worldfixture:local \
  --fresh-seed <recorded-seed> --report /tmp/worldfixture-coupling-recheck
```

Other options are `--dist <directory>`, `--seed <regression-seed>`, and
`--ready-timeout-ms <milliseconds>`. A missing image or unavailable Docker engine
is an infrastructure failure. No world is silently skipped.

The response inventory defines the scope of the evidence. These checks do not
prove every possible provider request. Missing readers are reported as failures,
not provider support claims. The harness pauses each run through the existing
runtime clock module before it reads baseline content. Arrivals already due at
that point can still finish; any expected extra records must come from the
world's authored arrivals. The product clock CLI and Workbench controls have
separate lifecycle and delivery checks below.

## World selection checks

`world-selection-test.mjs` checks selection through the real CLI and HTTP target
service. Build a fresh product image after CLI or Docker ENTRYPOINT changes.
The script resolves its image tag to one immutable image ID before launch.

```sh
npm run test:world-selection -- --image worldfixture:local
npm run test:world-selection -- --image worldfixture:local --report .worldfixture/coupling/p1-selection --run
```

Without `--run`, the command only reads the catalogue and prints its plan. With
`--run`, it tests every artifact in `dist/` by name and by a renamed external
path, in direct and host mode, with and without rebase. Direct mode uses the
host CLI's `--direct` service path. Both modes select the site's HTTP service
when the source declares one, or the domain service when it does not. Each case
uses allocated host ports and a separate temporary project and state.
The current catalogue has three entries, so it produces 24 launch cases. The
script requires at least two entries for its cross-world refusal checks.

Six additional checks reject invalid names, missing paths, and conflicting
selectors before any project or state writes. Each host case rejects another
world even when the request also changes `--application-url`, verifies that the
original files and URL remain unchanged, then reuses the original selection.
A raw Docker ENTRYPOINT check selects a nondefault world by name. This covers
the entrypoint separately from the host launcher's staged artifact path.

Checks compare the live HTTP world identity, company, and story IDs with source
records. Worlds without a site use complete domain API organization and person
records instead. Checks also verify the selected service, staged input, session artifact
digest, and whole-week rebase anchor. `--no-rebase` reads `state/input-world` in
both modes and must preserve the selected digest. These checks do not cover
unselected provider data or delayed arrivals. Small manifest unit fixtures
remain useful for parser, integrity, and provenance failures; they do not prove
service startup or live content.

Use `--filter retail` or another case-label substring for a smaller run. The
negative and raw entrypoint checks still run with a filter. The per-case
startup limit is `--timeout-ms 120000`; increase it if the direct HTTP service
image must be built for the first time. `--repo <path>` selects another checkout.

`--report <directory>` saves `report.json` and verified artifact copies under
`inputs/`. The directory must be new or empty, so a new run cannot replace
earlier evidence. Without this option, the report uses the temporary run
directory. Plan-only mode does not create a report directory.

The report path is printed. Startup failures include CLI stdout and stderr
with known credentials removed, saved before cleanup. Project and runtime
state remain in a separate temporary directory when `--report` is supplied.
That state can contain credentials and is not included in the CI upload.
`report.json` contains checks and digests, not binding files.
Cleanup stops only containers owned by the new state directories. The raw
entrypoint container uses the coupling harness owner label. Direct cleanup
reads the runtime instance ledger only to identify its service container, then
checks the container's state mount. It does not use a service database as
content evidence. Active runtime SQLite and progress files are excluded from
host refusal snapshots because the running scheduler can change them.

The coupling CI job runs selection checks before the strict P0 content matrix,
using the same freshly built product image. Its final upload retains both P1
selection evidence and P0 content evidence, including reports from failed runs.
The job keeps its 30-minute limit; the P1 check selects only the HTTP service
and has no delayed-arrival wait.

## Focused coupling checks

These checks use the locally built product image. Each command needs a fresh
report directory. Reports retain the immutable image ID and frozen input
artifacts. They do not replace the full coupling matrix.

```sh
node tests/image/coupling-aws-test.mjs \
  --image worldfixture:local --report .worldfixture/coupling/aws-check
node tests/image/coupling-seed-test.mjs \
  --image worldfixture:local --report .worldfixture/coupling/seed-check
node tests/image/coupling-oauth-matrix.mjs \
  --image worldfixture:local \
  --source worlds/business.saas-company.v2/world.json \
  --source worlds/business.saas-company.v3/world.json \
  --source worlds/consumer.retail-brand.v1/world.json \
  --report .worldfixture/coupling/oauth-check
```

The AWS check covers operator policy, IAM/SQS/STS authentication and route
ownership, S3 objects, signed Notion uploads, and normal reset. The seed check
reads source mailboxes, labels, message contents, Drive ownership, Linear tasks,
and finance transactions before and after reset. It creates temporary mail,
a task, and a refund through public APIs and checks that reset removes them.
The seed check also reads complete domain records before and after reset. This
proves commerce fields that Stripe does not serve. Every failed check causes a
failed exit; no audit finding is excluded from its result.

The OAuth matrix copies each source and adds explicit test applications with
exact callback URLs. It records both the original and extended artifact
digests and proves the other source fields are unchanged. It tests generated
client credentials, source user identity, rejected sample credentials, and
normal reset. It does not add default applications to shipped worlds or claim
identity coverage for an Apple surface with no declared client.

The domain execution check runs inside the product image. It checks scheduled
orders, delayed causal records, cause and command links, cycle limits, and a
second pass after normal reset. Compile its source before running it:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  tests/fixtures/domain-execution.world.json \
  --output .worldfixture/domain-execution-artifact
docker run --rm --network none \
  --mount "type=bind,src=$PWD/.worldfixture/domain-execution-artifact,dst=/world,readonly" \
  --mount "type=bind,src=$PWD/tests/image/domain-execution-check.mjs,dst=/check.mjs,readonly" \
  --entrypoint node worldfixture:local /check.mjs
```

The check uses public domain API reads and the normal runtime scheduler and
reset lifecycle. It does not change provider databases to prepare a pass.

## Clock image checks

Use a fixed image ID and a new report directory:

```sh
node --test tests/image/clock-world-test.test.mjs
node tests/image/clock-world-test.mjs \
  --image sha256:<immutable-image-id> \
  --python python3 --report .worldfixture/coupling/clock-check
```

The three cases use the starter's real Slack arrival at 30 seconds and generated
alien timelines with 4 arrivals over 30 seconds and 2,000 arrivals over one week.
They test setup and start boundaries, clock pause and advance through the CLI
and API, complete timeline paging, source content through Slack and IMAP, world
timestamps, and a second advance with no duplicate writes. The long case advances
the clock; it does not wait one week. Repeat and application database checks are
separate. Failed or skipped deliveries remain failures in these cases.

Use `--case starter`, `--case alien-short`, or `--case alien-long` to select cases.
Use `--prepare-only` without `--image` to compile and save inputs without Docker;
this produces no live proof. Reports retain frozen sources, artifact hashes, API
results, and failure states. Generated credentials are removed from saved results.

The repeat check uses a real application HTTP receiver and PostgreSQL. It checks
that repeat removes manual provider changes, keeps application rows and the
database process, and sends an accepted connector mutation only once. It also
checks these conditions after a normal reset:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  tests/fixtures/clock-repeat.world.json \
  --output .worldfixture/clock-repeat-artifact
docker run --rm --network none --add-host connector.fixture:127.0.0.1 \
  --mount "type=bind,src=$PWD/.worldfixture/clock-repeat-artifact,dst=/world,readonly" \
  --mount "type=bind,src=$PWD/tests/image/clock-repeat-check.mjs,dst=/check.mjs,readonly" \
  --entrypoint node worldfixture:local /check.mjs
```

The application receiver inserts every received mutation without duplicate
filtering. A repeated HTTP mutation therefore fails the check.

The initial-positioning check runs the normal CLI against a domain provider and
an application HTTP receiver with its own SQLite database. It interrupts one
run during a response and rejects a connector request in another run. It checks
partial outcomes, retained application data, stopped children, and the absence
of ready bindings:

```sh
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  tests/fixtures/clock-interruption-world.json \
  --output .worldfixture/clock-interruption-artifact
mkdir .worldfixture/clock-interruption-state
docker run --rm --network none --add-host connector.fixture:127.0.0.1 \
  --mount "type=bind,src=$PWD/.worldfixture/clock-interruption-artifact,dst=/world,readonly" \
  --mount "type=bind,src=$PWD/tests/image/clock-interruption-check.mjs,dst=/check.mjs,readonly" \
  --mount "type=bind,src=$PWD/.worldfixture/clock-interruption-state,dst=/state" \
  --entrypoint node worldfixture:local /check.mjs
```

Use a new state directory for each check. Its `report.json` retains the results.

## World switch checks

Run the same-session switch matrix with a fixed image ID and a new report path:

```sh
node --test tests/image/world-switch-test.test.mjs tests/image/world-switch-retired-probes.test.mjs
node tests/image/world-switch-test.mjs \
  --image sha256:<immutable-image-id> \
  --python python3 --report .worldfixture/coupling/world-switch-check
```

The sequence is SaaS v2, retail, a generated alien world, and SaaS v2 again. It
uses one product container and the same published ports. Each generation gets
complete selected-provider reads, binding and credential checks, timeline checks,
and real Slack and domain writes. The alien world uses a common channel name
with a different native ID. Manual provider writes must disappear on return.

The checks require old provider credentials to fail at supported authentication
routes. Retired listeners are checked directly inside the product container;
Docker's host port proxy can remain open after a service stops. Delayed feed
observations start after the switch accepts its final provider processes.
Baseline capture can restart a temporary startup process. These observations
use real elapsed time and do not change the service clock.

The matrix does not replace the browser, interrupted-switch, or application
persistence checks. `host-switch-check.mjs` runs the normal host CLI with two
artifact paths and a fresh report directory. Its first artifact must support
`social.posts`; its second must be the clock repeat fixture with a required
application event at two seconds. It checks PostgreSQL process and data
preservation, token rotation, connector confirmation, delivery, and return.
