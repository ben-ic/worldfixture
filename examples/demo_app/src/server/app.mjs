import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { checkRequest, localUrl, makeRedactor, readBody } from './security.mjs';
import { createWorkflowRunner } from '../workflows/runner.mjs';
import { createVerificationRunner } from '../verification/runner.mjs';
import { createOAuth } from './oauth.mjs';
import { createLiveHub } from './live.mjs';
import { buildWritePlan } from '../verification/plans.mjs';
import { runSummary } from '../verification/summary.mjs';
import { createSlackScenarios } from './slack-scenarios.mjs';
import { COVERAGE_BASELINE, PROVIDER_COVERAGE, UNIMPLEMENTED_WORKFLOWS } from '../providers/coverage.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function createApplication({ providers, store, connector, actions, env = {}, staticRoot, middleware, onCredentials = () => {} }) {
  const redact = makeRedactor(env);
  const world = { id: env.WORLDFIXTURE_WORLD_ID ?? 'unbound', version: env.WORLDFIXTURE_WORLD_VERSION ?? 'unknown' };
  const live = createLiveHub({ redact });
  const workflows = createWorkflowRunner({ providers, store, actions, world, redact, onUpdate: receipt => live.publish('receipt', receipt) });
  const verification = createVerificationRunner({ providers, store, world, workflows, redact, onUpdate: run => live.publish('verification', runSummary(run)) });
  const writePlans = new Map();
  const data = {};
  const status = new Map();
  const pending = new Map();
  let origin;
  let oauthOrigin;
  const oauth = createOAuth(env, { origin: () => oauthOrigin || origin });
  let seedPreview = false;
  let seedTask;
  function services() {
    return providers.catalog().map(service => ({ ...service, coverage: PROVIDER_COVERAGE.find(item => item.service === service.id), ...status.get(service.id), state: !service.selected ? 'unselected' : status.get(service.id)?.state ?? 'loading' }));
  }
  async function snapshot() {
    const workbenchUrl = (() => { try { return localUrl(env.WORKBENCH_URL).href; } catch { return null; } })();
    const [drafts, runs, receipts, events] = await Promise.all(['drafts', 'runs', 'receipts', 'events'].map(collection => store.list(collection)));
    return { world, services: services(), data, storage: { kind: store.kind, available: store.available }, drafts, runs: runs.map(runSummary), receipts, events, slackScenarios: await slackScenarios.list(), oauth: oauth.catalog(), workbenchUrl, coverage: { baseline: COVERAGE_BASELINE, unimplemented: UNIMPLEMENTED_WORKFLOWS },
      stream: { providerPollIntervalMs: 10000, note: 'App progress is streamed immediately. Provider inventories are checked every 10 seconds while a live tab is open. Background Gmail details can be cached for five minutes; new message IDs, manual reads, and write readbacks use fresh requests. Rate-limited Google reads wait for the reset time.' } };
  }
  function publishService(id) { live.publish('service', { service: services().find(item => item.id === id), data: data[id] ?? null }); }
  async function refresh(id, options = {}) {
    const service = providers.catalog().find(item => item.id === id);
    if (!service) throw new Error('Unknown service.');
    if (!service.selected) return null;
    if (pending.has(id)) {
      const active = pending.get(id);
      // A manual read must not reuse cached details from a background poll.
      if (active.purpose === 'poll' && options.purpose !== 'poll') {
        await active.task.catch(() => {});
        return refresh(id, options);
      }
      return active.task;
    }
    status.set(id, { state: 'loading' });
    publishService(id);
    const task = (async () => {
      try {
        data[id] = redact(await providers.read(id, options));
        status.set(id, { state: 'ready', refreshedAt: new Date().toISOString() });
        publishService(id);
        return data[id];
      } catch (error) {
        status.set(id, { state: 'failed', error: redact(error.message), ...(error.retryAt ? { retryAt: error.retryAt } : {}), refreshedAt: new Date().toISOString() });
        delete data[id];
        publishService(id);
        throw error;
      } finally { pending.delete(id); }
    })();
    pending.set(id, { task, purpose: options.purpose });
    return task;
  }
  const refreshing = new Map();
  function refreshAll(options = {}) {
    const purpose = options.purpose === 'poll' ? 'poll' : 'fresh';
    if (refreshing.has(purpose)) return refreshing.get(purpose);
    const task = (async () => {
    // Four reads at a time keep a large world usable while services load.
    const queue = providers.catalog().filter(item => item.selected).map(item => item.id);
    await Promise.all(Array.from({ length: Math.min(queue.length, 4) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        if (purpose === 'poll' && Date.parse(status.get(id)?.retryAt) > Date.now()) continue;
        await refresh(id, options).catch(() => {});
      }
    }));
    })().finally(() => { refreshing.delete(purpose); });
    refreshing.set(purpose, task);
    return task;
  }
  const poll = setInterval(() => { if (live.size) void refreshAll({ purpose: 'poll' }); }, 10000);
  poll.unref?.();
  const slackScenarios = createSlackScenarios({ providers, store, workflows, world,
    onUpdate: run => live.publish('slackScenario', run),
    onMessage: () => refresh('slack'),
  });
  function json(response, statusCode, value) {
    const body = JSON.stringify(redact(value));
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    response.end(body);
  }
  const server = createServer(async (request, response) => {
    let oauthCallback = false;
    try {
      const url = new URL(request.url, origin);
      const callback = /^\/oauth\/([a-z]+)\/callback$/.exec(url.pathname);
      // OAuth comes back from a different local port. State plus the HttpOnly
      // browser-session cookie protects this one route; all others reject CORS.
      checkRequest(callback ? { headers: { host: request.headers.host } } : request, origin);
      if (callback) {
        oauthCallback = true;
        oauthOrigin = `http://${request.headers.host}`;
        let params = url.searchParams;
        if (request.method === 'POST') {
          if (!String(request.headers['content-type']).startsWith('application/x-www-form-urlencoded')) throw new Error('Expected an OAuth form response.');
          let body = '';
          for await (const chunk of request) { body += chunk; if (body.length > 16384) throw new Error('OAuth response is too large.'); }
          params = new URLSearchParams(body);
        } else if (request.method !== 'GET') throw new Error('Unsupported OAuth callback method.');
        const sessionId = /(?:^|;\s*)account_desk_session=([a-zA-Z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
        await oauth.callback(callback[1], params, { sessionId });
        onCredentials(oauth.credentials());
        void refreshAll();
        response.writeHead(303, { location: '/?connected=' + encodeURIComponent(callback[1]), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/api/oauth') return json(response, 200, { connections: oauth.catalog() });
      const authStart = /^\/api\/oauth\/([a-z]+)\/start$/.exec(url.pathname);
      if (request.method === 'POST' && authStart) {
        await readBody(request);
        oauthOrigin = `http://${request.headers.host}`;
        const sessionId = randomBytes(32).toString('base64url');
        response.setHeader('set-cookie', `account_desk_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
        return json(response, 200, { url: oauth.start(authStart[1], { sessionId }) });
      }
      if (url.pathname === '/.well-known/worldfixture' || url.pathname.startsWith('/__worldfixture/')) {
        const input = request.method === 'POST' ? await readBody(request, 8 * 1024 * 1024) : {};
        const result = await connector.handle({ method: request.method, path: url.pathname, authorization: request.headers.authorization, input });
        if (request.method === 'POST' && result?.status < 300 && url.pathname.includes('/events')) {
          live.publish('events', { events: await store.list('events') });
        }
        return json(response, result?.status ?? 404, result?.body ?? { error: 'Not found.' });
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        return json(response, 200, await snapshot());
      }
      if (request.method === 'GET' && url.pathname === '/api/live') {
        const send = live.attach(request, response);
        send('connected', await snapshot());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/connections') return json(response, 200, { services: services() });
      if (request.method === 'GET' && url.pathname === '/api/actions') return json(response, 200, { actions });
      if (request.method === 'POST' && url.pathname === '/api/slack-scenarios/preview') {
        const input = await readBody(request);
        return json(response, 200, await slackScenarios.preview(input.channel));
      }
      if (url.pathname === '/api/slack-scenarios') {
        if (request.method === 'GET') return json(response, 200, await slackScenarios.list());
        if (request.method === 'POST') return json(response, 202, await slackScenarios.start(await readBody(request)));
      }
      const scenarioPath = /^\/api\/slack-scenarios\/([^/]+)(\/stop)?$/.exec(url.pathname);
      if (scenarioPath && request.method === 'GET' && !scenarioPath[2]) {
        const run = (await slackScenarios.list()).find(item => item.id === scenarioPath[1]);
        return json(response, run ? 200 : 404, run || { error: 'This scenario is not available.' });
      }
      if (scenarioPath?.[2] && request.method === 'POST') {
        await readBody(request);
        return json(response, 200, await slackScenarios.stop(scenarioPath[1]));
      }
      if (request.method === 'POST' && url.pathname === '/api/workbench/open') {
        await readBody(request);
        const { stdout } = await exec('npx', ['--no-install', 'worldfixture', 'open'], { env, timeout: 20_000, maxBuffer: 65536 });
        const target = stdout.match(/Opened the Workbench at (https?:\/\/\S+)/)?.[1];
        if (!target) throw new Error('WorldFixture did not return a Workbench address. Run npx worldfixture open from the app directory.');
        env.WORKBENCH_URL = localUrl(target).href;
        return json(response, 200, { url: env.WORKBENCH_URL });
      }
      if (request.method === 'POST' && ['/api/connector/plan', '/api/connector/seed'].includes(url.pathname)) {
        const input = await readBody(request);
        const operation = url.pathname.endsWith('/plan') ? 'plan' : 'seed';
        if (operation === 'seed' && (!seedPreview || input.approved !== true)) throw new Error('Read the seed plan and approve it before seeding app records.');
        const invoke = async () => {
          try {
            const { stdout } = await exec('npx', ['--no-install', 'worldfixture', 'connector', operation, origin, '--scale', 'smoke', '--json'], { env, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
            return JSON.parse(stdout);
          } catch (error) { throw new Error(redact(error.stdout?.trim() || error.stderr?.trim() || 'The local connector command failed. Check the active world and connector token.')); }
        };
        if (operation === 'plan') {
          const plan = await invoke(); seedPreview = true;
          return json(response, 200, plan);
        }
        if (!seedTask) seedTask = invoke().finally(() => { seedTask = null; });
        return json(response, 200, await seedTask);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/service/')) return json(response, 200, await refresh(decodeURIComponent(url.pathname.slice('/api/service/'.length))));
      if (request.method === 'POST' && url.pathname === '/api/refresh') {
        await readBody(request);
        void refreshAll();
        return json(response, 202, { refreshing: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/drafts') return json(response, 200, { drafts: await store.list('drafts') });
      if (request.method === 'POST' && url.pathname === '/api/drafts') {
        const input = await readBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A draft object is required.');
        const draft = { ...input, id: input.id || randomUUID(), world, updatedAt: new Date().toISOString() };
        if (typeof draft.id !== 'string' || draft.id.length > 160) throw new Error('Invalid draft ID.');
        await store.put('drafts', draft.id, draft);
        live.publish('draft', draft);
        return json(response, 200, draft);
      }
      if (request.method === 'POST' && ['/api/actions', '/api/workflows'].includes(url.pathname)) {
        const input = await readBody(request);
        const steps = url.pathname === '/api/actions' ? [{ action: input.action, input: input.input }] : input.steps;
        const result = await workflows.run({ steps, idempotencyKey: input.idempotencyKey });
        for (const step of steps) {
          const service = actions.find(item => item.id === step.action)?.service;
          if (service) void refresh(service).catch(() => {});
        }
        return json(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') return json(response, 200, { runs: (await store.list('runs')).map(runSummary) });
      if (request.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
        const run = await store.get('runs', url.pathname.slice('/api/runs/'.length));
        return json(response, run ? 200 : 404, run ?? { error: 'Run not found.' });
      }
      if (request.method === 'POST' && url.pathname === '/api/verify') {
        const input = await readBody(request);
        if (input.planId !== undefined) {
          if (input.approved !== true) throw new Error('Review the exact write plan and explicitly approve it first.');
          const plan = writePlans.get(input.planId);
          if (!plan) throw new Error('This write plan is no longer available. Prepare a new plan.');
          if (plan.task) {
            const started = await plan.task;
            return json(response, 202, await store.get('runs', started.id) || started);
          }
          if (Date.parse(plan.expiresAt) < Date.now()) throw new Error('This write plan expired. Read the current provider records and prepare another plan.');
          plan.task = verification.startWrites(plan);
          return json(response, 202, await plan.task);
        }
        return json(response, 202, await verification.start(input.services));
      }
      if (request.method === 'POST' && url.pathname === '/api/verify/plan') {
        const input = await readBody(request);
        for (const [id, plan] of writePlans) if (Date.parse(plan.expiresAt) < Date.now()) writePlans.delete(id);
        if (writePlans.size >= 32) throw new Error('Too many write plans. Use an existing plan or wait for it to expire.');
        const plan = await buildWritePlan({ providers, actions, serviceIds: input.services, env, world });
        writePlans.set(plan.id, plan);
        return json(response, 200, plan);
      }
      if (request.method === 'POST' && /^\/api\/runs\/[^/]+\/stop$/.test(url.pathname)) {
        await readBody(request);
        return json(response, 200, verification.stop(url.pathname.split('/')[3]));
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'This application operation is not supported.' });
      if (middleware) return middleware(request, response, () => json(response, 404, { error: 'Not found.' }));
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed.' });
      const root = resolve(staticRoot);
      let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (file !== root && !file.startsWith(root + sep)) return json(response, 403, { error: 'Invalid file path.' });
      if (!extname(file)) file = resolve(root, 'index.html');
      if (!existsSync(file)) return json(response, 404, { error: 'Build the UI with npm run build first.' });
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      if (request.method === 'HEAD') return response.end();
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else if (oauthCallback) {
        response.writeHead(303, { location: `/?oauth_error=${encodeURIComponent(redact(error.message))}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        response.end();
      }
      else json(response, error.status ?? 400, { error: error.message });
    }
  });
  return {
    server, refreshAll, workflows, verification,
    async listen(port = 5175) {
      await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
      origin = `http://127.0.0.1:${server.address().port}`;
      return origin;
    },
    async close() { clearInterval(poll); await slackScenarios.close(); live.close(); await verification.close(); await new Promise(done => server.close(done)); },
  };
}
