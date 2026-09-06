import { randomUUID } from 'node:crypto';

// These inputs come from fresh local provider reads, never the design exports.
// Planning is read-only. The caller must show every input before approval.
export async function buildWritePlan({ providers, actions, serviceIds, env = {}, world, now = Date.now() }) {
  const catalog = providers.catalog();
  const selected = serviceIds ?? catalog.filter(item => item.selected).map(item => item.id);
  if (!Array.isArray(selected) || !selected.length || selected.some(id => !catalog.some(item => item.id === id))) throw new Error('Select at least one known service.');
  const relevant = actions.filter(action => selected.includes(action.service));
  if (!relevant.length) throw new Error('No write checks are implemented for these services. Use read checks.');
  const data = {}, errors = {};
  const readServices = [...new Set(relevant.map(action => action.service))];
  if (relevant.some(action => action.id === 'notion-mcp.page') && !readServices.includes('notion')) readServices.push('notion');
  for (const service of readServices) {
    if (!catalog.find(item => item.id === service)?.selected) { errors[service] = 'This service is not selected in the running world.'; continue; }
    try { data[service] = await providers.read(service); }
    catch (error) { errors[service] = `Cannot prepare this check: ${error.message}`; }
  }
  const id = randomUUID();
  const marker = `Account Desk check ${id.slice(0, 8)}`;
  const repo = data.github?.repositories?.[0];
  const page = data.notion?.pages?.find(item => !item.archived && !item.in_trash);
  const calendar = data.calendar?.calendars?.[0];
  const team = data.linear?.teams?.[0];
  const customer = data.stripe?.customers?.[0];
  const phone = data.twilio?.numbers?.[0]?.phone_number;
  const conversation = [...(data.slack?.conversations || [])].sort((a, b) => Number(b.latest || 0) - Number(a.latest || 0))[0];
  const mailbox = data.gmail?.profile?.emailAddress || env.IMAP_USERNAME;
  const inputs = {
    'slack.send': { channel: conversation?.id, text: marker },
    'github.issue': { owner: repo?.owner?.login, repo: repo?.name, title: marker, body: 'Approved local verification. This issue is test data.' },
    'gmail.send': { to: mailbox, subject: marker, text: marker },
    'notion.note': { pageId: page?.id, text: marker },
    's3.put': { bucket: env.S3_BUCKET, key: `account-desk/verification/${id}.txt`, text: marker },
    'stripe.draft': { customer: customer?.id, description: marker },
    'calendar.event': { calendarId: calendar?.id, summary: marker, start: new Date(now + 3600000).toISOString(), end: new Date(now + 7200000).toISOString() },
    'drive.file': { name: `${marker}.txt`, text: marker },
    'linear.issue': { teamId: team?.id, title: marker, description: marker },
    'resend.send': { from: env.SMTP_USERNAME, to: env.IMAP_USERNAME, subject: marker, text: marker },
    'twilio.send': { from: phone, to: phone, text: marker },
    'mail.send': { subject: marker, text: marker },
    'notion-mcp.connect': { userId: data['notion-mcp']?.users?.find(user => user.type === 'person')?.id || data['notion-mcp']?.currentUserId },
    'notion-mcp.page': { parentPageId: page?.id, title: marker, text: marker },
    'notion-agent.session': { agentId: data['notion-agent']?.agents?.[0]?.id, message: marker },
    'notion.webhook-capture': { parentPageId: page?.id, title: marker },
  };
  const steps = relevant.map((action, index) => {
    const input = Object.fromEntries(Object.entries(inputs[action.id] || {}).filter(([, value]) => value !== undefined));
    const missing = (action.fields || []).filter(field => field.required !== false && !String(input[field.name] ?? '').trim()).map(field => field.label || field.name);
    const reason = errors[action.service] || (!inputs[action.id] ? 'This action has no automatic verification input plan.' : missing.length ? `Missing prerequisites: ${missing.join(', ')}.` : null);
    return { id: `${id}-${index}`, service: action.service, action: action.id, kind: action.kind || 'provider-api', name: action.name || action.label, input, ready: !reason, reason };
  });
  return { id, world, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60000).toISOString(), scope: 'Approved local provider writes and fresh readbacks. Test records remain until world reset. This is not production parity.', steps,
    notes: ['No write has run yet. Approval runs only these inputs.', 'Each action saves separately. A failed action does not undo earlier changes.', 'Checks continue on other services after a failure. No failed write is retried.', 'Services without an implemented write check are not covered by this plan.', ...(relevant.some(action => action.kind === 'local-verification') ? ['Notion webhook capture uses Workbench-only subscription setup. It is a local capture test, not a public subscription API or external delivery.'] : [])],
    readOnlyServices: selected.filter(service => !relevant.some(action => action.service === service)) };
}
