# Events and webhooks

WorldFixture records a fact only after a provider accepts an operation. The
event contains the actor, source, time, and provider evidence such as a Slack
message timestamp or GitHub issue number.

```sh
npx worldfixture events
npx worldfixture events --follow
```

Scheduled arrivals use the world-relative clock and the same provider APIs as a
manual action. A causal rule can create a later action. For example, a Slack
message can cause Local Mail notification delivery through SMTP.

Provider webhooks are provider-specific. Do not assume that an implemented
write produces a production-shaped outbound webhook. The
[provider support index](../providers/index.md) and provider page state which
webhook events are contract-tested, captured only, or not supported.

The connector event endpoint uses at-least-once delivery. A connector must make
`event_id` idempotent.
