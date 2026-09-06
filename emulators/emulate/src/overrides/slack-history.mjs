import { getSlackStore } from "@emulators/slack";

// `SlackSeedConfig` has no message field, and upstream `seedFromConfig` never
// writes the message store, so a seeded channel starts empty. The world's
// authored history is inserted here through the emulator's own public store,
// before the listener starts, which is the seed-time path the world artifact is
// meant to load through. After readiness every write goes through the Web API.
//
// Upstream also self-seeds `general` and `random` and then skips any channel
// whose name already exists, so a world that names `general` loses its own
// topic. Applying the declared topic is part of loading the projection.
export function seedSlackHistory(store, config) {
  if (!Array.isArray(config?.channels)) return { channels: 0, messages: 0, members: 0 };

  const ss = getSlackStore(store);
  const userIdByName = new Map(ss.users.all().map((user) => [user.name, user.user_id]));
  let channelCount = 0;
  let messageCount = 0;
  let memberCount = 0;

  for (const declared of config.channels) {
    const channel = ss.channels.findOneBy("name", declared.name);
    if (!channel) throw new Error(`Slack did not seed declared channel ${declared.name}`);

    // The channel may predate this seed, in which case it kept upstream's topic.
    const topic = declared.topic ?? "";
    // `update` keys on the collection's own numeric `id`, not the Slack id.
    if (topic && channel.topic?.value !== topic) {
      const updated = ss.channels.update(channel.id, {
        topic: { ...channel.topic, value: topic },
      });
      if (updated) channelCount += 1;
    }

    // Upstream seeds every user into every channel, so the world's own
    // membership is lost and `conversations.history` gates nothing. Restore it.
    if (Array.isArray(declared.members)) {
      const memberIds = declared.members.map(name => {
        const id = userIdByName.get(name);
        if (id === undefined) throw new Error(`Slack channel ${declared.name} has an unknown declared member ${name}`);
        return id;
      });
      ss.channels.update(channel.id, { members: memberIds, num_members: memberIds.length });
      memberCount += 1;
    }

    for (const message of declared.messages ?? []) {
      const user = userIdByName.get(message.user);
      // Refuse an unknown author before inserting the message.
      if (!user) throw new Error(`Slack message has an unknown declared author ${message.user}`);
      // Mirror the defaults the runtime insert path sets. `formatSlackMessage`
      // reads `reactions.length` unguarded, so a seeded message without them
      // makes every later `conversations.history` call fail with a 500.
      ss.messages.insert({
        ts: message.ts,
        channel_id: channel.channel_id,
        user,
        text: message.text,
        type: "message",
        reply_count: 0,
        reply_users: [],
        reactions: [],
      });
      messageCount += 1;
    }
  }

  return { channels: channelCount, messages: messageCount, members: memberCount };
}
