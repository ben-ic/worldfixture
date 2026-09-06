# Account Desk implementation plan

Status: in progress. A working app now exists in `src/`. The guided Gmail reply
and optional Slack follow-up have passed a browser test against the local world.
The corrected-image clean installation now passes 22 read and 16 write checks.
Both database profiles pass reset-preservation tests. Complete browser coverage
and the remaining explicit exclusions still need review. Use the
[app README](README.md) for current run commands and limits.

## Outcome

Build Account Desk as the main WorldFixture demo and application-level test
surface. A visitor can inspect a customer problem, approve a response, and
confirm the saved result in the provider API and Workbench.

Use every runnable service in at least one useful, tested workflow. This is
not a promise to implement every endpoint of every production API. Record
workflow coverage and endpoint coverage separately. Unsupported services must
have a clear explanation, not a simulated successful result.

## Current implementation

- React/Vite UI and a local Node server use the installed `worldfixture@0.2.3`
  CLI for bindings. The app does not import the repository's private runtime.
- The first screen guides one real case through Understand, Prepare, Review,
  and Done. It uses exact source relationships and no fixed customer IDs.
- Three guides connect customer follow-up, service health, and a Slack
  conversation. Named continuation buttons lead to the next workflow. All
  sidebar sections remain available for independent use.
- Service health shows saved HTTP and RSS check results. The Slack guide
  previews three local test messages, requires approval, and sends them over
  time through the official SDK. Each message requires a provider readback.
  Stop prevents later messages; reload does not repeat approved writes.
- SSE streams service updates, durable action receipts, verification progress,
  and saved drafts. Provider changes without feeds are polled every 10 seconds.
- Approved workflows use provider adapters and fresh readbacks. Duplicate
  approval keys reuse a receipt; uncertain writes are not repeated.
- Unit tests and the UI build pass. The clean installed-package app passed
  22 read and 16 approved write-and-readback checks on the corrected image.
  PostgreSQL and MariaDB passed live CRUD, transaction, reopen, and reset tests.
- Verification has explicit write preview/approval, streamed results, Stop,
  history, and JSON export. The CLI and UI use the same workflow runner.
- The corrected demo uses PostgreSQL. The earlier published image still needs
  the PostgreSQL host connection and Calendar seed fixes; it is not the tested
  complete configuration. Neither gap is hidden by fake provider data.

## Starting point (before implementation)

- `Account Desk.dc.html` contains nine customer-work design frames.
- `Account Desk - Verification.dc.html` contains six verification frames.
- `Account Desk - States, Motion, Copy.dc.html` contains only an incomplete
  Before loading frame. Its introduction names more frames than the file has.
- `support.js` is generated design-canvas code, not the application backend.
- There is no app package, server, database, provider integration, or app test.
- Names, IDs, service totals, successful saves, and verification results in the
  exports are sample data. They are not evidence of working operations.
- The current manifest audit finds 14 runnable provider APIs plus HTTP targets,
  Local Mail, S3, PostgreSQL, and MariaDB. Google has separate Gmail, Calendar,
  and Drive workflows; it is not three provider services. Database profiles run
  separately. Derive displayed counts from the active selection.
- The old `regular-app` was removed. Its customer-write, OAuth, and application
  connector tests need replacements. Runtime connector tests still exist.

Preserve the design files. Implement the UI in separate source files. Do not
load the design-canvas runtime as the production application.

## First-run contract: use the installed package

The target first-run sequence is:

```sh
cd examples/demo_app
npm ci
npx worldfixture up
npx worldfixture run -- npm run dev
```

The package, lockfile, project configuration, and scripts now exist. PostgreSQL
start passed from a clean app install outside the checkout with the corrected
local image. The README gives the exact image flag. The published default image
has not been updated by this work.

`dev` starts Account Desk and prints its actual browser URL. It does not start
a second world. The first screen reads available provider data without requiring
OAuth setup. A first-use seed action can fill Account Desk's own database through
Connector v1. Show its read-only plan before seed; do not hide a provider write
in page loading or application startup.

From the same app directory, the existing public commands remain available:

```sh
npx worldfixture open
npx worldfixture env --json
npx worldfixture reset
npx worldfixture down
```

Implementation requirements:

- Pin a tested released `worldfixture` dependency in the app and commit the
  lockfile. Establish the minimum working release through an installation test.
- Commit a valid `.worldfixture/project.json` selecting PostgreSQL for the
  default app profile. Use MariaDB as a separate verification profile.
- Read the environment supplied by `worldfixture run`. Use the public
  `worldfixture env --json` command if extra connection metadata is needed.
- Do not import `runtime/src`, invoke `runtime/bin` from the checkout, read
  emulator storage, or depend on sibling `examples/lib` files.
- Use dynamic provider ports and the actual application URL. Check how the
  current public project configuration supplies that URL to Workbench and
  connector callbacks. Do not leave a stale `localhost:3000` target.
- Test whether `run` supplies `WORKBENCH_URL` and all optional service values.
  Fix a measured public CLI gap if necessary; do not read private run files.
- Test from a temporary directory outside this repository with the installed
  package. Running `npx` in the repository can select the local CLI and is not
  sufficient proof. Use a package tarball for unreleased CI checks and identify
  that result separately from a published-package test.
- The app is not currently included in the npm package file list. Document how
  to obtain it. Do not imply that `npx worldfixture` downloads Account Desk.
- No external publication, production accounts, external AI key, or runtime
  font CDN is required. Package installation and the first image pull need
  network access; do not claim a fully offline installation.

## Implementation structure

The current app uses JavaScript modules, React, Vite, a Node server, one main stylesheet, and inline SVG.
Keep the supplied light theme and sidebar. Do not add a component framework.

| Code area | Responsibility |
| --- | --- |
| `src/ui/` | Screens, forms, navigation, loading and recovery states |
| `src/server/` | App HTTP API, local session, connection discovery, event delivery |
| `src/providers/` | Official SDK adapters and named HTTP or protocol clients |
| `src/workflows/` | Customer operations shared by UI and headless verification |
| `src/db/` | Migrations, app records, mappings, action receipts, test evidence |
| `src/connector/` | Development-only Connector v1 plan, seed, event, and status |
| `src/verification/` | Workflow registry, runner, assertions, redacted reports |
| `tests/` | Unit, installed-package, provider integration, and browser tests |

Provider APIs own provider records. The app owns cases, assignments, drafts,
preferences, mappings, and action receipts. Cache reads only with their source
and freshness; do not use cached data as proof that a new write succeeded.

Keep SDK credentials on the server. Bind the demo to loopback. Validate browser
origins and mutation requests. Mask connection secrets and remove secrets from
logs and reports. Require explicit reveal or copy actions for local credentials.
Restrict integration requests and OAuth redirects to the active local bindings;
never let an SDK fall back to its production host.

## Screen and action checklist

| Design | Required behavior | Completion check |
| --- | --- | --- |
| Needs attention | Build cards from current provider evidence; filter All/Billing/Support/Reliability; select a case or coordinate a response | Each stated fact links to its source; no fixed customer names or counts |
| Case detail | Join correspondence, billing, work, and discussion through verified mappings; inspect attachments; snooze the app case | Unknown relationships are marked unmapped; unrelated customers are not combined |
| Prepare reply | Select a template; edit recipient, sender, subject, reply, issue, and note; save draft; attach report; select optional Slack/Linear actions | Preview makes no provider writes; invalid input is explained |
| Review and approve | Show the exact destination and changes; prevent duplicate submits | Approval is required; changed drafts invalidate old approval |
| Saved result | Show one receipt and readback per action | A failed or uncertain step cannot appear as saved |
| Customers | Search, filter, open accounts, add notes, and switch Overview/Correspondence/Documents/Billing/History | Pagination and customer switching load actual records |
| Work | Read and create supported GitHub and Linear follow-ups | New work appears through a fresh API read and the applicable Workbench view |
| Service health | Inspect HTTP, RSS, page changes, expected failures, deployment and cluster inventory | Timings and health come from actual requests, with expected failures identified |
| Connections | Distinguish unselected, loading, ready, and failed services; refresh/copy bindings; show sign-in and confirmed world-reset guidance | No constant ready flags; OAuth errors and revoked credentials are visible |
| Verification before a run | Select workflows and inspect prerequisites and write scope; open history; select evidence retention | Discovery is read-only; writes require an explicit test-run action |
| Verification during a run | Stream measured step results in stable order; allow Stop to prevent new work | No fabricated progress or delays; in-flight results remain recorded |
| Verification after a run | Summarize results and export evidence | Totals derive from results, not the design sample |
| Expanded failure | Show expected/actual result, failed step, redacted request, and recovery | Retry targets the failed step without repeating successful effects |
| Skip and expected failure | Explain absent prerequisites and expected error responses | An unavailable selected service fails; an expected error can pass |
| Unsupported operation | Show Works, Missing, and Evidence beside the affected operation | Unsupported actions cannot run or count as tested provider coverage |
| Missing state designs | Complete initial/partial loading, reduced run, empty data, progress, failure, and post-reset views | Each state has a browser test and a useful next action |

Use semantic controls, keyboard navigation, visible focus, accessible labels,
and reduced-motion support. Test the supplied laptop layout and narrower widths.
Open source details within the app where no Workbench view or valid local link
exists. Do not invent Workbench deep links.

Do not copy unsupported promises from the design templates. A reply must not
promise a release or billing hold without evidence and the required approved
action. The design's Local Mail `Workbench-only` badge is incorrect for the
tested SMTP/IMAP protocols. Its Gmail/GitHub contract badges, SDK versions,
30-day capture retention, and fixed health polling intervals are not implemented
facts. Define and test report retention before showing a retention guarantee.

## Service coverage plan

The entries below are implementation targets. Confirm exact methods, request
contracts, SDK calls, and test evidence before marking a workflow available.
The [provider index](../../docs/providers/index.md) records current limits.

| Service or surface | Account Desk workflow | Boundary |
| --- | --- | --- |
| Slack | Read users and conversations, show names, post an approved update, read it back | Select channels and DMs by latest message; test pagination and the official SDK |
| Google Gmail | Read customer mail and send an approved reply | Test actual message/thread contracts and readback; sending success is not remote mail delivery |
| Google Calendar | Read meetings and create a supported follow-up event | Test the selected official SDK calls and local notification limits |
| Google Drive | Read customer documents and perform a supported file write | Test content, metadata, and download behavior separately |
| GitHub | Read issues and create/comment on a follow-up issue | Test Octokit calls, OAuth, and readback; no production Actions execution claim |
| Notion REST | Read documents, append a note, create a follow-up page | Test official SDK calls; validate Page `url` and nullable `public_url` |
| Notion MCP | Exercise discovery and selected read/write tools against the same state | Hosted tool inventory evidence is not hosted result parity |
| Notion Agent, Workers, Admin | Separate advanced checks for supported session, adapter, and administration operations | Workers is a local adapter, not hosted deployment; use isolated test scope |
| Notion webhooks | Cause a supported change and inspect its signed local capture | External webhook delivery is not supported |
| Stripe | Read customer, invoice, and subscription context; test a selected billing write | Use named tested billing branches; do not imply real payment processing |
| Linear | Read work and create a task/comment after approval | Selected GraphQL operations only; official SDK integration needs proof |
| Local Mail | Send support mail through SMTP and read it through IMAP | Test the implemented protocol subset, not production mail delivery |
| Resend | Create and inspect a transactional notification | Verify local send/readback and any capture behavior separately |
| Twilio | Send an approved local SMS escalation and read status | No real SMS or phone delivery; use SID and Auth Token bindings correctly |
| S3 | Save a report or attachment, then read bytes and metadata | Use generated credentials, path style, and bucket bindings or explicit mappings; the current root bucket-list response is empty |
| HTTP targets and RSS | Read pages and feed entries; observe changes and stable/failing/flapping endpoints | Multiple paths under one site origin; use the implemented clock and request-counter behavior |
| Vercel | Read project/deployment inventory and test one supported metadata write | No claim that the emulator deploys or executes an application |
| MongoDB Atlas | Read projects and clusters | Inventory, not a MongoDB database; exclude the retired Data API from core app storage |
| Clerk | Read users/memberships and exercise a supported identity change | No implied webhook support; test applicable SDK calls |
| Okta | Read directory/groups and exercise a supported membership or identity action | Current auth differs from production `SSWS`; expose this limit |
| Microsoft | Local work-account sign-in and current-user detail | No Outlook, Teams, Graph list/write, or Workbench provider view |
| Apple | Local sign-in, refresh, and revoke | No claim for unsupported PKCE, client-secret validation, or email relay |
| PostgreSQL | Save and reopen app cases, assignments, receipts, and preferences | Add migrations, transactions, CRUD, and reset-preservation tests |
| MariaDB | Run the same app persistence tests through its alternative profile | Test MariaDB behavior; do not claim Oracle MySQL parity |
| AWS IAM, SQS, STS | Explain why unavailable | Current resolver rejects the listener conflict; do not simulate success |
| Example MCP server | Exercise its distinct stdio tool interface in advanced verification | It is not the Notion MCP endpoint; replace its duplicate browser UI only after coverage transfers |

Keep one machine-readable workflow registry. Each entry must specify the screen,
service, exact operation, selected request fields, response assertions, SDK/driver
version, prerequisites, write scope, readback, evidence paths, and known gaps.
Validate route and test references automatically. Pin new SDK versions when
their local calls pass; do not copy an untested SDK badge from a design frame.

Start the core operation registry with these measured route names. The app-level
SDK workflows still need their own tests:

| Adapter | Initial operation set | Existing evidence |
| --- | --- | --- |
| Slack | `conversations.list`, `conversations.history`, `conversations.replies`, `users.list`, `chat.postMessage` | `emulators/emulate/src/overrides/slack-history.test.mjs`; checked onboarding examples |
| GitHub | `GET/POST /repos/:owner/:repo/issues`, `GET /repos/:owner/:repo/issues/:issue_number`, issue comments | `emulators/emulate/src/overrides/github-issues.test.mjs` |
| Gmail | Thread/message reads; `POST /gmail/v1/users/:userId/messages/send` with raw MIME | Google route inventory and focused signing/batch tests; add official SDK reply/readback test |
| Notion | Search, page reads, `PATCH /v1/blocks/:block_id/children` | `notion-sdk-all-methods.test.mjs`, `notion-openapi-lifecycle.test.mjs`; pinned `@notionhq/client` 5.26.0 |
| Stripe | Customer/invoice/subscription reads; invoice item and draft invoice creation | `emulators/emulate/src/overrides/stripe-billing.test.mjs`; pinned `stripe` 22.6.1 |
| S3 | Object `PUT/GET/HEAD/DELETE`, object listing under a known bucket | `emulators/s3/test/protocol-test.mjs`; add official SDK byte/hash readback test |

Use the [Notion page](../../docs/providers/notion.md) for the full paths of its
test files and separate REST, Admin, MCP, Agent, Workers, and webhook contracts.
An SDK version already tested by the provider suite still needs its Account Desk
workflow test. For Okta, measure whether the official SDK can use the current
local auth contract; the missing production `SSWS` behavior may require a
provider fix before that integration can pass.

Keep these support labels separate from execution results:

- Supported and contract-tested
- Supported but partial
- Workbench-only
- Not supported
- Not verified against the production provider

## State, writes, reset, and events

- Associate app mappings with the active world and accepted artifact. Resolve
  provider identities through APIs or explicit mappings, not fuzzy text matches.
- Implement authenticated, development-only Connector v1 discovery, plan, seed,
  event, and status. Plan is read-only. Seed and event delivery are idempotent.
  The connector declares app-owned reset unavailable.
- Store approved workflow steps and receipts before advancing. There is no
  transaction across Gmail, GitHub, and Notion. Show partial completion.
- Use provider idempotency where supported. On an ambiguous timeout, reconcile
  the result before retry. Never automatically resend a successful email.
- Confirm writes with fresh provider reads. Report API readback, Workbench
  visibility, runtime observation, webhook capture, and receiver delivery as
  separate facts. A green HTTP response alone is not sufficient.
- Normal world reset preserves app database records. Detect stale references
  and revoked tokens; show reconnect or explicit reseed. Do not reset the world
  automatically on page load, app start, or a verification run.
- `down` removes temporary database container state. Test restart persistence
  separately from normal world reset; do not promise persistence after `down`.
- Use isolated instances and app tenants for automated write tests. Cleanup
  must affect only records and instances that the test owns.
- Measure each provider's event behavior. The current event guide and Stripe
  page differ on runtime observation wording; do not assume that every direct
  SDK write appears in the runtime ledger.

## Build phases and acceptance gates

### 1. App foundation and installed-package start

Add the app package, Vite/React shell, Node API, local bindings adapter, project
configuration, and PostgreSQL migrations. Reproduce the supplied layout. Add
read-only connection status and partial loading. Add Connector v1 with mapping
preview and an explicit initial seed action.

Gate: the documented four-command flow works from outside the checkout. The
browser shows real available data. No production provider requests occur. A
stopped service shows a useful error without breaking all screens.

### 2. One complete customer workflow

Connect Slack, Gmail, GitHub, Stripe, Notion, and S3. Complete attention card,
case detail, editable draft, approval, saved result, and source inspection.
Store app-owned case state. Add the first shared verification workflow now.

Gate: a visitor completes one useful task; each approved change has API
readback and applicable Workbench confirmation. Reload preserves app records.
Duplicate approval and a mid-workflow failure do not repeat successful writes.

### 3. Remaining customer and service-health workflows

Add Linear, Calendar, Drive, Local Mail, Resend, Twilio, HTTP targets, RSS,
content changes, and expected-failure handling. Complete Customers and Work.

Gate: each action has a real request, assertions, and recovery behavior. A
flapping or failing endpoint passes only when its expected sequence is proved.

### 4. Connections and inventory

Add Clerk, Okta, Microsoft, Apple, Vercel, and Atlas. Add Slack, GitHub, and
Google OAuth regression coverage to replace the removed app checks.

Gate: interactive consent, invalid state, revoked credentials, and reset are
tested for the implemented flows. Unsupported identity branches are explained.
Do not show a Connect button that pretends to add a service to a running world.

### 5. Complete Verification and advanced operations

Finish selection, streaming results, failure details, safe retry, and JSON
report export. Add Notion MCP, Agent, Workers, Admin, signed local captures,
other supported webhooks, and the distinct example MCP stdio checks.

Gate: the UI and headless runner call the same workflows. A result contains
world/package/image identity, operation, measured duration, expected/actual
values, and redacted evidence. Passing/executed and covered/planned totals are
separate. Unselected workflows have named skip reasons; selected failures fail.

### 6. Dynamic worlds, both databases, and lifecycle

Run the app against the included SaaS and retail worlds plus generated worlds
with different names, IDs, counts, and ports. Test a reduced-service run. Run
migrations and persistence checks against PostgreSQL and MariaDB separately.

Gate: no default-company constants are required. Reset restores provider data
and preserves app records. Stale links and authentication recover correctly.
Restart, down, timeouts, concurrent approvals, and missing prerequisites have
explicit results. No fixture fallback masks an integration defect.

### 7. Browser proof, documentation, and handoff

Test every visible control, keyboard path, empty/error state, and source link.
Capture screenshots of actual successful and failed runs. Add a short app README
with start/open/verify/reset/stop instructions and exact service coverage.

Gate: app build, unit tests, installed-package tests, live workflows, browser
tests, and support-reference checks pass. List unresolved limits explicitly.
Only then describe Account Desk as a working all-service demo.

## Test commands to implement

These app scripts now exist:

```sh
npm run build
npm test
npm run test:installed-package
npm run test:coverage
npm run test:databases
npm run test:first-run
npx worldfixture run -- npm run verify
```

Write verification must require an explicit isolated-test target or confirmation
of its write scope. The headless runner exits nonzero for selected failures and
incomplete required coverage. It must not turn an infrastructure failure into a
successful skipped run.

Browser checks currently use the Browser tool; there is no `test:browser`
package script. The standalone MCP example and Notion Workers adapter are not
integrated. The coverage registry states these gaps explicitly.

The new `tests/image/coupling-*` work checks source-to-provider content. Preserve
it and use its reports as complementary evidence. It does not replace UI,
approval, SDK write, connector, or app-persistence tests. Do not change that
in-progress work while building this app without checking for overlap.

## Completion rule

No screen is complete because it renders. No write is complete because it
returns 200. No service is covered because its health endpoint answers.

The app is complete when every visible supported action runs against the local
services, produces checked evidence, handles failure, and passes the same
workflow through the UI and automated runner. Unsupported operations remain
clearly identified. They must not be replaced with fake successful state.
