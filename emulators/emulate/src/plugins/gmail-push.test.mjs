import { test } from "node:test";
import assert from "node:assert/strict";
import { subscriptionFor } from "./gmail-push.mjs";

test("the subscription belongs to the project the app registered its topic in", () => {
  // Real Pub/Sub attaches a push subscription to a topic inside one project, so
  // the envelope has to agree with the topic the app passed to users.watch.
  assert.equal(
    subscriptionFor("projects/inbox-zero/topics/gmail"),
    "projects/inbox-zero/subscriptions/gmail-push",
  );
  assert.equal(
    subscriptionFor("projects/some-other-app/topics/mail-changes"),
    "projects/some-other-app/subscriptions/gmail-push",
  );
});

test("an unparseable or absent topic falls back without naming a product", () => {
  for (const topic of [undefined, "", "garbage", "projects//topics/x"]) {
    const value = subscriptionFor(topic);
    assert.match(value, /^projects\/[^/]+\/subscriptions\/gmail-push$/);
    assert.doesNotMatch(value, /droplive/i);
  }
});
