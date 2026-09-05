# Resend

## What works

WorldFixture supports local email send, batch send, list, get, and cancel. It
also supports selected domains, API keys, audiences, and audience contacts.
API support label: **Supported but partial**. The local inbox is
**Workbench-only**.

## What does not work

The current global Contact API, broadcasts, templates, topics, receiving,
suppression management, production delivery, production domain verification,
and webhooks do not work. These operations are **Not supported**. Production
behavior and the official Resend SDK are
**Not verified against the production provider**.

## Connect

Use `RESEND_BASE_URL` and `RESEND_TOKEN`. Send
`Authorization: Bearer TOKEN_VALUE` and JSON bodies. The local routes also
accept anonymous requests. They do not apply Resend's production `User-Agent`
rule. Do not depend on these differences.

WorldFixture uses `@emulators/resend` 0.10.0.

## Route reference

| Method and path | Input | Output | Proof |
| --- | --- | --- | --- |
| `POST /emails` | Sender, recipients, subject, and supported content fields | `id` | Registered route source |
| `POST /emails/batch` | Array of supported email objects | `data[]` with IDs | Registered route source |
| `GET /emails` | Local list query | Email list | Registered route source |
| `GET /emails/:id` | Email ID | Sender, recipients, subject, content, status, and timestamps | Registered route source |
| `POST /emails/:id/cancel` | Email ID | Updated email state | Registered route source |
| `POST, GET /domains` | Domain JSON or list query | Domain data | Registered route source |
| `GET, DELETE /domains/:id` | Domain ID | Domain object or delete result | Registered route source |
| `POST /domains/:id/verify` | Domain ID | Updated local verification state | Registered route source |
| `POST, GET /api-keys` | Key name or list query | Key metadata; create returns the local secret | Registered route source |
| `DELETE /api-keys/:id` | Key ID | Delete result | Registered route source |
| `POST, GET /audiences` | Audience name or list query | Audience data | Registered route source |
| `DELETE /audiences/:id` | Audience ID | Delete result | Registered route source |
| `POST, GET /audiences/:audience_id/contacts` | Contact JSON or list query | Contact data | Registered route source |
| `DELETE /audiences/:audience_id/contacts/:id` | Audience and contact IDs | Delete result | Registered route source |
| `GET /inbox`, `GET /inbox/:id` | Optional message ID | Local inbox data | Registered local route source |

Email create accepts the local subset of sender, recipient, subject, HTML, text,
reply-to, CC, BCC, headers, tags, attachments, and schedule data. Domain data
includes ID, name, status, records, and timestamps. Contact data includes ID,
email, names, unsubscribe state, and timestamps.

## State, reset, Workbench, and proof

Writes change the store that API reads and the Workbench use. The Workbench
reads emails, domains, audiences, and contacts through the live API. It has no
Resend write control. Reset restarts and reseeds the store. Stop does not
preserve this state.

Implementation: emulate.dev. WorldFixture adds no Resend API route. Proof is
the registered route source, compiler projection tests, and live Workbench
reads. No endpoint has a Resend contract test or production recording. No
official SDK version has a WorldFixture test.

Provider authority: [Resend API reference](https://resend.com/docs/api-reference/introduction).
