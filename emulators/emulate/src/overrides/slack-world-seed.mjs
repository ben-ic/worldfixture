import { createHash } from 'node:crypto';
import { getSlackStore } from '@emulators/slack';

// The native config hook updates teams but does not create one. Create only the
// declared team before that hook; no sample users, channels, apps, or bots run.
export function seedSlackWorld(seedFromConfig, store, baseUrl, config, webhooks) {
  const team = config?.team;
  if (!team || typeof team.name !== 'string' || !team.name || typeof team.domain !== 'string' || !team.domain) {
    throw new Error('Slack requires an explicitly declared team name and domain');
  }
  const teamId = team.id ?? `T${createHash('sha256').update(team.domain).digest('hex').slice(0, 16).toUpperCase()}`;
  if (typeof teamId !== 'string' || !/^T[A-Z0-9]+$/.test(teamId)) throw new Error('Slack declared team ID is invalid');
  const teams = getSlackStore(store).teams;
  const existing = teams.all();
  if (existing.some(row => row.team_id !== teamId)) throw new Error('Slack contains an undeclared team before world seed');
  if (!existing.length) teams.insert({ team_id: teamId, name: team.name, domain: team.domain });
  const result = seedFromConfig(store, baseUrl, config, webhooks);
  // Native standalone bot seeds omit the user link needed to discover bots.info.
  // Add only declared bots, after channel membership has been seeded.
  const slack = getSlackStore(store);
  for (const declared of config.bots ?? []) {
    const bot = slack.bots.findOneBy('name', declared.name);
    if (!bot) throw new Error(`Slack declared bot ${JSON.stringify(declared.name)} was not seeded`);
    const existingUser = slack.users.findOneBy('name', declared.name);
    if (existingUser && (!existingUser.is_bot || existingUser.profile?.bot_id !== bot.bot_id)) {
      throw new Error(`Slack declared bot ${JSON.stringify(declared.name)} conflicts with another user`);
    }
    const user = existingUser ?? slack.users.insert({
      user_id: `U${createHash('sha256').update(`${teamId}/${declared.name}`).digest('hex').slice(0, 16).toUpperCase()}`,
      team_id: teamId, name: declared.name, real_name: declared.name,
      is_admin: false, is_bot: true, deleted: false,
      profile: { display_name: declared.name, real_name: declared.name, bot_id: bot.bot_id },
      presence: 'active', manual_presence: 'auto', connection_count: 1,
    });
    slack.bots.update(bot.id, { user_id: user.user_id });
  }
  return result;
}
