# Google

WorldFixture uses `@emulators/google` 0.10.0. WorldFixture adds signing-key,
declared-user, Gmail batch, and Gmail push behavior.

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

## What works

You can read and send Gmail messages, manage common Gmail records, use a small
Calendar and Drive API, and run a local OAuth flow. The Workbench reads and
sends mail through the same Gmail state.

## What does not work

There is no full Pub/Sub service. Calendar event get and update by ID do not
work. Drive delete, permissions, comments, revisions, changes, and shared drives
do not work. Google APIs that are not on this page do not work.

## Connection and authentication

Use `GOOGLE_BASE_URL` and `GOOGLE_TOKEN`. Send
`Authorization: Bearer <token>`. Gmail routes use the authenticated world
user. The `:userId` path can be `me` or the authenticated user.

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
permissions, comments, revisions, changes, and shared-drive operations are
**Not supported**.

## Workbench, events, and SDKs

The Workbench reads Inbox and Sent through Gmail routes. It sends mail through
`messages.send`. The Workbench and API clients use one provider store.

Gmail push sends a Pub/Sub-shaped envelope to
`WORLDFIXTURE_PUBSUB_PUSH_URL`. There is no Pub/Sub management API. The watch
operation does not send the immediate notification that production Gmail sends.
Push behavior is limited to this local delivery.

No official `googleapis` SDK version has a provider contract test. An SDK call
works only if it maps to a route in this page.

## Detailed limits

Google APIs not listed on this page are **Not supported**. This includes full
Pub/Sub, Admin SDK, Chat, Sheets, Docs, Meet, Tasks, Groups, and production rate
limits. Exact OAuth and push timing are **Not verified against the production
provider**.

## Evidence and authority

Tests: `google-signing.test.mjs`, `google-batch.test.mjs`,
`google-users.test.mjs`, `gmail-push.test.mjs`, and compiler contract tests
under `tests/contracts/`.

Authority: [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2),
[Gmail API](https://developers.google.com/gmail/api/reference/rest),
[Calendar API](https://developers.google.com/calendar/api/v3/reference), and
[Drive API](https://developers.google.com/drive/api/reference/rest/v3).
