# Slack

WorldFixture uses `@emulators/slack` 0.10.0. WorldFixture adds dynamic message
history and membership data from the selected world.

| Question | Answer |
| --- | --- |
| Overall API status | **Supported but partial** |
| Production comparison | **Not verified against the production provider** |
| Workbench | Live API reads and writes |
| State | Persistent for the life of the world |
| Reset | Restores the accepted world snapshot |
| Implementation owner | emulate.dev, with WorldFixture seed overrides |

“Partial” has a specific meaning here: only the methods in the next table are
registered. Slack has many other APIs, and WorldFixture does not implement them.

## What works

You can read and write messages, channels, DMs, users, files, reactions, pins,
bookmarks, and local views. The Workbench reads and writes the same Slack state.

## What does not work

Slack Connect, Enterprise Grid administration, Audit Logs, SCIM, Socket Mode,
slash commands, user groups, reminders, calls, canvases, lists, workflows, and
exact rate limits do not work.

## Connection and authentication

Use `SLACK_BASE_URL` as the client base URL and `SLACK_TOKEN` as the token.
Send `Authorization: Bearer <token>`. A known world token is required. An
absent or unknown token returns `ok: false` and `error: "not_authed"`.

The standard world sets `strict_scopes: false`. WorldFixture does not reproduce
production scope checks or rate limits.

## Registered methods

Each row gives the exact registered HTTP method and Slack method path. Unless a
row says otherwise, the route exists but does not have its own contract test.

| Area | HTTP method and path | What works |
| --- | --- | --- |
| Authentication | `POST /api/auth.test` | Known and unknown token handling. This route is **Supported and contract-tested** by `emulators/emulate/src/main.test.mjs`. |
| Chat | `POST /api/chat.postMessage`, `POST /api/chat.postEphemeral`, `POST /api/chat.update`, `POST /api/chat.delete`, `POST /api/chat.scheduleMessage`, `POST /api/chat.deleteScheduledMessage`, `POST /api/chat.scheduledMessages.list`, `POST /api/chat.meMessage` | Create, change, delete, and schedule local messages |
| Permalinks | `GET` or `POST /api/chat.getPermalink` | Return a local message permalink |
| Conversations | `POST /api/conversations.list`, `POST /api/conversations.info`, `POST /api/conversations.create`, `POST /api/conversations.archive`, `POST /api/conversations.unarchive`, `POST /api/conversations.rename`, `POST /api/conversations.setTopic`, `POST /api/conversations.setPurpose` | Read and change local conversations |
| Conversation messages | `POST /api/conversations.history`, `POST /api/conversations.replies`, `POST /api/conversations.mark` | Read channel or DM history and threads; set a read marker |
| Conversation membership | `POST /api/conversations.join`, `POST /api/conversations.leave`, `POST /api/conversations.invite`, `POST /api/conversations.kick`, `POST /api/conversations.open`, `POST /api/conversations.close`, `POST /api/conversations.members` | Change and read local membership and DMs |
| Users | `POST /api/users.list`, `POST /api/users.info`, `POST /api/users.lookupByEmail` | Read local users |
| Profiles and presence | `GET` or `POST /api/users.profile.get`; `POST /api/users.profile.set`; `GET` or `POST /api/users.getPresence`; `POST /api/users.setPresence` | Read and change profiles and presence |
| Reactions | `POST /api/reactions.add`, `POST /api/reactions.remove`, `POST /api/reactions.get` | Add, remove, and read local reactions |
| Team and bots | `POST /api/team.info`, `POST /api/bots.info` | Read local team and bot records |
| OAuth | `GET /oauth/v2/authorize`; `POST /oauth/v2/authorize/callback`; `POST /api/oauth.v2.access` | Local authorization-code flow |
| Incoming webhook | `POST /services/:teamId/:botId/:token` | Add a message to the local store |
| External file upload | `POST /api/files.getUploadURLExternal`; `POST /upload/v1/:fileId`; `POST /api/files.completeUploadExternal` | Allocate, upload, and complete a local file |
| File reads and delete | `GET` or `POST /api/files.info`; `GET` or `POST /api/files.list`; `GET /files-pri/:fileId/:filename`; `POST /api/files.delete` | Read file metadata and bytes; delete files |
| Pins | `POST /api/pins.add`, `POST /api/pins.remove`; `GET` or `POST /api/pins.list` | Add, remove, and list pins |
| Bookmarks | `POST /api/bookmarks.add`, `POST /api/bookmarks.edit`, `POST /api/bookmarks.list`, `POST /api/bookmarks.remove` | Manage local channel bookmarks |
| Views | `POST /api/views.publish`, `POST /api/views.open`, `POST /api/views.update`, `POST /api/views.push`, `POST /api/views.generateTriggerId` | Store local modal and Home view data |

Most methods accept JSON or form fields with the names in the Slack Web API.
The important identifiers are `channel`, `ts`, `user`, `file`, and
`cursor`. List responses use the Slack resource array and
`response_metadata.next_cursor`. Errors use `ok: false` and `error`.

## Workbench, state, events, and SDKs

The Workbench calls `conversations.list`, reads each conversation with
`conversations.history`, and selects the conversation that has the latest
message. It writes with `chat.postMessage`. These actions use the same store as
API clients.

The emulator can keep incoming webhook and local interaction state. Exact Slack
Events API delivery, signatures, retries, Socket Mode, and production event
payloads are **Not verified against the production provider**.

The examples use `@slack/web-api` 7.12.0 and `slack_sdk` 3.36.0. These
versions do not have full provider contract coverage. SDK methods that call a
route not listed above are **Not supported**.

## Detailed limits

Slack Connect, Enterprise Grid administration, Audit Logs, SCIM, Socket Mode,
slash commands, user groups, reminders, calls, canvases, lists, workflows, and
exact rate limits are **Not supported**.

## Evidence and authority

Tests: `emulators/emulate/src/main.test.mjs`,
`emulators/emulate/src/overrides/slack-history.test.mjs`,
`runtime/src/supervisor.test.mjs`, `runtime/src/cli.test.mjs`, and
`tests/contracts/test_compiler_core.py`.

Authority: [Slack Web API methods](https://api.slack.com/methods) and
[Slack Events API](https://api.slack.com/apis/connections/events-api).
