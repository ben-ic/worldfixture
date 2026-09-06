# Native provider webhooks

WorldFixture sends native provider HTTP notifications to a connected app.
The app receives the provider's body and verification headers. Connector v1
events and the runtime event ledger remain separate interfaces.

Each provider supports the event sets listed below. Provider pages describe
configuration, request formats, and unsupported features.

## Setup

Configure the destination with the provider API when that API is implemented.
For settings that normally come from a provider dashboard, use the JSON
`WORLDFIXTURE_SEED_OVERLAY` setting in the emulator process or container.
The overlay must extend a provider that the selected world already declares.
An application environment setting alone does not configure the emulator.

The callback URL must be reachable from the emulator. In Docker, an app on
the host can use `http://host.docker.internal:PORT/PATH`. Use the app's own
address when both processes share a network. HTTP is a local fixture option;
production providers usually require HTTPS.

For example, configure Slack Events API with this overlay:

```json
{
  "slack": {
    "events_api": {
      "request_url": "http://host.docker.internal:3000/slack/events",
      "signing_secret": "local-slack-signing-secret",
      "app_id": "A0123456789",
      "user": "WORLD_SLACK_USER_NAME",
      "events": ["message.channels", "reaction_added"]
    }
  }
}
```

Use the Slack user name from the selected world. Start the app's webhook
endpoint before the emulator. It must return Slack's `challenge` for URL
verification. Later requests contain `event_callback` and the accepted Slack
resource values. Verify the raw body with `X-Slack-Signature` and
`X-Slack-Request-Timestamp`.

For Stripe, call `POST /v1/webhook_endpoints` with `url` and
`enabled_events[]`. Keep the returned `secret` in the app. Subsequent Stripe
writes produce Event objects with `evt_` IDs, `data.object`, and a
`Stripe-Signature` header. Use the endpoint secret and the raw request body to
verify the signature.

## Provider coverage

| Provider | Registration or configuration | Supported notifications |
| --- | --- | --- |
| [Slack](../providers/slack.md) | `slack.events_api` | URL verification; message, edit, delete, reaction, thread, pin, profile, channel, and file events; signing and retry headers |
| [Stripe](../providers/stripe.md) | `/v1/webhook_endpoints` or seeded webhooks | Event bodies; billing, invoice item, refund and payment snapshots; signatures, filters, retries, endpoint controls |
| [GitHub](../providers/github.md) | Native repository, organization, and App hooks | JSON and form requests, ping, installation isolation, UUID delivery IDs, signatures, manual redelivery |
| [Notion](../providers/notion.md) | Private subscription controls; `notion.webhooks.live_delivery: true` | Verification token, all 31 existing event schemas, signatures, filters, pause, deletion, retries |
| [Linear](../providers/linear.md) | Native GraphQL webhook mutations | Issue, Comment, and IssueLabel events; changed values, actor, timestamps, signing, retries |
| [Google Calendar and Drive](../providers/google.md) | Native watch and channels.stop; `google.webhooks.live_delivery: true` | Empty POST requests with `X-Goog-*` headers, sync, changes, expiration, owner/client isolation, retries |
| [Gmail](../providers/google.md) | `users.watch`; `WORLDFIXTURE_PUBSUB_PUSH_URL` | Pub/Sub bodies, initial notification, history IDs, label filters, stable retries, stop and expiry |
| [Microsoft Graph](../providers/microsoft.md) | Native subscriptions; `microsoft.webhooks.live_delivery: true` | Validation token, basic user notifications, tenant/app filters, expiration, renewal, deletion, retries |
| [Okta](../providers/okta.md) | Native eventHooks routes | Verification challenge, LogEvent bodies, header authentication, filters, hook lifecycle, retry |
| [Clerk](../providers/clerk.md) | `clerk.instance_id` and `clerk.webhooks[]` | User, session, organization, membership, and invitation events; millisecond timestamps and Svix headers |
| [Resend](../providers/resend.md) | Native `/webhooks` routes or `resend.webhooks[]` | Email, domain and contact bodies, Svix signatures, filters, retry, disable, deletion and reset isolation |
| [Vercel](../providers/vercel.md) | `vercel.webhooks[]` | Project, environment-variable and deployment events; IDs and HMAC-SHA1 signatures |
| [Twilio](../providers/twilio.md) | Native callback fields and selected Conversations configuration | SMS, Voice and selected Conversations form callbacks; GET parameters, HMAC signatures, status filters |
| [Apple](../providers/apple.md) | `apple.notifications[]`; private account-event control | All four account event types; signed JWT in `payload`; local JWKS verification |
| [MongoDB Atlas](../providers/mongodb-atlas.md) | `mongoatlas.webhooks[]`; private monitoring-event control | Native alert bodies, `X-MMS-Event`, HMAC signature, stored alert reads |

Notion, Google, and Microsoft accept local HTTP callback URLs when their
`webhooks.allow_insecure_http` setting is `true`. Their default mode captures
requests; set `live_delivery` to send them. Gmail can use
`WORLDFIXTURE_PUBSUB_SUBSCRIPTION` to set an exact Pub/Sub subscription name.

Apple and Atlas need private event controls because the event starts with an
account-owner action or monitoring fact. These controls supply native events;
they do not implement Apple's account portal or Atlas monitoring.

## Other services

S3 does not send a direct HTTP webhook. AWS delivers its event notifications
through SNS, SQS, Lambda, or EventBridge. WorldFixture does not yet connect S3
to these destinations. See [AWS notification destinations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html).

The implemented IAM, STS, and SQS operations do not provide an HTTP webhook
subscription API. SNS delivery is not implemented. Local Mail, PostgreSQL,
MariaDB, and HTTP targets do not have a provider-native webhook protocol in
the supported interfaces. Database change streams are not supported.

## Delivery limits

Treat duplicate delivery as normal and use the provider's event or delivery
ID for idempotency. Use raw bytes for signature verification. Some provider
notifications contain only a resource ID or headers; fetch the changed
resource from the provider API.

Retry policies are service-specific. Some providers publish exact delays;
others publish only a duration or backoff rule. Local timing choices are
listed on each provider page. Pending retry timers are in memory and do not
survive a process restart. Shutdown cancels pending delivery work.

Use an emulator image that includes native webhook support. Restarting the
application does not update its emulator image.
