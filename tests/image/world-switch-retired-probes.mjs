import assert from 'node:assert/strict';
import { s3Fetch } from '../../runtime/src/s3-signing.mjs';
import { readImapMailbox } from './coupling-mail-probes.mjs';

export function retiredListeners(previous, current) {
  const currentOrigins = new Set(Object.entries(current).filter(([key]) => key.endsWith('_BASE_URL')).map(([, value]) => new URL(value).origin));
  return [...new Map(Object.entries(previous).filter(([key]) => key.endsWith('_BASE_URL')).map(([binding, value]) => [new URL(value).origin, { binding, base: new URL(value).origin }]))]
    .filter(([origin]) => !currentOrigins.has(origin)).map(([, value]) => value);
}
export async function probeRetiredListeners({ previous, current, fetchImpl = fetch, connectImpl }) {
  const checks = [], responses = [];
  for (const row of retiredListeners(previous, current)) {
    try {
      if (connectImpl) {
        const result = await connectImpl(row); responses.push({ binding: row.binding, path: row.base, ...result });
        checks.push({ check: `retired-listener.${row.binding}`, status: result.connected === false && result.code === 'ECONNREFUSED' ? 'passed' : 'failed',
          detail: 'Direct connection to the service port inside the product container must be refused.' });
        continue;
      }
      const response = await fetchImpl(row.base, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      const body = await response.text(); responses.push({ binding: row.binding, path: row.base, status: response.status, body });
      checks.push({ check: `retired-listener.${row.binding}`, status: 'failed', detail: 'A listener for an unselected surface still answers HTTP.' });
    } catch (error) {
      const refused = error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED';
      checks.push({ check: `retired-listener.${row.binding}`, status: refused ? 'passed' : 'failed', detail: refused ? 'The published port refuses connections.' : error.message });
      responses.push({ binding: row.binding, path: row.base, status: 'network-error', code: error.cause?.code ?? error.code, message: error.message });
    }
  }
  return { checks, responses };
}

const ROUTES = {
  SLACK: { path: '/api/auth.test', body: {} },
  DOMAIN: { path: '/v1/collections' },
  GOOGLE: { path: '/oauth2/v2/userinfo' },
  GITHUB: { path: '/user' },
  LINEAR: { path: '/graphql', body: { query: 'query { viewer { id email } }' } },
  MICROSOFT: { path: '/v1.0/me' },
  NOTION: { path: '/v1/users/me' },
  NOTION_ADMIN: { path: '/v1/users' },
  CLERK: { path: '/v1/users?limit=1' },
  OKTA: { path: '/api/v1/users/me' },
  STRIPE: { path: '/v1/customers?limit=1' },
  RESEND: { path: '/domains' },
  VERCEL: { path: '/v2/user' },
  MONGOATLAS: { path: '/api/atlas/v2/groups' },
  AWS: { path: '/sts/', form: { Action: 'GetCallerIdentity', Version: '2011-06-15' } },
};
function denial(status, body, provider) {
  if ([401, 403].includes(status)) return true;
  if (provider === 'SLACK') return status === 200 && body?.ok === false && ['invalid_auth', 'not_authed', 'token_revoked'].includes(body.error);
  if (provider === 'LINEAR') return status === 200 && body?.errors?.some(error => ['UNAUTHENTICATED', 'AUTHENTICATION_ERROR', 'FORBIDDEN'].includes(error.extensions?.code));
  return false;
}
export async function probeOldProviderCredentials({ previous, current, fetchImpl = fetch, readMailbox = readImapMailbox }) {
  const checks = [], responses = [];
  const routes = { ...ROUTES };
  if (current.TWILIO_ACCOUNT_SID) routes.TWILIO = { path: `/2010-04-01/Accounts/${current.TWILIO_ACCOUNT_SID}/Messages.json` };
  for (const [provider, route] of Object.entries(routes)) {
    if (!current[`${provider}_BASE_URL`] || !previous[`${provider}_TOKEN`]) continue;
    const base = current[`${provider}_BASE_URL`], old = previous[`${provider}_TOKEN`];
    try {
      assert.notEqual(old, current[`${provider}_TOKEN`], 'The old provider credential was reused');
      const response = await fetchImpl(`${base.replace(/\/$/, '')}${route.path}`, {
        method: route.body || route.form ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${old}`, 'Notion-Version': '2026-03-11', 'content-type': route.form ? 'application/x-www-form-urlencoded' : 'application/json' },
        ...(route.body ? { body: JSON.stringify(route.body) } : route.form ? { body: new URLSearchParams(route.form) } : {}),
      });
      const raw = await response.text(); let body; try { body = JSON.parse(raw); } catch { body = raw; }
      responses.push({ provider: provider.toLowerCase(), path: route.path, status: response.status, body });
      checks.push({ check: `old-credential.${provider}`, status: denial(response.status, body, provider) ? 'passed' : 'failed', detail: 'Requires a measured authentication denial at the current generation API.' });
    } catch (error) { checks.push({ check: `old-credential.${provider}`, status: 'failed', detail: error.message }); }
  }
  if (current.S3_BASE_URL && previous.S3_ACCESS_KEY_ID && previous.S3_SECRET_ACCESS_KEY) {
    try {
      const response = await s3Fetch(`${current.S3_BASE_URL.replace(/\/$/, '')}/`, { method: 'GET', signal: AbortSignal.timeout(10000) }, { ...previous, S3_BASE_URL: current.S3_BASE_URL }, fetchImpl);
      const body = await response.text(); responses.push({ provider: 's3', path: '/', status: response.status, body });
      checks.push({ check: 'old-credential.S3', status: [401, 403].includes(response.status) ? 'passed' : 'failed' });
    } catch (error) { checks.push({ check: 'old-credential.S3', status: 'failed', detail: error.message }); }
  }
  if (current.TWILIO_BASE_URL && previous.TWILIO_ACCOUNT_SID && previous.TWILIO_AUTH_TOKEN) {
    try {
      const path = `/2010-04-01/Accounts/${encodeURIComponent(previous.TWILIO_ACCOUNT_SID)}.json`;
      const response = await fetchImpl(`${current.TWILIO_BASE_URL.replace(/\/$/, '')}${path}`, {
        headers: { authorization: `Basic ${Buffer.from(`${previous.TWILIO_ACCOUNT_SID}:${previous.TWILIO_AUTH_TOKEN}`).toString('base64')}` }, signal: AbortSignal.timeout(10000),
      });
      responses.push({ provider: 'twilio', path, status: response.status, body: await response.text() });
      checks.push({ check: 'old-credential.TWILIO_BASIC', status: [401, 403].includes(response.status) ? 'passed' : 'failed' });
    } catch (error) { checks.push({ check: 'old-credential.TWILIO_BASIC', status: 'failed', detail: error.message }); }
  }
  if (current.IMAP_HOST_PORT && previous.IMAP_USERNAME && previous.IMAP_PASSWORD) {
    try {
      await readMailbox({ address: current.IMAP_HOST_PORT, login: previous.IMAP_USERNAME, password: previous.IMAP_PASSWORD, mailbox: 'INBOX' });
      checks.push({ check: 'old-credential.IMAP', status: 'failed', detail: 'Old mailbox credentials were accepted.' });
    } catch (error) {
      checks.push({ check: 'old-credential.IMAP', status: error.message === 'IMAP LOGIN was rejected' ? 'passed' : 'failed', detail: error.message });
    }
  }
  return { checks, responses };
}
