import { localUrl, localFetch, hostPort, required, headerValue, pages, assertReadback, boundedOperation, checkBudget, serializableData } from './safety.mjs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { inspectHttpTargets } from './http-targets.mjs';
import { createSecondarySdk } from './secondary-sdks.mjs';
import { createGoogleTransport, createDetailCache } from './read-control.mjs';

const field = (name, label, type = 'text', needed = true) => ({ name, label, type, required: needed });
export const ACTIONS = [
  { id: 'slack.send', name: 'Send Slack message', service: 'slack', fields: [field('channel', 'Conversation ID'), field('text', 'Message', 'textarea')] },
  { id: 'github.issue', name: 'Create GitHub issue', service: 'github', fields: [field('owner', 'Repository owner'), field('repo', 'Repository'), field('title', 'Issue title'), field('body', 'Issue description', 'textarea')] },
  { id: 'gmail.send', name: 'Send Gmail message', service: 'gmail', fields: [field('to', 'Recipient email'), field('subject', 'Subject'), field('text', 'Message', 'textarea'), field('threadId', 'Existing thread ID (reply only)', 'text', false), field('inReplyTo', 'Original Message-ID (reply only)', 'text', false), field('references', 'References header (reply only)', 'text', false)] },
  { id: 'notion.note', name: 'Append Notion note', service: 'notion', fields: [field('pageId', 'Page ID'), field('text', 'Note', 'textarea')] },
  { id: 's3.put', name: 'Save S3 object', service: 's3', fields: [field('bucket', 'Bucket'), field('key', 'Object key'), field('text', 'Content', 'textarea')] },
  { id: 'stripe.draft', name: 'Create draft invoice', service: 'stripe', fields: [field('customer', 'Customer ID'), field('description', 'Description', 'textarea')] },
  { id: 'calendar.event', name: 'Create follow-up event', service: 'calendar', fields: [field('calendarId', 'Calendar ID'), field('summary', 'Summary'), field('start', 'Start (ISO date and time)'), field('end', 'End (ISO date and time)')] },
  { id: 'drive.file', name: 'Create Drive document', service: 'drive', fields: [field('name', 'File name'), field('text', 'Content', 'textarea')] },
  { id: 'linear.issue', name: 'Create Linear issue', service: 'linear', fields: [field('teamId', 'Team ID'), field('title', 'Issue title'), field('description', 'Description', 'textarea')] },
  { id: 'resend.send', name: 'Send local Resend email', service: 'resend', fields: [field('from', 'Sender email'), field('to', 'Recipient email'), field('subject', 'Subject'), field('text', 'Message', 'textarea')] },
  { id: 'twilio.send', name: 'Create local SMS', service: 'twilio', fields: [field('from', 'Sender number'), field('to', 'Recipient number'), field('text', 'Message', 'textarea')] },
  { id: 'mail.send', name: 'Send Local Mail to this inbox', service: 'mail', fields: [field('subject', 'Subject'), field('text', 'Message', 'textarea')] },
  { id: 'notion-mcp.connect', name: 'Authorize local Notion MCP test client', service: 'notion-mcp', fields: [field('userId', 'Notion user ID for local consent')] },
  { id: 'notion-mcp.page', name: 'Create account note through Notion MCP', service: 'notion-mcp', fields: [field('parentPageId', 'Parent page ID'), field('title', 'Page title'), field('text', 'Note content', 'textarea')] },
  { id: 'notion-agent.session', name: 'Run local Notion Agent session', service: 'notion-agent', fields: [field('agentId', 'Agent ID'), field('message', 'Session message', 'textarea')] },
  { id: 'notion.webhook-capture', name: 'Verify local Notion webhook capture', service: 'notion', kind: 'local-verification', fields: [field('parentPageId', 'Parent for a new verification page'), field('title', 'Verification page title')] },
];
for (const action of ACTIONS) action.label = action.name;

// Works names only the operations this adapter makes available. The UI must not
// treat route existence or a successful read as a full provider contract test.
const DEFINITIONS = [
  ['slack', 'Slack', 'SLACK', 'Conversations, people, history; send and read back', 'No Socket Mode; broad SDK parity is not proved', '@slack/web-api'],
  ['github', 'GitHub', 'GITHUB', 'Repositories, issues; create and read back an issue', 'No production Actions execution or full API parity', '@octokit/rest'],
  ['gmail', 'Gmail', 'GOOGLE', 'Messages; send and read back a message', 'No remote delivery guarantee', 'googleapis'],
  ['calendar', 'Google Calendar', 'GOOGLE', 'Calendars and events; create and read back an event', 'No production meeting notification guarantee', 'googleapis'],
  ['drive', 'Google Drive', 'GOOGLE', 'File metadata; create and read back a text file', 'Docs and Sheets APIs are not supported', 'googleapis'],
  ['notion', 'Notion', 'NOTION', 'Pages and blocks; append and read back a note', 'External webhooks and hosted Workers are not supported', '@notionhq/client'],
  ['notion-mcp', 'Notion MCP', 'NOTION', 'Public discovery; explicit local OAuth with PKCE; tool inventory and page creation with REST readback', 'Hosted result parity is not proved; each write needs explicit approval', 'HTTP JSON-RPC / OAuth'],
  ['notion-admin', 'Notion Admin', 'NOTION_ADMIN', 'Legal-hold inventory with separate organization token', 'App administration writes and other Admin workflows are not implemented', 'HTTP'],
  ['notion-agent', 'Notion Agents', 'NOTION', 'Agent/session inventory; local session creation and event readback through official SDK', 'Responses are local deterministic results, not external AI; hosted Workers app check is not implemented', '@notionhq/client'],
  ['stripe', 'Stripe', 'STRIPE', 'Customers, invoices, subscriptions; create draft invoice', 'Refunds, taxes, disputes and real charges are not supported', 'stripe'],
  ['linear', 'Linear', 'LINEAR', 'Issue/team GraphQL reads; create and read back an issue', 'Generated SDK model queries request unsupported fields; explicit GraphQL fields are tested', '@linear/sdk (explicit GraphQL)'],
  ['resend', 'Resend', 'RESEND', 'Email reads; local send and read back', 'No production delivery or current global Contacts API', 'resend'],
  ['twilio', 'Twilio', 'TWILIO', 'Messages/numbers; create and read back local SMS', 'No carrier delivery; only named Messaging SDK calls are tested', 'twilio'],
  ['clerk', 'Clerk', 'CLERK', 'User and organization reads', 'App writes, official SDK and webhooks are not tested', 'HTTP'],
  ['okta', 'Okta', 'OKTA', 'User and group reads', 'SSWS and official SDK are not tested', 'HTTP'],
  ['microsoft', 'Microsoft', 'MICROSOFT', 'Current-user Graph read; local sign-in in Connections', 'Graph list/write APIs are not supported; production consent enforcement is not proved', 'HTTP'],
  ['apple', 'Apple', 'APPLE', 'Local OIDC discovery and JWKS read; local sign-in in Connections', 'Local client-secret and redirect checks differ from production; no other Apple product APIs', 'HTTP'],
  ['vercel', 'Vercel', 'VERCEL', 'Project and deployment reads', 'No actual builds or deployments; app writes/SDK not tested', 'HTTP'],
  ['mongoatlas', 'MongoDB Atlas', 'MONGOATLAS', 'Admin project and cluster reads', 'Not a MongoDB wire database; retired Data API is not used', 'HTTP'],
  ['s3', 'S3', 'S3', 'Generated bucket object list; put and read back bytes', 'No bucket discovery or notifications', '@aws-sdk/client-s3'],
  ['mail', 'Local Mail', 'MAIL', 'IMAP inbox; SMTP delivery and IMAP readback', 'No TLS, SMTP AUTH or network relay', 'imapflow / nodemailer'],
  ['http', 'HTTP targets', 'SITE', 'Discover local page/feed/probe links and measure status', 'GET/HEAD only; one host, not multiple sites', 'HTTP'],
];

const rows = (items, title, subtitle = () => '') => items.map(item => ({ ...item, id: String(item.id ?? item.sid ?? item.Key ?? item.name ?? ''), title: title(item), subtitle: subtitle(item) }));
const richText = values => (values ?? []).map(value => value.plain_text ?? value.text?.content ?? '').join('');
const pageTitle = page => richText(Object.values(page.properties ?? {}).find(p => p.type === 'title')?.title) || 'Untitled page';
const array = value => Array.isArray(value) ? value : value?.data ?? value?.results ?? [];
function providerError(error) {
  // Gaxios preserves the transport error as cause but drops custom retryAt.
  // Return that small safe error, not its wrapper with request credentials.
  if (error?.cause?.code === 'PROVIDER_RATE_LIMIT') return error.cause;
  return error;
}
function plainMailBody(payload) {
  if (payload?.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  return (payload?.parts ?? []).map(plainMailBody).filter(Boolean).join('\n');
}

export function createProviders(env) {
  const clients = new Map();
  const secondary = createSecondarySdk(env);
  const gmailDetails = createDetailCache();
  const activeReads = new Map();
  let googleTransport;
  let mcpGrant;
  const base = id => {
    const def = DEFINITIONS.find(item => item[0] === id);
    if (!def) throw new Error(`Unknown service: ${id}`);
    const value = env[`${def[2]}_BASE_URL`];
    if (!value) throw new Error(`${def[1]} is not selected. Start the world and use npx worldfixture run -- npm run dev.`);
    return localUrl(value).href.replace(/\/$/, '');
  };
  const token = id => {
    const prefix = DEFINITIONS.find(item => item[0] === id)[2];
    return env[`${prefix}_TOKEN`] ?? '';
  };
  async function request(id, path, { method = 'GET', body, form, headers = {} } = {}) {
    const root = base(id);
    const response = await localFetch(root)(`${root}${path}`, {
      method, headers: { Authorization: `Bearer ${token(id)}`, ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${id} ${method} ${path.split('?')[0]} returned HTTP ${response.status}.`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error(`${id} did not return JSON.`); }
  }
  async function client(id) {
    if (clients.has(id)) return clients.get(id);
    const root = base(id);
    let value;
    if (id === 'slack') {
      const { WebClient } = await import('@slack/web-api');
      value = new WebClient(token(id), { slackApiUrl: `${root}/api/`, timeout: 15000, allowAbsoluteUrls: false, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true });
    } else if (id === 'github') {
      const { Octokit } = await import('@octokit/rest');
      value = new Octokit({ auth: token(id), baseUrl: root, request: { fetch: localFetch(root), timeout: 15000 } });
    } else if (['gmail', 'calendar', 'drive'].includes(id)) {
      const { google } = await import('googleapis');
      googleTransport ??= createGoogleTransport(root);
      const options = { rootUrl: `${root}/`, headers: { Authorization: `Bearer ${token(id)}` }, fetchImplementation: googleTransport, timeout: 15000, retry: false, maxRedirects: 0 };
      value = google[id]({ ...options, version: id === 'gmail' ? 'v1' : 'v3' });
    } else if (id === 'notion') {
      const { Client } = await import('@notionhq/client');
      value = new Client({ auth: token(id), baseUrl: root, notionVersion: '2026-03-11', fetch: localFetch(root), timeoutMs: 15000, retry: false });
    } else if (id === 'stripe') {
      const { default: Stripe } = await import('stripe');
      const url = new URL(root);
      value = new Stripe(token(id), { host: url.hostname, port: Number(url.port), protocol: url.protocol.slice(0, -1), apiVersion: '2026-08-26.dahlia', timeout: 15000, maxNetworkRetries: 0, httpClient: Stripe.createFetchHttpClient(localFetch(root)) });
    } else if (id === 's3') {
      const { S3Client } = await import('@aws-sdk/client-s3');
      value = new S3Client({ endpoint: root, region: env.S3_REGION || 'us-east-1', forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: env.S3_ACCESS_KEY_ID || 'local', secretAccessKey: env.S3_SECRET_ACCESS_KEY || 'local' }, requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 } });
    }
    if (!value) throw new Error(`No SDK adapter for ${id}.`);
    clients.set(id, value);
    return value;
  }
  async function googlePages(load, key) {
    return pages(async pageToken => (await load({ pageToken })).data, value => value[key] ?? [], value => value.nextPageToken);
  }
  async function mailClient(callback) {
    const { ImapFlow } = await import('imapflow');
    const imap = new ImapFlow({ ...hostPort(env.IMAP_HOST_PORT), secure: false, doSTARTTLS: false, auth: { user: env.IMAP_USERNAME, pass: env.IMAP_PASSWORD }, logger: false, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    await imap.connect();
    try { return await callback(imap); } finally { await imap.logout(); }
  }
  async function read(id, options = {}) {
    if (['linear', 'resend', 'twilio'].includes(id)) return secondary.read(id);
    if (id === 'notion-mcp') {
      const discovery = await request(id, '/.well-known/oauth-protected-resource/mcp');
      const authorization = await request(id, '/.well-known/oauth-authorization-server');
      if (!mcpGrant) {
        const sdk = await client('notion');
        const users = await pages(start_cursor => sdk.users.list({ page_size: 100, start_cursor }), value => value.results, value => value.has_more ? value.next_cursor : undefined);
        return { items: rows(users, item => item.name || item.id), users, discovery, authorization, connected: false, note: 'Select a local Notion user and approve Authorize local Notion MCP test client. Discovery does not create an OAuth grant.' };
      }
      const headers = { Authorization: `Bearer ${mcpGrant.accessToken}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' };
      const initialized = await request(id, '/mcp', { method: 'POST', headers, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Account Desk', version: '0.1.0' } } } });
      if (initialized.result?.protocolVersion !== '2025-11-25') throw new Error('Notion MCP did not confirm the expected protocol version.');
      await request(id, '/mcp', { method: 'POST', headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
      const listed = await request(id, '/mcp', { method: 'POST', headers, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
      if (listed.error || !Array.isArray(listed.result?.tools)) throw new Error('Notion MCP tool inventory failed. Reconnect after world reset.');
      return { items: rows(listed.result.tools, item => item.name, item => item.description || ''), tools: listed.result.tools, discovery, connected: true, currentUserId: mcpGrant.userId, workspaceId: mcpGrant.workspaceId, protocolVersion: initialized.result.protocolVersion };
    }
    if (id === 'notion-admin') {
      const legalHolds = await pages(cursor => request(id, `/admin/v1/legal_holds?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { 'Notion-Version': '2026-06-01' } }), value => value.results ?? [], value => value.has_more ? value.next_cursor : undefined);
      return { items: rows(legalHolds, item => item.name || item.id), legalHolds, note: 'This is the public Admin legal-hold inventory, not private Workbench administration.' };
    }
    if (id === 'notion-agent') {
      const sdk = await client('notion');
      const [agents, sessions] = await Promise.all([
        pages(start_cursor => sdk.agents.query({ page_size: 100, start_cursor }), value => value.results ?? [], value => value.has_more ? value.next_cursor : undefined),
        pages(start_cursor => sdk.sessions.query({ page_size: 100, start_cursor }), value => value.results ?? [], value => value.has_more ? value.next_cursor : undefined),
      ]);
      return { items: rows(agents, item => item.name || item.id, item => item.status || ''), agents, sessions };
    }
    if (id === 'slack') {
      const sdk = await client(id);
      const [users, channels] = await Promise.all([
        pages(cursor => sdk.users.list({ limit: 100, cursor }), value => value.members ?? [], value => value.response_metadata?.next_cursor),
        pages(cursor => sdk.conversations.list({ limit: 100, cursor, types: 'public_channel,private_channel,mpim,im' }), value => value.channels ?? [], value => value.response_metadata?.next_cursor),
      ]);
      const names = new Map(users.map(user => [user.id, user.real_name || user.profile?.display_name || user.name || user.id]));
      const conversations = [];
      for (const channel of channels) {
        checkBudget();
        const history = await sdk.conversations.history({ channel: channel.id, limit: 30 });
        conversations.push({ ...channel, name: channel.name || names.get(channel.user) || 'Direct conversation', latest: Number(history.messages?.[0]?.ts || 0), messages: (history.messages ?? []).map(message => ({ ...message, author: names.get(message.user) || message.username || 'Unknown author' })) });
      }
      conversations.sort((a, b) => b.latest - a.latest);
      return { items: rows(conversations, item => item.name, item => item.messages[0]?.text || 'No messages'), conversations, users, selected: conversations[0]?.id, historyLimit: 30, note: 'Latest message is compared across all visible conversations. Each history contains at most 30 messages. The entire read has a 45-second limit.' };
    }
    if (id === 'github') {
      const sdk = await client(id);
      const repositories = await pages(async page => ({ data: (await sdk.repos.listForAuthenticatedUser({ per_page: 100, page: page || 1 })).data, page: page || 1 }), value => value.data, value => value.data.length === 100 ? value.page + 1 : undefined, 10);
      if (!repositories.length) {
        const visible = await pages(async page => ({ ...(await sdk.search.repos({ q: 'size:>=0', per_page: 100, page: page || 1 })).data, page: page || 1 }), value => value.items ?? [], value => value.items?.length === 100 && value.page * 100 < value.total_count ? value.page + 1 : undefined, 10);
        repositories.push(...visible);
      }
      const issues = [];
      for (const repository of repositories.slice(0, 30)) {
        checkBudget();
        const found = [];
        for (let page = 1; page <= 10; page++) {
          checkBudget();
          const response = await sdk.issues.listForRepo({ owner: repository.owner.login, repo: repository.name, state: 'all', per_page: 100, page });
          found.push(...response.data);
          if (response.data.length < 100) break;
          if (page === 10) throw new Error('GitHub issue read exceeded 1000 records. Narrow the query.');
        }
        issues.push(...found.filter(item => !item.pull_request).map(item => ({ ...item, owner: repository.owner.login, repo: repository.name })));
      }
      return { items: rows(issues, item => item.title, item => `${item.owner}/${item.repo} #${item.number} · ${item.state}`), repositories, issues, truncated: repositories.length > 30, note: 'Issues are read from at most 30 repositories.' };
    }
    if (id === 'gmail') {
      const sdk = await client(id);
      const refs = await googlePages(options => sdk.users.messages.list({ userId: 'me', maxResults: 100, ...options }), 'messages');
      const messages = [];
      for (const ref of refs.slice(0, 100)) {
        checkBudget();
        const detail = await gmailDetails(ref.id, async () => (await sdk.users.messages.get({ userId: 'me', id: ref.id, format: 'full' })).data, { allowCached: options.purpose === 'poll' });
        const { data } = detail;
        const headers = Object.fromEntries((data.payload?.headers ?? []).map(header => [header.name.toLowerCase(), header.value]));
        const fullText = plainMailBody(data.payload);
        messages.push({ ...data, headers, subject: headers.subject || '(No subject)', from: headers.from, to: headers.to, body: fullText || data.snippet || '', bodyIsExcerpt: !fullText, detailReadAt: new Date(detail.readAt).toISOString(), detailCached: detail.cached });
      }
      return { items: rows(messages, item => item.subject, item => item.from || ''), messages, truncated: refs.length > 100, totalMessages: refs.length, note: `Detailed reads are limited to the first 100 messages.${options.purpose === 'poll' ? ' The message list is fresh. Existing message details can be cached for up to 5 minutes; new IDs are fetched immediately. Verification and write readbacks do not use this cache.' : ''}` };
    }
    if (id === 'calendar') {
      const sdk = await client(id);
      const calendars = await googlePages(options => sdk.calendarList.list({ maxResults: 100, ...options }), 'items');
      const events = [];
      for (const calendar of calendars) { checkBudget(); events.push(...(await googlePages(options => sdk.events.list({ calendarId: calendar.id, maxResults: 100, ...options }), 'items')).map(event => ({ ...event, calendarId: calendar.id }))); }
      return { items: rows(events, item => item.summary || 'Untitled event', item => item.start?.dateTime || item.start?.date || ''), calendars, events };
    }
    if (id === 'drive') {
      const sdk = await client(id);
      const files = await googlePages(options => sdk.files.list({ pageSize: 100, fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)', ...options }), 'files');
      return { items: rows(files, item => item.name, item => item.mimeType || ''), files };
    }
    if (id === 'notion') {
      const sdk = await client(id);
      const found = await pages(start_cursor => sdk.search({ page_size: 100, start_cursor, sort: { direction: 'descending', timestamp: 'last_edited_time' } }), value => value.results ?? [], value => value.has_more ? value.next_cursor : undefined);
      const pageList = found.filter(item => item.object === 'page');
      return { items: rows(pageList, pageTitle, item => item.last_edited_time), pages: pageList };
    }
    if (id === 'stripe') {
      const sdk = await client(id);
      const list = load => pages(starting_after => load({ limit: 100, ...(starting_after ? { starting_after } : {}) }), value => value.data, value => value.has_more ? value.data.at(-1)?.id : undefined);
      const [customers, invoices, subscriptions] = await Promise.all([list(options => sdk.customers.list(options)), list(options => sdk.invoices.list(options)), list(options => sdk.subscriptions.list(options))]);
      return { items: rows(customers, item => item.name || item.email || item.id, item => item.email || ''), customers, invoices, subscriptions };
    }
    if (id === 'clerk') {
      const [users, organizations] = await Promise.all([request(id, '/v1/users'), request(id, '/v1/organizations')]);
      return { items: rows(array(users), item => `${item.first_name || ''} ${item.last_name || ''}`.trim() || item.id), users: array(users), organizations: array(organizations) };
    }
    if (id === 'okta') {
      const [users, groups] = await Promise.all([request(id, '/api/v1/users'), request(id, '/api/v1/groups')]);
      return { items: rows(array(users), item => `${item.profile?.firstName || ''} ${item.profile?.lastName || ''}`.trim() || item.id, item => item.profile?.email || ''), users: array(users), groups: array(groups) };
    }
    if (id === 'microsoft') { const user = await request(id, '/v1.0/me'); return { items: rows([user], item => item.displayName, item => item.mail), user }; }
    if (id === 'apple') {
      const discovery = await request(id, '/.well-known/openid-configuration');
      const keys = await request(id, '/auth/keys');
      return { items: [{ id: 'discovery', title: 'Local sign-in discovery', subtitle: discovery.issuer }], discovery, keys };
    }
    if (id === 'vercel') {
      const [projects, deployments] = await Promise.all([request(id, '/v10/projects'), request(id, '/v6/deployments')]);
      return { items: rows(projects.projects ?? [], item => item.name), projects: projects.projects ?? [], deployments: deployments.deployments ?? [] };
    }
    if (id === 'mongoatlas') {
      const response = await request(id, '/api/atlas/v2/groups');
      const projects = response.results ?? [];
      const clusters = [];
      for (const project of projects) { checkBudget(); clusters.push(...((await request(id, `/api/atlas/v2/groups/${encodeURIComponent(project.id)}/clusters`)).results ?? []).map(item => ({ ...item, projectId: project.id }))); }
      return { items: rows(projects, item => item.name), projects, clusters };
    }
    if (id === 's3') {
      const sdk = await client(id);
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const bucket = required(env, 'S3_BUCKET');
      const objects = await pages(ContinuationToken => sdk.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken })), value => value.Contents ?? [], value => value.IsTruncated ? value.NextContinuationToken : undefined);
      return { items: rows(objects, item => item.Key, item => `${item.Size} bytes`), bucket, objects };
    }
    if (id === 'mail') return mailClient(async imap => {
      const mailbox = await imap.mailboxOpen('INBOX');
      const messages = [];
      if (mailbox.exists) for await (const message of imap.fetch(`${Math.max(1, mailbox.exists - 99)}:${mailbox.exists}`, { uid: true, envelope: true })) { checkBudget(); messages.push({ id: String(message.uid), ...message, title: message.envelope?.subject || '(No subject)', subtitle: message.envelope?.from?.map(item => item.address).join(', ') || '' }); }
      return { items: messages, messages, mailbox: env.IMAP_USERNAME, truncated: mailbox.exists > 100, note: 'The most recent 100 inbox messages are shown.' };
    });
    if (id === 'http') {
      return inspectHttpTargets(base(id));
    }
    throw new Error(`Unknown service: ${id}`);
  }

  async function execute(action, input = {}) {
    const definition = ACTIONS.find(item => item.id === action);
    if (!definition) throw new Error('This action is not supported.');
    for (const item of definition.fields) if (item.required) required(input, item.name);
    if (['linear.issue', 'resend.send', 'twilio.send'].includes(action)) return secondary.execute(action, input);
    let record, readback, operation = action;
    if (action === 'slack.send') {
      const sdk = await client('slack');
      record = await sdk.chat.postMessage({ channel: required(input, 'channel', 100), text: required(input, 'text') });
      // A world's authored history can be later than the provider's current
      // clock. Bound both ends so newer seeded messages cannot hide this write.
      const matches = item => item.ts === record.ts && item.text === input.text.trim();
      const messages = await pages(
        cursor => sdk.conversations.history({ channel: record.channel, oldest: record.ts, latest: record.ts, inclusive: true, limit: 100, cursor }),
        value => value.messages ?? [],
        // The current emulator ignores timestamp bounds. Follow its real
        // pagination until the exact record is found; never repeat the write.
        value => value.messages?.some(matches) ? undefined : value.response_metadata?.next_cursor,
      );
      readback = { messages };
      assertReadback(readback.messages?.some(item => item.ts === record.ts && item.text === input.text.trim()), action);
    } else if (action === 'github.issue') {
      const sdk = await client('github');
      const owner = required(input, 'owner', 100), repo = required(input, 'repo', 100);
      record = (await sdk.issues.create({ owner, repo, title: required(input, 'title', 256), body: required(input, 'body') })).data;
      readback = (await sdk.issues.get({ owner, repo, issue_number: record.number })).data;
      assertReadback(readback.id === record.id && readback.title === input.title.trim(), action);
    } else if (action === 'gmail.send') {
      const sdk = await client('gmail');
      const to = headerValue(input, 'to'), subject = headerValue(input, 'subject');
      let replyHeaders = '', threadId;
      if (input.threadId || input.inReplyTo || input.references) {
        threadId = required(input, 'threadId', 200);
        const inReplyTo = headerValue(input, 'inReplyTo'), references = headerValue(input, 'references');
        const { data: thread } = await sdk.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
        const source = thread.messages?.find(message => message.payload?.headers?.some(header => header.name.toLowerCase() === 'message-id' && header.value === inReplyTo));
        const sourceSubject = source?.payload?.headers?.find(header => header.name.toLowerCase() === 'subject')?.value;
        const normalizedSubject = value => value?.replace(/^(?:re:\s*)+/i, '').trim();
        if (!source || !references.split(/\s+/).includes(inReplyTo) || normalizedSubject(sourceSubject) !== normalizedSubject(subject)) throw new Error('Reply fields must name a message in the selected thread, include its Message-ID in References, and keep the original subject.');
        replyHeaders = `In-Reply-To: ${inReplyTo}\r\nReferences: ${references}\r\n`;
      }
      const raw = Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\n${replyHeaders}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${required(input, 'text')}`).toString('base64url');
      record = (await sdk.users.messages.send({ userId: 'me', requestBody: { raw, ...(threadId ? { threadId } : {}) } })).data;
      readback = (await sdk.users.messages.get({ userId: 'me', id: record.id, format: 'full' })).data;
      assertReadback(readback.id === record.id && readback.labelIds?.includes('SENT'), action);
      if (threadId) {
        const confirmedThread = (await sdk.users.threads.get({ userId: 'me', id: threadId, format: 'full' })).data;
        assertReadback(readback.threadId === threadId && confirmedThread.messages?.some(message => message.id === record.id), action);
        readback = { ...readback, threadConfirmed: true };
      }
    } else if (action === 'notion.note') {
      const sdk = await client('notion');
      const block_id = required(input, 'pageId', 100), text = required(input, 'text', 2000);
      record = await sdk.blocks.children.append({ block_id, children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }] });
      const blocks = await pages(start_cursor => sdk.blocks.children.list({ block_id, page_size: 100, start_cursor }), value => value.results, value => value.has_more ? value.next_cursor : undefined);
      readback = blocks.filter(item => record.results.some(created => created.id === item.id));
      assertReadback(readback.length === record.results.length && readback.some(item => richText(item.paragraph?.rich_text) === text), action);
    } else if (action === 's3.put') {
      const sdk = await client('s3');
      const { PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const Bucket = required(input, 'bucket', 100), Key = required(input, 'key', 1000), Body = required(input, 'text');
      // Only the generated bucket is in this application's scope.
      if (Bucket !== env.S3_BUCKET) throw new Error('Use the generated S3_BUCKET value.');
      record = await sdk.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'text/plain; charset=utf-8' }));
      const found = await sdk.send(new GetObjectCommand({ Bucket, Key }));
      readback = { bucket: Bucket, key: Key, text: await found.Body.transformToString(), etag: found.ETag };
      assertReadback(readback.text === Body, action);
      record = { bucket: Bucket, key: Key, etag: record.ETag };
    } else if (action === 'stripe.draft') {
      const sdk = await client('stripe');
      record = await sdk.invoices.create({ customer: required(input, 'customer', 100), description: required(input, 'description'), auto_advance: false, collection_method: 'send_invoice', days_until_due: 30 });
      readback = await sdk.invoices.retrieve(record.id);
      assertReadback(readback.id === record.id && readback.status === 'draft', action);
    } else if (action === 'calendar.event') {
      const sdk = await client('calendar');
      const calendarId = required(input, 'calendarId', 200);
      if (!Number.isFinite(Date.parse(input.start)) || !Number.isFinite(Date.parse(input.end)) || Date.parse(input.end) <= Date.parse(input.start)) throw new Error('Use a valid start and a later end date/time.');
      record = (await sdk.events.insert({ calendarId, requestBody: { summary: required(input, 'summary'), start: { dateTime: new Date(input.start).toISOString() }, end: { dateTime: new Date(input.end).toISOString() } } })).data;
      // The emulator supports list, not the production single-event GET route.
      readback = (await googlePages(options => sdk.events.list({ calendarId, ...options }), 'items')).find(item => item.id === record.id);
      assertReadback(readback?.summary === input.summary.trim(), action);
    } else if (action === 'drive.file') {
      const sdk = await client('drive');
      record = (await sdk.files.create({ requestBody: { name: required(input, 'name', 300) }, media: { mimeType: 'text/plain', body: required(input, 'text') }, fields: 'id,name,mimeType' }, { rootUrl: `${base('drive')}/` })).data;
      readback = (await sdk.files.get({ fileId: record.id, fields: 'id,name,mimeType' })).data;
      assertReadback(readback.id === record.id && readback.name === input.name.trim(), action);
    } else if (action === 'mail.send') {
      const { default: nodemailer } = await import('nodemailer');
      const smtp = nodemailer.createTransport({ ...hostPort(env.SMTP_HOST_PORT), secure: false, ignoreTLS: true, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
      const messageId = `<account-desk-${crypto.randomUUID()}@local.test>`;
      record = await smtp.sendMail({ from: env.SMTP_USERNAME, to: env.IMAP_USERNAME, subject: headerValue(input, 'subject'), text: required(input, 'text'), messageId });
      readback = await mailClient(async imap => {
        await imap.mailboxOpen('INBOX');
        const uids = await imap.search({ header: { 'Message-ID': messageId } }, { uid: true });
        return { messageId, uids };
      });
      assertReadback(readback.uids?.length > 0, action);
    } else if (action === 'notion-mcp.connect') {
      const root = base('notion-mcp');
      const callback = `${root}/account-desk-local-oauth-callback`;
      const registered = await request('notion-mcp', '/register', { method: 'POST', body: { client_name: 'Account Desk local verification', redirect_uris: [callback], token_endpoint_auth_method: 'none' } });
      const verifier = randomBytes(48).toString('base64url'), state = randomBytes(24).toString('base64url');
      const params = { client_id: registered.client_id, redirect_uri: callback, response_type: 'code', resource: `${root}/mcp`, scope: 'default', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
      const consent = await localFetch(root)(`${root}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, user_id: required(input, 'userId', 100), decision: 'approve' }) });
      if (consent.status !== 302) throw new Error('Notion local OAuth consent was not accepted.');
      const redirect = localUrl(consent.headers.get('location'));
      if (`${redirect.origin}${redirect.pathname}` !== callback || redirect.searchParams.get('state') !== state || !redirect.searchParams.get('code')) throw new Error('Notion OAuth callback did not match the local client and state.');
      const granted = await request('notion-mcp', '/token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: registered.client_id, redirect_uri: callback, code: redirect.searchParams.get('code'), code_verifier: verifier, resource: `${root}/mcp` } });
      if (!granted.access_token) throw new Error('Notion OAuth did not return an access token.');
      mcpGrant = { accessToken: granted.access_token, workspaceId: granted.workspace_id, userId: input.userId };
      const verified = await read('notion-mcp');
      record = { clientId: registered.client_id, userId: input.userId, workspaceId: granted.workspace_id, connected: true };
      readback = { connected: true, tools: verified.tools.length, protocolVersion: verified.protocolVersion };
    } else if (action === 'notion-mcp.page') {
      if (!mcpGrant) throw new Error('Authorize the local Notion MCP client before creating a page.');
      const inventory = await read('notion-mcp');
      if (!inventory.tools.some(tool => tool.name === 'notion-create-pages')) throw new Error('This MCP provider does not advertise notion-create-pages.');
      const title = required(input, 'title', 300), text = required(input, 'text', 2000);
      const response = await request('notion-mcp', '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${mcpGrant.accessToken}`, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notion-create-pages', arguments: { parent: { page_id: required(input, 'parentPageId', 100) }, pages: [{ properties: { title }, content: text }] } } } });
      if (response.error || response.result?.isError) throw new Error('Notion MCP page creation was not accepted.');
      const content = response.result?.content?.find(item => item.type === 'text')?.text;
      try { record = JSON.parse(content).pages?.[0]; } catch { throw new Error('Notion MCP returned an unexpected page result. Check provider state before repeating the write.'); }
      if (!record?.id) throw new Error('Notion MCP did not return the created page ID. Check provider state before repeating the write.');
      const sdk = await client('notion');
      const page = await sdk.pages.retrieve({ page_id: record.id });
      const markdown = await sdk.pages.retrieveMarkdown({ page_id: record.id });
      const rendered = markdown.markdown?.trim();
      const body = rendered?.startsWith(`# ${title}\n`) ? rendered.slice(title.length + 3).trim() : rendered;
      assertReadback(page.id === record.id && pageTitle(page) === title && body === text, action);
      readback = { page, markdown, crossProtocol: 'MCP write → official REST SDK read' };
    } else if (action === 'notion-agent.session') {
      const sdk = await client('notion');
      const agent_id = required(input, 'agentId', 100), message = required(input, 'message', 2000);
      await sdk.agents.retrieve({ agent_id });
      record = await sdk.sessions.update({ agent_id, message });
      const session = await sdk.sessions.retrieve({ session_id: record.id });
      const events = await pages(start_cursor => sdk.sessions.queryEvents({ session_id: record.id, page_size: 100, start_cursor }), value => value.results ?? [], value => value.has_more ? value.next_cursor : undefined);
      assertReadback(session.id === record.id && session.agent_id === agent_id && events.some(event => event.type === 'user.message' && event.content?.some(part => part.text === message)), action);
      readback = { session, events, behavior: 'Local deterministic session; no external model call' };
    } else if (action === 'notion.webhook-capture') {
      // Notion does not have a public subscription-management API. These
      // explicitly labelled local verification controls are not provider parity.
      const sdk = await client('notion');
      const headers = { 'Notion-Version': '2026-03-11' };
      const before = await request('notion', '/__worldfixture/notion-admin', { headers });
      if (before.live_webhook_delivery !== false) throw new Error('This check requires local capture mode with network delivery disabled.');
      const captureUrl = new URL('/account-desk-local-capture', base('notion'));
      captureUrl.protocol = 'https:';
      // Subscription syntax requires HTTPS. This URL is stored only: capture
      // mode was verified above, and no network delivery is enabled by this app.
      const subscription = await request('notion', '/__worldfixture/notion-admin/webhooks', { method: 'POST', headers, body: { url: captureUrl.href, event_types: ['page.properties_updated'] } });
      try {
        await request('notion', `/__worldfixture/notion-admin/webhooks/${encodeURIComponent(subscription.id)}/verify`, { method: 'POST', headers, body: { verification_token: subscription.verification_token } });
        const page = await sdk.pages.create({ parent: { type: 'page_id', page_id: required(input, 'parentPageId', 100) }, properties: { title: { type: 'title', title: [{ type: 'text', text: { content: required(input, 'title', 300) } }] } } });
        await sdk.pages.update({ page_id: page.id, icon: { type: 'emoji', emoji: '✅' } });
        const state = await request('notion', '/__worldfixture/notion-admin', { headers });
        const delivery = state.webhook_deliveries?.find(item => item.payload?.subscription_id === subscription.id && item.payload?.entity?.id === page.id && item.payload?.type === 'page.properties_updated');
        const signature = delivery ? `sha256=${createHmac('sha256', subscription.verification_token).update(JSON.stringify(delivery.payload)).digest('hex')}` : null;
        assertReadback(delivery && delivery.signature === signature && state.live_webhook_delivery === false, action);
        const confirmed = await sdk.pages.retrieve({ page_id: page.id });
        assertReadback(confirmed.icon?.emoji === '✅', action);
        record = { pageId: page.id, subscriptionId: subscription.id, setupSurface: 'Workbench-only local controls' };
        readback = { eventType: delivery.payload.type, entityId: delivery.payload.entity.id, signatureVerified: true, networkDelivery: false, providerPage: confirmed };
      } finally {
        await request('notion', `/__worldfixture/notion-admin/webhooks/${encodeURIComponent(subscription.id)}`, { method: 'DELETE', headers });
      }
    }
    return { record, readback, operation };
  }
  function catalog() {
    return DEFINITIONS.map(([id, name, prefix, works, missing, clientName]) => {
      const raw = id === 'mail' ? env.IMAP_HOST_PORT : env[`${prefix}_BASE_URL`];
      let baseUrl = null, bindingError = null;
      if (raw) try { baseUrl = id === 'mail' ? (hostPort(raw), raw) : localUrl(raw).href; } catch (error) { bindingError = error.message; }
      return { id, name, selected: Boolean(raw), baseUrl, bindingError, works, missing, client: clientName, actions: ACTIONS.filter(action => action.service === id), productionVerified: false };
    });
  }
  const firstPageReads = new Set(['clerk', 'okta', 'vercel', 'mongoatlas']);
  return {
    catalog,
    read: (id, options = {}) => {
      const key = `${id}:${options.purpose === 'poll' ? 'poll' : 'fresh'}`;
      if (activeReads.has(key)) return activeReads.get(key);
      const task = boundedOperation(async () => {
        const result = serializableData(await read(id, options));
        if (firstPageReads.has(id)) return { ...result, pagination: 'first-page', note: 'This adapter reads the first provider page. This is not a complete inventory when more pages exist.' };
        return result;
      }).catch(error => { throw providerError(error); }).finally(() => activeReads.delete(key));
      activeReads.set(key, task);
      return task;
    },
    execute: (action, input) => boundedOperation(async () => serializableData(await execute(action, input))).catch(error => { throw providerError(error); }),
  };
}
