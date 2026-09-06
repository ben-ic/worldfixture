import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { runIdentity, reconcileScreen } from './navigation.mjs';
const server = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'silent' });
after(() => server.close());
const { worldSwitchInput, Worlds, WorldCatalogue, SessionProgress, ConnectionConfirmation } = await server.ssrLoadModule('/src/screens/Worlds.jsx');
const { TimelineControls } = await server.ssrLoadModule('/src/screens/Timeline.jsx');
const { App } = await server.ssrLoadModule('/src/App.jsx');
const render = (component, props = {}) => renderToStaticMarkup(createElement(component, props));
test('the full App and world picker mount before session and catalogue reads complete', () => {
  assert.match(render(App), /Loading the active instance/);
  assert.match(render(Worlds, { session: null }), /World switching is unavailable/);
  const markup = render(Worlds, { session: { managed: true, phase: 'ready' } });
  assert.match(markup, /Reading the world catalogue/); assert.match(markup, /removes manual changes/); assert.match(markup, /Application database data is preserved/);
  assert.doesNotMatch(markup, /business\.saas|consumer\.retail/);
});
test('catalogue renders actual identities, invalid provenance, and unavailable choices', () => {
  const markup = render(WorldCatalogue, { entries: [{ id: 'custom/odd', version: 'v9', artifactPath: '/odd', digest: 'verified-digest', valid: true },
    { id: 'broken', version: 'v1', artifactPath: '/broken', valid: false, errors: ['Missing <manifest>'] }], onSelect() {} });
  assert.match(markup, /custom\/odd:v9/); assert.match(markup, /verified-digest/); assert.match(markup, /Missing &lt;manifest&gt;/);
  assert.match(markup, /disabled=""[^>]*>Select this world/); assert.doesNotMatch(markup, /business\.saas/);
});
test('connection confirmation is explicit and setup delivery stays disabled until it succeeds', () => {
  const session = { managed: true, phase: 'ready', reconnect_required: true };
  const markup = render(ConnectionConfirmation, { session, onSession() {} });
  assert.match(markup, /Confirm application connection/); assert.match(markup, /Continue without an application/); assert.match(markup, /only when no scheduled event requires one/);
  assert.equal(render(ConnectionConfirmation, { session: { ...session, reconnect_required: false } }), '');
  const sample = { status: { mode: 'setup', clock: { started: true }, repeat: { enabled: false, eligible: true } } };
  const controls = render(TimelineControls, { sample, reconnectRequired: true, onCommand() {} });
  for (const control of controls.match(/<(?:button|input)\b[^>]*>/g)) assert.match(control, /disabled=""/);
});
test('transition and stopped state expose the actual stage without provider controls', () => {
  assert.match(render(SessionProgress, { session: { managed: true, phase: 'switching', transition: { phase: 'rolling_back' } } }), /rolling back/);
  assert.match(render(SessionProgress, { session: { managed: true, phase: 'stopped' } }), /World services are stopped/);
});
test('returning to the same world has a new render and evidence identity', () => {
  const data = { world: { id: 'same', version: 'v1', artifact_sha256: 'same-digest' }, session: { generation: 'first' } };
  assert.notEqual(runIdentity(data), runIdentity({ ...data, session: { generation: 'returned' } }));
  assert.equal(reconcileScreen(data, 'Worlds'), 'Worlds');
});

test('catalogue selection uses exact artifact paths for different digests with the same name', () => {
  const first = { id: 'same', version: 'v1', artifactPath: '/catalogue/first-digest', valid: true };
  const second = { ...first, artifactPath: '/catalogue/second-digest' };
  assert.deepEqual(worldSwitchInput(first, '', false), { worldPath: first.artifactPath, noRebase: false });
  assert.deepEqual(worldSwitchInput(second, '', true), { worldPath: second.artifactPath, noRebase: true });
  assert.deepEqual(worldSwitchInput(first, ' /custom/world ', false), { worldPath: '/custom/world', noRebase: false });
  assert.throws(() => worldSwitchInput({ ...first, valid: false }, '', false), /verified artifact/);
});
