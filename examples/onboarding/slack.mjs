import { WebClient } from "@slack/web-api";

const baseUrl = process.env.SLACK_BASE_URL;
const token = process.env.SLACK_TOKEN;
if (!baseUrl || !token) {
  throw new Error("Run this command through `npx worldfixture run --`, or load `npx worldfixture env` first.");
}

const client = new WebClient(token, { slackApiUrl: `${baseUrl.replace(/\/$/, "")}/api/` });
const listed = await client.conversations.list({ limit: 100, types: "public_channel,private_channel,mpim,im" });
const histories = await Promise.all((listed.channels ?? []).map(async (conversation) => ({
  conversation,
  history: await client.conversations.history({ channel: conversation.id, limit: 1 }),
})));
const selected = histories
  .filter((entry) => entry.conversation.id)
  .sort((left, right) => Number(right.history.messages?.[0]?.ts ?? 0) - Number(left.history.messages?.[0]?.ts ?? 0))[0];
if (!selected) throw new Error("Slack returned no visible conversation.");

const marker = process.env.WORLDFIXTURE_EXAMPLE_TEXT ?? `WorldFixture SDK example ${Date.now()}`;
const sent = await client.chat.postMessage({ channel: selected.conversation.id, text: marker });
const confirmed = await client.conversations.history({ channel: selected.conversation.id, limit: 20 });
if (!(confirmed.messages ?? []).some((message) => message.text === marker)) {
  throw new Error("Slack accepted the write, but the read-back did not contain it.");
}
console.log(JSON.stringify({ conversation: selected.conversation.name ?? selected.conversation.id, ts: sent.ts, text: marker }, null, 2));
