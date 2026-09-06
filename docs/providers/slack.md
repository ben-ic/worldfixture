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

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

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

WorldFixture sends Slack Events API callbacks to an external HTTP receiver.
These callbacks use the Slack envelope and signing protocol. They are separate
from WorldFixture Connector v1 events. Socket Mode is **Not supported**.

## Events API webhooks

Set `slack.events_api` in the emulator seed overlay. Start the app receiver before
WorldFixture starts. Use an address that the emulator can reach; for a receiver on
the Docker host, this can be `http://host.docker.internal:3000/slack/events`.

```json
{
  "slack": {
    "events_api": {
      "request_url": "http://host.docker.internal:3000/slack/events",
      "signing_secret": "local-slack-signing-secret",
      "app_id": "A0123456789",
      "user": "mayac",
      "events": ["message.channels", "reaction_added", "reaction_removed"]
    }
  }
}
```

`user` must name a declared Slack user. You can instead set `user_id` to that
user's Slack ID. The callback uses the world's user and workspace IDs. Set
`app_id` to the app ID expected by the receiver. You can also set
`verification_token`; otherwise, WorldFixture generates it and saves it with
the provider state. Configure the app to check `X-Slack-Signature` with the same
`signing_secret`.

At startup, WorldFixture sends a signed `url_verification` request. The receiver
must return HTTP 200 with its `challenge` value as plain text, JSON, or a form
field within three seconds. Startup fails if verification fails. A restored provider snapshot
retains the verified subscription.

Successful API writes send asynchronous `event_callback` POSTs. A slow receiver
does not hold the Slack API response. Each callback has a unique `event_id`,
`event_time`, the app and workspace IDs, installation authorization, and an inner
Slack event. Message timestamps and resource IDs match the API state.

| Subscriptions | Trigger |
| --- | --- |
| `message.channels`, `message.groups`, `message.im`, `message.mpim` | Message creation, thread replies, edits, deletion, and message subtypes emitted by supported conversation methods |
| `reaction_added`, `reaction_removed` | Add or remove a message reaction |
| `user_change` | Change standard profile data; changes to custom fields alone do not send an event |
| `channel_archive`, `channel_unarchive`, `channel_rename`, `group_archive`, `group_unarchive`, `group_rename` | Change channel state or name |
| `member_joined_channel`, `member_left_channel` | Change channel membership; creating a channel sends a join event for its creator |
| `file_created`, `file_shared`, `file_deleted` | Complete an upload, share a file, or delete it |
| `pin_added`, `pin_removed` | Add or remove a message pin |

The subscription controls which events the receiver gets. Private channel and DM
events require membership. Bot installations also require membership for public
channel events. Pin and `member_joined_channel` events require membership for
user installations in public channels too. These rules follow Slack's
[pin event](https://docs.slack.dev/reference/events/pin_added/) and
[member join event](https://docs.slack.dev/reference/events/member_joined_channel/)
contracts. Ephemeral messages and RTM-only presence events do not produce
Events API callbacks. Unknown subscription names cause a configuration error.

WorldFixture signs the exact JSON bytes with Slack's `v0` HMAC-SHA256 protocol.
The receiver must return HTTP 2xx within three seconds. Delivery follows up to
two HTTP 301/302 redirects. Failed delivery has up to three retries: immediately,
after one minute, then after five minutes. Retries retain the event ID and body
and add `X-Slack-Retry-Num` and `X-Slack-Retry-Reason`. A failed response with
`X-Slack-No-Retry: 1` stops retries. These rules follow the
[Slack Events API delivery contract](https://docs.slack.dev/apis/events-api/) and
[request signing protocol](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

This coverage is **Supported and contract-tested locally**, not verified against
production Slack. App mentions, `channel_created` callbacks, DM open/close
callbacks, and event types absent from the table are not implemented. Production
scope enforcement, event rate limits, automatic subscription disabling, delayed
event delivery, and `apps.event.authorizations.list` are not implemented.
Pending retries do not survive process restart. Full fidelity for every Slack
event is not claimed.

Channel creation sends `member_joined_channel`. A change to custom profile
fields alone does not send `user_change`, as
[Slack specifies](https://docs.slack.dev/reference/events/user_change/).
Only one app installation can be configured per world. Local HTTP receiver URLs
are allowed for development; Slack checks the receiver's SSL certificate.

The examples use `@slack/web-api` 7.12.0 and `slack_sdk` 3.36.0. These
versions do not have full provider contract coverage. SDK methods that call a
route not listed above are **Not supported**.

## Detailed limits

Slack Connect, Enterprise Grid administration, Audit Logs, SCIM, Socket Mode,
slash commands, user groups, reminders, calls, canvases, lists, workflows, and
exact rate limits are **Not supported**.

## Evidence and authority

Tests: `emulators/emulate/src/main.test.mjs`,
`emulators/emulate/src/webhooks/slack.test.mjs`,
`emulators/emulate/src/overrides/slack-history.test.mjs`,
`runtime/src/supervisor.test.mjs`, `runtime/src/cli.test.mjs`, and
`tests/contracts/test_compiler_core.py`.

Authority: [Slack Web API methods](https://api.slack.com/methods) and
[Slack Events API](https://api.slack.com/apis/connections/events-api).
