// The Slack client's refusals.
//
// One of these exists for a refusal that is not Slack-shaped. The composer's
// rate limiter answers 403 with `{message, documentation_url}` and no `ok` and
// no `error` field, so the client used to report "Slack refused
// conversations.list: unknown error" -- which names neither the cause nor the
// repair, and which is what a real run printed when a token ran out of budget.

import assert from "node:assert/strict";
import test from "node:test";

import { forgetSlackCaches, identity, send } from "./slack.mjs";

const RATE_LIMITED = () =>
  new Response(JSON.stringify({ message: "API rate limit exceeded", documentation_url: "https://emulate.dev/slack" }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120),
    },
  });

test("a rate-limited token is reported as a rate limit, with the limit and the reset", async () => {
  forgetSlackCaches();
  const error = await send("http://slack.test", "t", { channelName: "release", text: "x" }, {
    fetchImpl: async () => RATE_LIMITED(),
  }).then(() => null, (caught) => caught);

  assert.ok(error, "a rate-limited send resolved instead of throwing");
  assert.equal(error.code, "rate_limited");
  assert.match(error.message, /over its rate limit of 5000 requests an hour/);
  assert.match(error.message, /resets in \d+s/);
  assert.equal(typeof error.retry_after_seconds, "number");
  forgetSlackCaches();
});

test("a Slack-shaped refusal still reports Slack's own error name", async () => {
  forgetSlackCaches();
  const error = await send("http://slack.test", "t", { channelName: "release", text: "x" }, {
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "not_authed" }), { status: 200 }),
  }).then(() => null, (caught) => caught);

  assert.match(error.message, /Slack refused conversations\.list: not_authed/);
  forgetSlackCaches();
});

test("an unlabelled HTTP failure names the status rather than saying unknown", async () => {
  forgetSlackCaches();
  const error = await send("http://slack.test", "t", { channelName: "release", text: "x" }, {
    fetchImpl: async () => new Response("gateway", { status: 502 }),
  }).then(() => null, (caught) => caught);

  assert.match(error.message, /http_502|HTTP 502/);
  assert.equal(/unknown error/.test(error.message), false);
  forgetSlackCaches();
});

test("reused names, URLs, and tokens cannot reuse another generation's Slack identities", async () => {
  forgetSlackCaches();
  const sent = [];
  for (const generation of ["world-a", "world-b", "world-a-restored"]) {
    const fetchImpl = async (url, request) => {
      if (url.endsWith("conversations.list")) return Response.json({ ok: true, channels: [{ id: `channel-${generation}`, name: "shared" }] });
      if (url.endsWith("auth.test")) return Response.json({ ok: true, user_id: `person-${generation}` });
      const body = JSON.parse(request.body); sent.push(body.channel);
      return Response.json({ ok: true, ts: "1.0", channel: body.channel });
    };
    await send("http://same.test", "same-token", { channelName: "shared", text: generation }, { generation, fetchImpl });
    assert.equal((await identity("http://same.test", "same-token", { generation, fetchImpl })).user_id, `person-${generation}`);
  }
  assert.deepEqual(sent, ["channel-world-a", "channel-world-b", "channel-world-a-restored"]);
  forgetSlackCaches();
});
