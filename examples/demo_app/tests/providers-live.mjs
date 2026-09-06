import { createProviders } from '../src/providers/index.mjs';

// Run only in an isolated test world through the public npx flow. This script
// does not reset or stop a world. Writes require a separate explicit opt-in.
const providers = createProviders(process.env);
const results = new Map();
let failed = 0;
const selected = providers.catalog().filter(item => item.selected);
for (let index = 0; index < selected.length; index += 3) {
  await Promise.all(selected.slice(index, index + 3).map(async service => {
    try {
      const data = await providers.read(service.id);
      if (data.checks?.some(check => check.status === 'failed')) throw new Error('A provider behavior check failed. Inspect HTTP/RSS expected and actual evidence.');
      results.set(service.id, data);
      console.log(JSON.stringify({ service: service.id, operation: 'read', status: 'passed', records: data.items.length, truncated: Boolean(data.truncated), ...(data.checks ? { checks: data.checks.map(check => ({ kind: check.kind || check.id, status: check.status })) } : {}) }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ service: service.id, operation: 'read', status: 'failed', error: error.message }));
    }
  }));
}
if (process.env.ACCOUNT_DESK_ALLOW_TEST_WRITES === '1') {
  const marker = `Account Desk verification ${new Date().toISOString()}`;
  const repository = results.get('github')?.repositories[0];
  const page = results.get('notion')?.pages[0];
  const calendar = results.get('calendar')?.calendars[0];
  const team = results.get('linear')?.teams[0];
  const customer = results.get('stripe')?.customers[0];
  const phone = results.get('twilio')?.numbers[0]?.phone_number;
  const incoming = results.get('gmail')?.messages.find(message => !message.labelIds?.includes('SENT') && message.threadId && message.headers?.['message-id']);
  const cases = [
    ['slack.send', { channel: results.get('slack')?.selected, text: marker }],
    ['github.issue', { owner: repository?.owner?.login, repo: repository?.name, title: marker, body: 'Local Account Desk verification. No production issue is created.' }],
    ['gmail.send', { to: process.env.IMAP_USERNAME, subject: marker, text: marker }],
    ['gmail.send', { to: incoming?.from?.match(/<([^>]+)>/)?.[1] || incoming?.from, subject: incoming ? `Re: ${incoming.subject.replace(/^(?:re:\s*)+/i, '')}` : undefined, text: marker, threadId: incoming?.threadId, inReplyTo: incoming?.headers?.['message-id'], references: `${incoming?.headers?.references || ''} ${incoming?.headers?.['message-id'] || ''}`.trim() }],
    ['notion.note', { pageId: page?.id, text: marker }],
    ['s3.put', { bucket: process.env.S3_BUCKET, key: `account-desk/${crypto.randomUUID()}.txt`, text: marker }],
    ['stripe.draft', { customer: customer?.id, description: marker }],
    ['calendar.event', { calendarId: calendar?.id, summary: marker, start: new Date(Date.now() + 3600000).toISOString(), end: new Date(Date.now() + 7200000).toISOString() }],
    ['drive.file', { name: `${marker}.txt`, text: marker }],
    ['linear.issue', { teamId: team?.id, title: marker, description: marker }],
    ['resend.send', { from: process.env.SMTP_USERNAME, to: process.env.IMAP_USERNAME, subject: marker, text: marker }],
    ['twilio.send', { from: phone, to: phone, text: marker }],
    ['mail.send', { subject: marker, text: marker }],
    ['notion-mcp.connect', { userId: results.get('notion-mcp')?.users?.find(user => user.type === 'person')?.id }],
  ];
  for (const [action, input] of cases) {
    try {
      const result = await providers.execute(action, input);
      console.log(JSON.stringify({ action, status: 'passed', readback: Boolean(result.readback) }));
    } catch (error) { failed++; console.log(JSON.stringify({ action, status: 'failed', error: error.message })); }
  }
}
process.exitCode = failed ? 1 : 0;
