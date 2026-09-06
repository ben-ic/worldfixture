import { createProviders } from '../src/providers/index.mjs';

if (process.env.ACCOUNT_DESK_ISOLATED_PROVIDER_TEST !== '1') throw new Error('This test creates local provider records. Use an isolated test project and set ACCOUNT_DESK_ISOLATED_PROVIDER_TEST=1.');
const providers = createProviders(process.env);
let failed = 0;
const evidence = [];
async function check(workflow, operation, verify = () => {}) {
  try {
    const result = await operation();
    verify(result);
    evidence.push({ workflow, status: 'tested', passed: true, checkedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    failed++;
    evidence.push({ workflow, status: 'untested', passed: false, error: error.message, checkedAt: new Date().toISOString() });
    return null;
  }
}
const calendar = await check('calendar.read', () => providers.read('calendar'));
if (calendar?.calendars[0]) await check('calendar.event', () => providers.execute('calendar.event', { calendarId: calendar.calendars[0].id, summary: 'Account Desk isolated calendar verification', start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString() }));
const notion = await check('notion.read', () => providers.read('notion'));
const discovery = await check('notion-mcp.discovery', () => providers.read('notion-mcp'));
const actor = discovery?.users?.find(user => user.person?.email === process.env.SMTP_USERNAME) ?? discovery?.users?.find(user => user.type === 'person');
const connected = actor ? await check('notion-mcp.connect', () => providers.execute('notion-mcp.connect', { userId: actor.id })) : null;
if (connected) {
  await check('notion-mcp.tools-list', () => providers.read('notion-mcp'), result => { if (!result.connected || !result.tools.length) throw new Error('No authenticated MCP tool inventory.'); });
  if (notion?.pages[0]) await check('notion-mcp.page', () => providers.execute('notion-mcp.page', { parentPageId: notion.pages[0].id, title: 'Account Desk MCP verification note', text: 'This note was created through MCP and read through the official REST SDK.' }));
}
await check('notion-admin.read', () => providers.read('notion-admin'));
const agents = await check('notion-agent.read', () => providers.read('notion-agent'));
if (agents?.agents[0]) await check('notion-agent.session', () => providers.execute('notion-agent.session', { agentId: agents.agents[0].id, message: 'Summarize the local account review for verification.' }));
else evidence.push({ workflow: 'notion-agent.session', status: 'untested', passed: null, reason: 'This world has no visible Agent. No Agent was invented.' });
if (notion?.pages[0]) await check('notion.webhook-capture', () => providers.execute('notion.webhook-capture', { parentPageId: notion.pages[0].id, title: 'Account Desk signed capture verification' }));
await check('http.behavior', () => providers.read('http'), result => { if (result.checks.some(item => item.status !== 'passed')) throw new Error('At least one HTTP/RSS behavior is failed or unverified.'); });
evidence.push({ workflow: 'notion-workers.app-adapter', status: 'unsupported', passed: null, reason: 'The local Workers adapter has no public installed-package runtime interface. Account Desk does not import private repository code or invent a provider HTTP endpoint.' });
console.log(JSON.stringify({ apiVersion: 'account-desk.provider-evidence/v1', worldId: process.env.WORLDFIXTURE_WORLD_ID, worldVersion: process.env.WORLDFIXTURE_WORLD_VERSION, productionVerified: false, evidence }, null, 2));
process.exitCode = failed ? 1 : 0;
