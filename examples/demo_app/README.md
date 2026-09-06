# Account Desk

A local customer-support demo built on WorldFixture. Follow three guides:
send a customer reply, check service health, and join a Slack conversation.
Approve writes and check the same records in the Workbench.
Gmail, Stripe, Slack, and GitHub records come from their local provider APIs.
The app does not use the sample records in the design exports.

## Run the demo

Use Node.js 22.13 or later and a running Docker engine. Obtain this directory
from the repository; the `worldfixture` npm package does not include this app.

```sh
cd examples/demo_app
npm ci
npx worldfixture up --image worldfixture:account-desk
npx worldfixture run -- npm run dev
```

Open the URL printed by Account Desk. The default is `http://127.0.0.1:5175`.
If that port is in use, the app prints another port. Provider ports come from
the installed CLI's generated bindings. Do not put provider ports in the UI.

This sequence uses the corrected **local image**, not the published default.
Build it from the repository root if it is not present:

```sh
docker build -t worldfixture:account-desk .
```

The app selects PostgreSQL for drafts and action receipts. Provider records
remain in their WorldFixture services. Both PostgreSQL and MariaDB have passed
live storage and reset tests. See [Database checks](DATABASE_TESTS.md).

The tested published image `ghcr.io/ben-ic/worldfixture:0.2.3` lacks the Calendar
seed correction and PostgreSQL host authentication fix. If you deliberately
use that image, `ACCOUNT_DESK_DATABASE=sqlite` is an explicit app-storage
workaround; it does not fix Calendar. A failed database connection never causes
an automatic fallback. No updated image has been published by this work.

## Show the customer flow

1. Open **Needs attention**. Read the selected customer message and open invoice.
   The app joins the records by exact email address and customer ID.
2. Select **Prepare reply**. Edit the text if needed. Nothing is sent yet.
3. Optionally add a Slack update, GitHub issue, Notion note, or S3 report.
   Select and review each destination.
4. Review the exact changes, then approve them.
5. Watch the actual action steps. Each successful step includes a fresh provider
   read. A failed or uncertain step is not shown as saved.
6. Select **Open Workbench**. Select Gmail and find the reply in Sent messages.
   A threaded reply stays in the source thread when the required headers exist.
7. Select **Continue to service health** to inspect HTTP responses, RSS feeds,
   and expected failures. This does not start another customer reply.

Other customer cases are below the first case. Customers, Work, Service health,
Connections, and Verification provide more detailed views. The guided reply
uses a text template, not an AI model.

## Continue through three guides

The guide selector opens each experience directly. The sidebar remains available.

| Guide | Steps | What you get |
| --- | --- | --- |
| Customer follow-up | Understand → Prepare → Review → Done | An approved Gmail reply with a fresh provider readback. Optional related writes have their own destinations. |
| Service health | Inspect targets → Run checks → Review results | Actual HTTP responses, expected failures, changing availability, and RSS checks. |
| Slack conversation | Choose conversation → Review scenario → Watch and reply | Three approved messages arrive in the local Slack service over time. You can then review and send a reply. |

After the reply, select **Continue to service health**. After the health checks,
select **Continue to Slack conversation**. Finish with **Open Workbench**,
**Run verification**, or **Explore Account Desk**. Sending a reply does not mark
the customer case as resolved.

The Slack guide selects the conversation with the latest message. Review the
exact three test messages and approve them before they start. All messages use
the configured local Slack identity; they do not impersonate different people.
The server waits at least three seconds before each message. It uses the official
Slack SDK and requires a fresh readback before it continues.

**Stop after the current message** prevents later messages. A request that has already
started can finish. Reloading the browser does not repeat the scenario. A server
restart marks unfinished scenarios as interrupted and does not resume their
writes. Saved scenarios can be opened without sending them again.

Health results stay attached to the completed check. Background reads do not
replace them. GET requests can advance failure counters and page variants.
The RSS result compares observed entries; it does not prove a timed arrival.
See [guide checks and remaining browser checks](GUIDED_EXPERIENCES.md) for evidence.

Use **Save draft** to keep your edits. After a reload, select the saved draft
to continue. A saved approval key retrieves its receipt; it does not send the
same reply again. Customer History and Documents show only records with an
explicit customer and world link.

## What is covered?

The [service coverage reference](COVERAGE.md) lists each app read, write, SDK
version, test, and known gap. The app shows the same registry in service details.
An inventory read is not a claim that an entire provider API works.

In **Verification**, choose:

- **Read checks** to inspect the selected local services.
- **Write and readback checks** to preview exact local test records, then
  approve the plan. Each write must have a fresh provider readback.

Results stream as checks run. **Stop run** prevents the next check; the current
check can finish. **Download evidence** exports the run as JSON. A repeated
approval returns the current saved run and does not repeat its writes.

The clean-install test passed 22 reads and 16 writes on the corrected image.
See [First-run checks](FIRST_RUN_TESTS.md) for scope and evidence. These are
local tests, not production request/response recordings.

The retail world also passed 22 reads and 16 writes after its authored JSON was
built with the corrected image through `npx worldfixture build`. A Slack/HTTP-only
world passed its selected checks and skipped the 20 absent groups. See the
[recorded dynamic-world results](tests/providers-live-evidence.json).

With installed CLI `0.2.3`, use an explicit `--world-path` for a different world.
The positional world name did not select the intended artifact in the test.
Its bundled retail artifact also has the old Calendar data; rebuild the world
source with the corrected image. Check the world ID in the app before writes.

## Streaming

The browser connects to `GET /api/live` with Server-Sent Events (SSE).

| Event | What it contains |
| --- | --- |
| `connected` | Current app state, including persisted action and verification results |
| `service` | A service's loading, ready, or failed state and latest returned data |
| `receipt` | A persisted workflow update, including actual per-action progress |
| `verification` | A persisted verification run update |
| `draft` | A saved draft |
| `slackScenario` | Saved progress for the approved Slack message sequence |
| `events` | The persisted connector inbox after an event is received |

Action progress is pushed as it occurs. Other provider changes are found with
API reads every 10 seconds while a stream is connected. These are not native
provider push feeds. Slow reads can make an update take longer. HTTP target
reads also advance request-based failure sequences.

Background Gmail checks read the current message list, but reuse existing
message details for up to five minutes. New message IDs are fetched immediately.
Manual refresh, verification, and write readbacks read fresh details. If a Google
request reaches the local limit, the app shows the reset time and pauses
background Google reads until then. It does not retry writes automatically.

New source-built WorldFixture images set the emulate.dev core budget to
100,000 counts per token per hour. Gmail, Calendar, and Drive share one budget.
Older images, including the first recorded test image, retain 5,000.
Rebuilding the app alone does not change the provider limit. See
[local request limits](../../docs/providers/index.md#local-request-limits).

Live verification updates contain result summaries. Full provider evidence is
loaded with **Load full evidence** or **Download evidence**, so each update does
not transfer all previous provider responses.

The browser reconnects automatically and gets a current snapshot. During a
connection failure, it requests state every 5 seconds. An event stream is not
a complete event history: saved action receipts are the evidence. Reconnection
does not repeat writes. Draft edits stay in place during background updates.
This is app-state streaming, not AI token streaming.

## Check the implementation

```sh
npm test
npm run build
npm run test:installed-package
npm run test:coverage
```

`npm test` includes SSE delivery, reconnect, redaction, UI state merging,
provider SDK transport, storage, and workflow idempotency tests. Live provider
tests are opt-in and are not implied by a passing unit test. Verification in
the UI offers reads and explicitly approved writes; neither proves full
production API parity.

The same runner is available from the terminal:

```sh
npx worldfixture run -- npm run verify
```

Only in an isolated test world, opt in to test writes:

```sh
npx worldfixture run -- env ACCOUNT_DESK_ALLOW_TEST_WRITES=1 npm run verify -- --writes
```

To serve the built app instead of the development server:

```sh
npx worldfixture run -- npm start
```

Run these commands from the app directory:

```sh
npx worldfixture open
npx worldfixture doctor
npx worldfixture down
```

Stop Account Desk with Ctrl+C. `down` stops the world. `npx worldfixture reset`
resets provider state; use it only when you intend to discard local provider
changes. It does not clear the app's SQLite receipts and drafts. Old receipts
record earlier actions; they do not prove that a provider record still exists
after a reset. Stop and restart the app after replacing the world so it reads
the current bindings.

## Current limits

- The full screen and lifecycle acceptance checklist is in the
  [implementation plan](IMPLEMENTATION_PLAN.md). Browser coverage is separate
  from API test coverage.
- Calendar and PostgreSQL require the corrected local image described above.
- The Notion Workers adapter has no installed public runtime interface for
  this app. The separate example MCP stdio server is not integrated.
- Notion webhook verification uses Workbench-only subscription setup and a
  signed local capture. It does not send an external callback.
- Provider reads can be bounded samples. The UI identifies returned limits.
- Multiple services do not share one transaction. Earlier successful writes
  remain if a later action fails. Uncertain writes are not sent again.
- Advanced Notion and all five local OAuth code flows passed separate live
  tests. This does not prove production consent, delivery, or full SDK parity.
- No external AI service, complete native provider event feed, or AI token
  stream is implemented.

The `.dc.html` files and `support.js` are preserved design exports. The running
app is in `src/`; changes to the exports do not change its behavior.
