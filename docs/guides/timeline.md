# Control world time

World time starts after provider readiness. Startup time does not consume the
authored schedule. All runnable authored worlds need at least one timeline
arrival. Selecting only some capabilities can leave a run with no active arrivals;
the CLI reports those exclusions.

## Watch events arrive

Open **Timeline** in the Workbench to watch the world clock and scheduled
delivery. The counts show pending, in-flight, delivered, failed, skipped, and
uncertain outcomes. Select an event mark to inspect the records in that group.

![Timeline with a running clock, Loop enabled, retained deliveries, and a complete symbol legend.](/workbench/timeline-streaming.png)

The scheduled data reaches the provider services. This Chat capture shows four
scheduled messages in Slack's **#release-3-2** channel. Open **Chat**, select the
channel, and use **Refresh conversation** to read its current history.

![Slack release channel showing scheduled messages from Jon Bell, Daniel Osei, Bianca Rossi, and Lucas Meyer.](/workbench/streaming-chat.png)

These screenshots show `business.saas-company:v3` in a separate local run.
The Timeline capture shows a running clock. The Chat capture shows messages
read after a pause. Your counts, times, and selected services can differ.

<!-- Browser captures from 2026-09-06. Timeline shows the updated Workbench
     after two completed passes in an isolated worldfixture:workbench-review
     run. Chat is from the earlier isolated streaming review run. -->

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

## Loop without reset

Enable **Loop** in Overview or Timeline to play the schedule again after all
scheduled events and their delayed effects finish. The clock keeps moving forward.
Provider data, manual changes, and delivery history remain available. The square
symbol (**▦**) means grouped events; the number shows how many loaded events are
in that group. The legend explains every timeline symbol.

The existing CLI option also enables Loop:

```sh
worldfixture up --repeat
```

Loop is off by default. Each new pass appends events with new arrival IDs and
future due times. It does not restore the baseline. Use **Reset world** separately
when you need to return to the initial data. This changes the previous behavior
of `--repeat`, which restored provider data between passes.

`POST /api/clock` accepts `{ "action": "loop", "enabled": true }`.
A setup start can include `"loop": true`. The older `repeat` action remains an
alias. `GET /api/clock` includes `loop.enabled`; `repeat.cycle` identifies the
current schedule pass. Clients must refresh timeline pages when that value changes.

Loop sends the same authored payloads through the provider APIs. New messages,
comments, and payments without a fixed invoice ID accumulate. Fixed object keys
follow the provider's overwrite rules. Operations that cannot be repeated, such
as paying an invoice that is already paid, stop delivery for inspection. Loop
also stops on delivery failure. A schedule needs a positive duration to loop.

Application connector events get a new ID for each loop pass. Retries within a
pass retain their ID, payload, and inferred `occurred_at`. The ID format is
`wf:<encoded-world-id>:<encoded-world-version>:<encoded-arrival-id>`, where each
component uses URL encoding. Accepted receipts survive an explicit provider
reset. If the target or payload changes under the same ID, delivery fails for
inspection.

The runtime does not claim exactly-once delivery across a crash for a provider
without idempotency or a result lookup. An interrupted in-flight attempt is
uncertain and requires inspection before further delivery.

The new outcome and receipt tables use runtime state schema version 2. Version 1
state directories are rejected with the existing schema mismatch diagnostic.
Keep an older run directory intact; a new `--state` directory starts a separate
run and does not move application database data from the old directory.
