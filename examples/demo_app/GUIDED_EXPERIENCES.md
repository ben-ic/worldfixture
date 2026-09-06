# Three guided experiences: checks

Checked on 6 September 2026 against the running local Account Desk app. The app
used the installed `npx worldfixture run` flow, PostgreSQL, the
`business.saas-company:v3` world, and `worldfixture:account-desk-100k`.
No world reset was performed for these checks.

## Browser checks

- The existing customer reply completion leads to **Continue to service health**,
  not another customer case. The completion-action test checks the callback.
  The customer reply and its fresh readback also pass the clean-install test.
- Service health opens three steps: inspect targets, run checks, review results.
  Its live result showed stable `[200,200]`, expected failure `[503,503]`,
  changing responses `[503,200,200,200,503,200]`, and eight valid RSS entries
  with stable GUIDs. No new RSS arrival was claimed.
- **Continue to Slack conversation** opened the three-step Slack guide.
  The default was the conversation with the latest message. The preview showed
  the exact three messages and required approval.
- All three messages were saved and read back. Their observed times were three
  seconds apart. The UI showed the actual sender name, Maya Chen in this world.
- A separately reviewed and approved reply appeared in the same conversation
  with a successful provider readback.
- **Explore Account Desk** opened Connections with all 22 selected groups ready.

The automated browser reload then returned Chrome `ERR_BLOCKED_BY_CLIENT`.
Browser reload recovery and the final guide's Workbench/Verification buttons
were not checked in that browser pass. Do not treat this as a completed browser
test of those controls. API repeat-approval and unit restart checks passed.

## Repeatable live checks

Use a separate local test app with no active Slack scenario. This command creates
three labelled Slack messages and keeps them in the local provider. It does not
reset the world or delete messages. Use the app URL printed by your own run:

```sh
ACCOUNT_DESK_ALLOW_TEST_WRITES=1 \
ACCOUNT_DESK_URL=http://localhost:YOUR_APP_PORT \
npx --no-install worldfixture run -- node tests/guides-live.mjs
```

The live test passed these checks:

| Check | Observed result |
| --- | --- |
| Preview | No new Slack message or running scenario |
| Approved sequence | Three messages, each matching the preview and saved receipt |
| Independent read | Official Slack SDK read the exact message timestamp, text, and sender |
| Repeated approval | Same run and receipts; no additional message |
| Stop before first send | Zero messages; no later arrival |
| Live stream | Running progress, completion, and stop received over SSE |

The completed API test run was `ed92b5ea-5d52-44ad-93da-6c0d309dd7d6`.
The stopped run was `05c59f11-1faf-4ede-9cfb-f41d02d6a67a`.
The browser run was `75cad4b9-a193-41b3-96d6-ba7a2aa059ed`.
These IDs identify local test evidence, not fixed application inputs.

## Automated checks and limits

`npm test`: 106 passed, two opt-in live tests skipped, zero failures.
`npm run build`: passed. `npm run test:coverage`: three passed and the coverage
document matches the app registry. The installed clean-start check passed
22 reads and 16 writes before this browser pass.

Relevant tests are `tests/slack-scenarios.test.mjs`, `tests/server.test.mjs`,
`tests/streaming.test.mjs`, `tests/guides-live.mjs`, and the guide tests under
`src/ui/`. Tests cover explicit approval, uncertain writes, concurrent starts,
stop during a send, restart without replay, missing services, dynamic channel
selection, and saved provider evidence.

The Slack scenario uses one configured local identity. It is scripted, not AI
output. Its progress uses app SSE; other Slack changes use API polling. This is
not Slack Socket Mode. All evidence here is local, not a production recording.
