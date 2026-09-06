# Events and webhooks

WorldFixture records a fact only after a provider accepts an operation. The
event contains the actor, source, time, and provider evidence such as a Slack
message timestamp or GitHub issue number.

A direct provider API write that the runtime did not originate changes provider
state but does not create a runtime ledger event.

```sh
npx worldfixture events
npx worldfixture events --follow
```

Scheduled arrivals use the world-relative clock and the same provider APIs as a
manual action. A causal rule can create a later action. For example, a Slack
message can cause Local Mail notification delivery through SMTP.

Native provider webhooks use a separate delivery path. A successful provider
write can send an HTTP request to the app without creating a runtime ledger
event. The request uses that provider's event body, headers, and signature.
It does not contain a WorldFixture Connector v1 envelope. Delivery runs
asynchronously so that a slow receiver does not block a provider API write.

Read [native webhook setup and coverage](./native-webhooks.md) before you
select an event. Each provider page lists the tested events and remaining
limits. Complete production event catalogs and timing are not verified.

The connector event endpoint uses at-least-once delivery. A connector must make
`event_id` idempotent.
