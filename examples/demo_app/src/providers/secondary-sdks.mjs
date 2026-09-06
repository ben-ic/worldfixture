import { LinearClient } from '@linear/sdk';
import { Resend } from 'resend';
import twilio from 'twilio';
import { localUrl, localFetch, required, headerValue, pages, checkBudget, assertReadback } from './safety.mjs';

const rows = (items, title, subtitle = () => '') => items.map(item => ({ ...item, id: String(item.id ?? item.sid), title: title(item), subtitle: subtitle(item) }));
const plain = item => JSON.parse(JSON.stringify(typeof item.toJSON === 'function' ? item.toJSON() : item));

/** Official SDK resource methods, with local-only transports and no retries. */
export function createSecondarySdk(env) {
  function origin(prefix) {
    const url = localUrl(required(env, `${prefix}_BASE_URL`));
    if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${prefix}_BASE_URL must be the generated local provider origin.`);
    return url.origin;
  }
  async function linear(query, variables) {
    checkBudget();
    // Current generated model fragments request unsupported provider fields.
    // The SDK's public rawRequest method supports an explicit field selection.
    const sdk = new LinearClient({ accessToken: required(env, 'LINEAR_TOKEN'), apiUrl: `${origin('LINEAR')}/graphql`, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const result = await sdk.client.rawRequest(query, variables);
    return result.data;
  }
  function resend() {
    const base = origin('RESEND');
    const fetchLocal = localFetch(base);
    class LocalResend extends Resend {
      // Keep resource request construction in the official SDK. Replace only
      // its public transport hook to enforce timeout and redirect protection.
      async fetchRequest(path, options = {}) {
        const response = await fetchLocal(`${base}${path}`, options);
        if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}.`);
        return { data: await response.json(), error: null, headers: Object.fromEntries(response.headers) };
      }
    }
    return new LocalResend(required(env, 'RESEND_TOKEN'), { baseUrl: base });
  }
  function twilioClient() {
    const base = origin('TWILIO');
    const fetchLocal = localFetch(base);
    const accountSid = required(env, 'TWILIO_ACCOUNT_SID');
    const authToken = required(env, 'TWILIO_AUTH_TOKEN');
    const client = twilio(accountSid, authToken, { autoRetry: false, maxRetries: 0, logLevel: 'silent', httpClient: {
      async request(options) {
        const url = localUrl(options.uri);
        if (url.origin !== base) throw new Error('Twilio SDK request is outside the generated local binding.');
        for (const [key, value] of Object.entries(options.params || {})) if (value !== undefined) url.searchParams.set(key, String(value));
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(options.data || {})) {
          if (value === undefined) continue;
          for (const entry of Array.isArray(value) ? value : [value]) body.append(key, String(entry));
        }
        const response = await fetchLocal(url, { method: options.method.toUpperCase(), headers: { ...options.headers,
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
          ...(['post', 'put', 'patch'].includes(options.method.toLowerCase()) ? { body } : {}),
        });
        return { statusCode: response.status, body: await response.text(), headers: Object.fromEntries(response.headers) };
      },
    } });
    client.api.baseUrl = base;
    return client;
  }
  async function read(id) {
    if (id === 'linear') {
      const list = (name, fields) => pages(async after => (await linear(`query AccountDeskList($after: String) { ${name}(first: 100, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`, { after }))[name],
        result => result.nodes, result => result.pageInfo?.hasNextPage ? result.pageInfo.endCursor : undefined);
      const [issues, teams] = await Promise.all([list('issues', 'id identifier title description state { name } team { id name }'), list('teams', 'id name')]);
      return { items: rows(issues, item => item.title, item => `${item.identifier} · ${item.state?.name || ''}`), issues, teams };
    }
    if (id === 'resend') {
      const sdk = resend();
      const emails = await pages(async after => (await sdk.emails.list({ limit: 100, ...(after ? { after } : {}) })).data,
        result => result.data ?? [], result => result.has_more ? result.data?.at(-1)?.id : undefined);
      return { items: rows(emails, item => item.subject || item.id, item => item.from || ''), emails };
    }
    if (id === 'twilio') {
      const sdk = twilioClient();
      const [messageModels, numberModels] = await Promise.all([sdk.messages.list({ pageSize: 100, limit: 1000 }), sdk.incomingPhoneNumbers.list({ pageSize: 100, limit: 1000 })]);
      const messages = messageModels.map(plain);
      const numbers = numberModels.map(item => ({ ...plain(item), phone_number: item.phoneNumber, friendly_name: item.friendlyName }));
      return { items: rows(messages, item => item.body || item.sid, item => `${item.from} → ${item.to}`), messages, numbers,
        truncated: messages.length === 1000 || numbers.length === 1000, note: 'Lists at most 1,000 messages and 1,000 incoming numbers.' };
    }
    throw new Error('No secondary SDK read adapter for this service.');
  }
  async function execute(action, input) {
    let record;
    let readback;
    if (action === 'linear.issue') {
      const payload = { teamId: required(input, 'teamId'), title: required(input, 'title'), description: required(input, 'description') };
      const result = await linear('mutation AccountDeskCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id title description } } }', { input: payload });
      if (!result.issueCreate?.success || !result.issueCreate.issue?.id) throw new Error('Linear did not accept issue creation.');
      record = result.issueCreate.issue;
      readback = (await linear('query AccountDeskReadIssue($id: String!) { issue(id: $id) { id title description } }', { id: record.id })).issue;
      assertReadback(readback?.id === record.id && readback.title === payload.title && readback.description === payload.description, action);
    } else if (action === 'resend.send') {
      const sdk = resend();
      const payload = { from: headerValue(input, 'from'), to: [headerValue(input, 'to')], subject: headerValue(input, 'subject'), text: required(input, 'text') };
      record = (await sdk.emails.send(payload)).data;
      if (!record?.id) throw new Error('Resend did not return an email ID.');
      readback = (await sdk.emails.get(encodeURIComponent(record.id))).data;
      assertReadback(readback?.id === record.id && readback.subject === payload.subject && readback.text === payload.text, action);
    } else if (action === 'twilio.send') {
      const sdk = twilioClient();
      const payload = { from: required(input, 'from'), to: required(input, 'to'), body: required(input, 'text') };
      record = plain(await sdk.messages.create(payload));
      readback = plain(await sdk.messages(record.sid).fetch());
      assertReadback(readback.sid === record.sid && readback.body === payload.body && readback.from === payload.from && readback.to === payload.to, action);
    } else throw new Error('No secondary SDK write adapter for this operation.');
    return { operation: action, record, readback };
  }
  return { read, execute };
}
