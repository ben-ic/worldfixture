# Control world time

World time starts after provider readiness. Startup time does not consume the
authored schedule. All runnable authored worlds need at least one timeline
arrival. Selecting only some capabilities can leave a run with no active arrivals;
the CLI reports those exclusions.

## Read, pause, and advance

```sh
worldfixture clock --json
worldfixture clock pause
worldfixture clock advance 90s
worldfixture clock resume
```

Commands from another terminal reach the process that owns the running world.
The CLI and Workbench use the same control queue. An advance waits for each due
provider write, including delayed causal records within the requested boundary.
A paused clock stays paused after an advance. Another advance does not apply
completed arrivals again.

Use one duration with a unit: `ms`, `s`, `m`, `h`, `d`, or `w`. For example, `90s`,
`5m`, and `1w` are valid. Values must resolve to a whole number of milliseconds
within the clock range. Negative values, unknown units, and overflow are rejected.

## Choose a starting position

```sh
worldfixture up --start-at 5m
```

The runtime restores its baseline and applies arrivals due at or before five
minutes through provider APIs before it publishes ready bindings. This includes
an arrival exactly at five minutes. A position beyond the authored schedule is
valid; the runtime reports when no scheduled arrivals remain.

To choose the position in the Workbench, start a setup run:

```sh
worldfixture up --setup
```

Open **Timeline**, enter the starting duration, then select **Apply position and
start**. Setup holds the baseline paused, including arrivals due at zero. A live
run has forward controls only. Launch options do not change an existing run.
The CLI can apply the setup position with `worldfixture clock start 5m`.
After a [world switch](./worlds#switch-a-running-world), confirm the new application
connection before starting. Reset during connection setup keeps zero-time events
pending.

Required application events need an explicit configured connector before
startup. Optional unbound destinations remain visible as skipped outcomes.
Delivery failure pauses the clock for inspection. An initial positioning failure
stops startup and keeps its runtime evidence in the run directory.

## Inspect the schedule

The Timeline screen reads the persisted schedule. It shows pending, in-flight,
delivered, failed, skipped, and uncertain outcomes separately. Expand a record to
read its payload, due time, command, accepted event, and cause.

Use **Choose a time window**, zoom, or move the view to inspect seconds or weeks.
Changing the view does not change world time. Marks group nearby loaded events;
every record in a group remains accessible. **Load more events in this window**
reads additional pages. The clock cursor moves between server samples and is
corrected by the next runtime update.

`GET /api/clock` returns the current clock, outcome totals, and repeat state.
`POST /api/clock` accepts clock commands. `GET /api/timeline` supports `after`
(append sequence), `limit` (1–1000), and inclusive `fromMs`/`toMs` bounds. An
appended causal record remains reachable even if its due time precedes the last
page's due time. Reset changes the cycle identity, so clients must discard pages
from an earlier cycle.
Managed Workbench requests also use `X-WorldFixture-Generation`. Read the current
generation from `GET /api/session`; mutations with missing or old generations are
refused. A switch invalidates earlier clock samples and timeline pages.

## Repeat with baseline restore

```sh
worldfixture up --repeat
```

Repeat is off by default. You can also enable it in the Timeline screen. Each
cycle waits for delivery to settle, restores WorldFixture-owned provider state,
and checks readiness before the next pass. Manual provider changes are removed.
Application database services with `reset: false` remain intact. Repeat stops on
delivery or reset failure. A selected arc with no positive duration cannot repeat.

Application connector events retain their ID, payload, and inferred `occurred_at`
across retries and repeat. The ID format is
`wf:<encoded-world-id>:<encoded-world-version>:<encoded-arrival-id>`, where each
component uses URL encoding. Accepted connector receipts survive provider reset;
repeat does not send an already accepted mutation to the preserved application.
If an event's target or authored payload changes under the same identity, delivery
fails for inspection. An explicit authored `occurred_at` is part of that payload.

The runtime does not claim exactly-once delivery across a crash for a provider
without idempotency or a result lookup. An interrupted in-flight attempt is
uncertain and requires inspection before further delivery.

The new outcome and receipt tables use runtime state schema version 2. Version 1
state directories are rejected with the existing schema mismatch diagnostic.
Keep an older run directory intact; a new `--state` directory starts a separate
run and does not move application database data from the old directory.
