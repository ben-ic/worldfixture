# Google

WorldFixture uses `@emulators/google` 0.10.0. WorldFixture adds signing-key,
declared-user, Gmail batch, Gmail push, and Calendar/Drive webhook behavior.

| Question | Answer |
| --- | --- |
| Overall API status | **Supported but partial** |
| Production comparison | **Not verified against the production provider** |
| Workbench | Live Gmail Inbox, Sent, and send action |
| State | Gmail, Calendar, Drive, and OAuth writes persist for the world |
| Reset | Restores the accepted world snapshot |
| Implementation owner | emulate.dev, with WorldFixture overrides |

“Partial” means that WorldFixture implements only the route groups below. It
does not implement all Google APIs or all operations in these APIs.

OAuth applications must be [declared in world source](../guides/worlds.md#declare-oauth-clients).
The local flow checks the declared client, exact callback URL, and selected
world user. Undeclared sample clients are rejected.

## What works

You can read and send Gmail messages, manage common Gmail records, use a small
Calendar and Drive API, and run a local OAuth flow. The Workbench reads and
sends mail through the same Gmail state.

## What does not work

There is no full Pub/Sub service. Calendar event get and update by ID do not
work. Drive delete, permissions, comments, revisions, and shared drives
do not work. The Drive changes feed covers local file writes. Google APIs that are not on this page do not work.

## Connection and authentication

Use `GOOGLE_BASE_URL` and `GOOGLE_TOKEN`. Send
`Authorization: Bearer <token>`. Gmail routes use the authenticated world
user. The `:userId` path can be `me` or the authenticated user.

Gmail, Calendar, and Drive share the same [local request budget](./index.md#local-request-limits).
New source-built images use 100,000 counts per token per hour. Older images
retain their previous limit. This is not Google's production quota model.

## OAuth and OpenID Connect

| HTTP method and path | What works and important fields | Proof |
| --- | --- | --- |
| `GET /.well-known/openid-configuration` | Local issuer and endpoint URLs | Registered route |
| `GET /oauth2/v3/certs` | Stable public RS256 `keys`; private key data is not returned | `google-signing.test.mjs` |
| `GET /o/oauth2/v2/auth` | Local authorization page with common OAuth query values | Registered route |
| `POST /o/oauth2/v2/auth/callback` | Local user selection and authorization-code redirect | Registered route |
| `POST /oauth2/token` | Local access, refresh, and RS256 ID token responses | Registered route |
| `GET /oauth2/v2/userinfo` | Claims for the authenticated world user | Registered route |
| `POST /oauth2/revoke` | Local token revocation | Registered route |

WorldFixture restores the accepted signing key after reset. It does not
reproduce all Google consent, client validation, scope, and token rules.

## Gmail

| Operations | Exact HTTP method and path | Important inputs and response fields |
| --- | --- | --- |
| List and get messages | `GET /gmail/v1/users/:userId/messages`; `GET /gmail/v1/users/:userId/messages/:id` | Filters include `labelIds`, `q`, `includeSpamTrash`, `maxResults`, `pageToken`, and `format`; responses include `messages`, `id`, `threadId`, `payload`, and label data |
| Insert, import, and send | `POST /gmail/v1/users/:userId/messages`, `messages/import`, `messages/send`; the same paths under `/upload/gmail/v1` | JSON or supported upload body with raw MIME or local `from` and `to`; returns a message resource |
| Change or delete messages | `POST /gmail/v1/users/:userId/messages/:id/modify`, `trash`, `untrash`; `DELETE /gmail/v1/users/:userId/messages/:id` | `addLabelIds`, `removeLabelIds`; returns a message or 204 |
| Batch message changes | `POST /gmail/v1/users/:userId/messages/batchModify`, `messages/batchDelete` | `ids` and label arrays; returns 204 |
| Attachments | `GET /gmail/v1/users/:userId/messages/:messageId/attachments/:id` | Returns `attachmentId`, `size`, and base64url `data` |
| Drafts | `GET` and `POST /gmail/v1/users/:userId/drafts`; `GET`, `PUT`, and `DELETE /gmail/v1/users/:userId/drafts/:id`; `POST /gmail/v1/users/:userId/drafts/send`; supported upload paths under `/upload/gmail/v1` | Local draft and message resources |
| Threads | `GET /gmail/v1/users/:userId/threads`, `threads/:id`; `POST .../threads/:id/modify`, `trash`, `untrash`; `DELETE .../threads/:id` | Thread `id`, `historyId`, and `messages` |
| Labels | `GET /gmail/v1/users/:userId/labels`, `labels/:id`; `POST .../labels`; `PUT`, `PATCH`, and `DELETE .../labels/:id` | Label name, visibility, color, type, and message counters |
| History | `GET /gmail/v1/users/:userId/history` | Requires `startHistoryId`; supports `historyTypes`, `labelId`, `maxResults`, and `pageToken` |
| Filters | `GET` and `POST /gmail/v1/users/:userId/settings/filters`; `DELETE .../filters/:id` | Local filter criteria and action |
| Forwarding and send-as reads | `GET /gmail/v1/users/:userId/settings/forwardingAddresses`; `GET .../settings/sendAs` | Local forwarding and identity arrays |
| Watch control | `POST /gmail/v1/users/:userId/watch`, `.../stop` | Watch requires `topicName`; returns `historyId` and `expiration` |
| Batch transport | `POST /batch/gmail/v1` | At most 100 relative Gmail `GET` parts and a 1 MiB multipart envelope. `google-batch.test.mjs` proves the wrapper. |

## Calendar and Drive

| API | Exact HTTP method and path | What works |
| --- | --- | --- |
| Calendar list | `GET /calendar/v3/users/:userId/calendarList` | Returns `kind` and local calendar `items` |
| Calendar events | `GET` and `POST /calendar/v3/calendars/:calendarId/events`; `DELETE .../events/:eventId` | List, create, and delete; list supports time range, query, order, limit, and page token |
| Free/busy | `POST /calendar/v3/freeBusy` | Local busy ranges for requested calendars |
| Drive list and create | `GET` and `POST /drive/v3/files`; `POST /upload/drive/v3/files` | List and create metadata or multipart content; response uses `files` and `nextPageToken` |
| Drive get and update | `GET`, `PATCH`, and `PUT /drive/v3/files/:fileId` | Read metadata or `alt=media`; change name and parents |

Calendar event get and update by ID are **Not supported**. Drive delete,
permissions, comments, revisions, and shared-drive operations are
**Not supported**.

## Calendar and Drive push notifications

Calendar and Drive can send native notification POSTs to an external receiver.
Each request has an empty body and `X-Goog-*` headers. It does not contain
resource content. After a notification, read the resource or its change feed.
The receiver gets an initial `sync` request with message number `1`.

| Operation | Route | Local behavior |
| --- | --- | --- |
| Watch Calendar events | `POST /calendar/v3/calendars/:calendarId/events/watch` | Initial sync, then `exists` after successful event creation or deletion; supports `eventTypes` filters |
| Watch the calendar list | `POST /calendar/v3/users/:userId/calendarList/watch` | Initial sync; list notifications when an implemented REST write changes the owner's calendar records |
| Watch a Drive file | `POST /drive/v3/files/:fileId/watch` | Initial sync, then `update` after name or parent changes; `X-Goog-Changed` identifies the changed field group |
| Watch Drive changes | `POST /drive/v3/changes/watch?pageToken=<token>` | Initial sync, then `change` after successful file writes |
| Read Drive changes | `GET /drive/v3/changes/startPageToken`; `GET /drive/v3/changes?pageToken=<token>` | Owner-specific local file changes, with pagination and a new start token |
| Stop notifications | `POST /calendar/v3/channels/stop`; `POST /drive/v3/channels/stop` | Requires the channel `id`, `resourceId`, owner, and client |

Enable external delivery in the Google service seed configuration:

```json
{
  "webhooks": {
    "live_delivery": true,
    "allow_insecure_http": true
  }
}
```

The default captures notifications without a network request.
`WORLDFIXTURE_GOOGLE_WEBHOOK_DELIVERY=1` also enables external delivery.
`allow_insecure_http` permits HTTP for local receivers; omit it for HTTPS.
Use a receiver address reachable from the emulator process, such as
`http://host.docker.internal:3000/google-events` for a receiver on the Docker
host. Create a channel with this request body and a normal Google bearer token:

```json
{
  "id": "my-unique-channel",
  "type": "web_hook",
  "address": "http://host.docker.internal:3000/google-events",
  "token": "my-channel-token"
}
```

The response has `kind: "api#channel"`, `id`, `resourceId`, `resourceUri`,
`expiration`, and the optional `token`. Notification headers use these same
values. Tokens are echoed in `X-Goog-Channel-Token`; Google does not use an
HMAC signature for these notifications. Message numbers increase after sync.
Expired or stopped channels do not receive new notifications or pending retries.

Calendar channels default to seven days. Drive channels default to one hour;
file channels have a one-day limit and change channels have a seven-day limit.
`expiration` is a Unix timestamp in milliseconds. `params.ttl` is in seconds.
Notifications use `User-Agent: APIs-Google`. Temporary server errors
(`500`, `502`, `503`, `504`) and connection errors retry with exponential
backoff. Other failures stop delivery. The fixture retry delays are 1, 2, 4, 8,
and 16 seconds; Google does not publish an exact schedule or attempt limit.
Timers are in memory and do not survive a process restart.

ACL and Settings watch are not supported because their resource APIs are not
implemented. Shared-drive watch and change filters are not supported. The
CalendarList API currently has no write routes, so normal CalendarList watches
receive only sync. Direct store changes do not produce these notifications.
The receiver's `robots.txt` is not checked. Seeded tokens share one local client
unless their auth record sets `client_id`. OAuth tokens retain their client.
These limits are separate from the native header and empty-body contract.

## Workbench, events, and SDKs

The Workbench reads Inbox and Sent through Gmail routes. It sends mail through
`messages.send`. The Workbench and API clients use one provider store.

Gmail push sends a Pub/Sub-shaped envelope to
`WORLDFIXTURE_PUBSUB_PUSH_URL`. There is no Pub/Sub management API. The watch
operation causes an initial notification on the next local polling tick.
Production Gmail sends this notification immediately. The local polling interval
defaults to two seconds. Authenticated Pub/Sub push JWTs and subscription retry
policies are not implemented.

No official `googleapis` SDK version has a provider contract test. An SDK call
works only if it maps to a route in this page.

## Detailed limits

Google APIs not listed on this page are **Not supported**. This includes full
Pub/Sub, Admin SDK, Chat, Sheets, Docs, Meet, Tasks, Groups, and production rate
limits. Exact OAuth and push timing are **Not verified against the production
provider**.

## Evidence and authority

Tests: `google-signing.test.mjs`, `google-batch.test.mjs`,
`declared-oauth-extra.test.mjs`, `gmail-push.test.mjs`, `webhooks/google.test.mjs`, and compiler contract tests
under `tests/contracts/`.

Authority: [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2),
[Gmail API](https://developers.google.com/gmail/api/reference/rest),
[Calendar API](https://developers.google.com/calendar/api/v3/reference), and
[Drive API](https://developers.google.com/drive/api/reference/rest/v3).

Webhook references: [Calendar push notifications](https://developers.google.com/workspace/calendar/api/guides/push),
[Calendar events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch),
and [Drive push notifications](https://developers.google.com/workspace/drive/api/guides/push).


Gmail push sends an initial notification after each successful watch.
Retries preserve the Pub/Sub message ID, publish time, and raw body. Notifications follow the include
or exclude label filters. Stop and expiration end delivery. A renewed watch
starts a new notification sequence. The polling interval defaults to two seconds. Set `WORLDFIXTURE_PUBSUB_SUBSCRIPTION` for an exact
subscription name. Authenticated Pub/Sub JWT delivery is not implemented.
