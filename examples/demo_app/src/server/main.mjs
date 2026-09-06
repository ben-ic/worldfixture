import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders, ACTIONS } from '../providers/index.mjs';
import { createStore } from '../db/store.mjs';
import { createConnector } from '../connector/index.mjs';
import { createApplication } from './app.mjs';
import { loadEnvironment } from './bindings.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = await loadEnvironment();
let currentProviders = createProviders(env);
const providers = Object.fromEntries(['catalog', 'read', 'execute'].map(method => [method, (...args) => currentProviders[method](...args)]));
const store = await createStore(env);
const world = { id: env.WORLDFIXTURE_WORLD_ID ?? 'unbound', version: env.WORLDFIXTURE_WORLD_VERSION ?? 'unknown' };
const connector = createConnector({ store, token: env.WORLDFIXTURE_TOKEN, world, enabled: true });
const dev = process.argv.includes('--dev');
const vite = dev ? await (await import('vite')).createServer({ root, server: { middlewareMode: true }, appType: 'spa' }) : null;
const app = createApplication({ providers, store, connector, actions: ACTIONS, env, staticRoot: resolve(root, 'dist'), middleware: vite?.middlewares,
  onCredentials(credentials) { Object.assign(env, credentials); currentProviders = createProviders(env); },
});
let origin;
try { origin = await app.listen(Number(env.ACCOUNT_DESK_PORT ?? 5175)); }
catch (error) {
  if (error.code !== 'EADDRINUSE' || env.ACCOUNT_DESK_PORT) throw error;
  origin = await app.listen(0);
}
console.log(`Account Desk: ${origin}`);
console.log(`App storage: ${store.kind}. Provider state stays in WorldFixture.`);
console.log(`Connector target: ${origin}. If Workbench shows another target, enter this URL in its Target area.`);
if (!providers.catalog().some(item => item.selected)) console.log('No local service bindings. Start a world, then use: npx worldfixture run -- npm run dev');
void app.refreshAll();
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await vite?.close();
  await store.close();
  process.exit(0);
});
