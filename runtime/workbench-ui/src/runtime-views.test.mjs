import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  server: { middlewareMode: true, hmr: false, watch: null }, logLevel: "silent" });
after(() => server.close());
const { Overview } = await server.ssrLoadModule("/src/screens/Overview.jsx");
const { People, ServiceDetail } = await server.ssrLoadModule("/src/screens/WorkbenchScreens.jsx");
const { Bindings } = await server.ssrLoadModule("/src/components/RuntimeViews.jsx");
const { Notion, Website } = await server.ssrLoadModule("/src/screens/ProviderScreens.jsx");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const data = {
  world: { id: "custom-world", version: "v1", title: "Custom", company: "Example Organization", organizationId: "org", organizationPeople: 1, worldPeople: 2 },
  people: [{ id: "inside", name: "Internal Person", organization_id: "org", organization_name: "Example Organization" },
    { id: "outside", name: "External Person", organization_id: "external", organization_name: "Customer" }],
  surfaces: [{ id: "custom:storage", name: "Custom Storage", state: "ready", service: "custom", capabilities: ["custom.storage.v1"], bindingNames: ["OPAQUE_ADDRESS", "CUSTOM_SECRET"] }],
  bindings: { OPAQUE_ADDRESS: "http://custom.test", CUSTOM_SECRET: "secret-real-value", WORKBENCH_URL: "http://localhost:1234" },
  bindingGroups: [{ id: "custom:storage", name: "Custom Storage", capabilities: ["custom.storage.v1"], bindings: ["OPAQUE_ADDRESS", "CUSTOM_SECRET"] }],
  providers: {}, activity: [],
};

test("Overview renders every selected unknown surface without assuming Slack or mail data", () => {
  const output = render(Overview, { data, setScreen() {} });
  assert.match(output, /Custom Storage/);
  assert.match(output, /Unavailable/);
  assert.doesNotMatch(output, /SLACK_BASE_URL|Gmail now|HTTP target included/);
});

test("generic service details expose unknown capabilities and masked bindings with no actor", () => {
  const output = render(ServiceDetail, { data, surfaceId: "custom:storage", setScreen() {}, actor: null });
  assert.match(output, /custom\.storage\.v1/);
  assert.match(output, /OPAQUE_ADDRESS/);
  assert.match(output, /CUSTOM_SECRET/);
  assert.doesNotMatch(output, /secret-real-value/);
  assert.match(output, /Resource data is unavailable/);
});

test("bindings retain all names beyond eight and include ungrouped entries", () => {
  const extra = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`EXTRA_${index}`, `value-${index}`]));
  const output = render(Bindings, { data: { ...data, bindings: { ...data.bindings, ...extra } } });
  for (const name of Object.keys(extra)) assert.ok(output.includes(name));
  assert.match(output, /WORKBENCH_URL/);
  assert.match(output, /Other bindings/);
  assert.doesNotMatch(output, /secret-real-value/);
});

test("People initially shows only the named organization and labels whole-world counts", () => {
  const output = render(People, { data, actor: null, setActor() {} });
  assert.match(output, /People in Example Organization/);
  assert.match(output, /Internal Person/);
  assert.doesNotMatch(output, /External Person/);
  assert.match(output, /All people in this world · 2 people/);
  assert.match(output, /1 of 1 shown/);
});

test("Notion keeps complete pages visible when optional admin reads fail", () => {
  const notion = { status: "partial", available: true, error: "Admin credential unavailable",
    pages: [{ id: "visible-page", properties: { title: { type: "title", title: [{ plain_text: "Visible page" }] } } }],
    users: [], legalHolds: [], databases: [], collectionStatus: {
      pages: { status: "complete" }, users: { status: "complete" },
      legalHolds: { status: "unavailable", error: "Admin credential unavailable" },
      databases: { status: "failed", error: "Database HTTP 403" },
    } };
  const output = render(Notion, { data: { ...data, providers: { notion } }, onChanged() {} });
  assert.match(output, /Pages · 1/);
  assert.match(output, /visible-page/);
  assert.match(output, /Workspace users · 0/);
  assert.match(output, /Enterprise legal holds · Unavailable/);
  assert.match(output, /Databases · Unavailable/);
  assert.doesNotMatch(output, /No legal holds exist|No databases are visible|No webhook subscriptions exist/);
});

test("Notion partial collections show observed records with an unknown total", () => {
  const notion = { status: "partial", available: true, pages: [], users: [],
    comments: [{ id: "observed-comment", rich_text: [{ plain_text: "Observed text" }] }],
    collectionStatus: { pages: { status: "complete" }, users: { status: "complete" }, comments: { status: "partial", error: "Later page failed" } } };
  const output = render(Notion, { data: { ...data, providers: { notion } }, onChanged() {} });
  assert.match(output, /Comments · Unavailable/);
  assert.match(output, /Showing 1 observed records; the total is unavailable/);
  assert.match(output, /observed-comment/);
  assert.doesNotMatch(output, /Comments · 1/);
});

test("Website frame uses the declared preview URL and never substitutes the binding root", () => {
  const website = { status: "ready", preview: "Selected content", previewPath: "/p3/kind", previewUrl: "http://site.test/p3/kind", targets: [] };
  const output = render(Website, { data: { ...data, bindings: { SITE_BASE_URL: "http://site.test" }, providers: { website } } });
  assert.match(output, /src="http:\/\/site.test\/p3\/kind"/);
  assert.doesNotMatch(output, /src="http:\/\/site.test\/?"/);
  const missing = render(Website, { data: { ...data, bindings: { SITE_BASE_URL: "http://site.test" }, providers: { website: { status: "error", targets: [] } } } });
  assert.doesNotMatch(missing, /<iframe/);
  assert.match(missing, /No declared HTTP target/);
});

test('Overview puts streaming before connections and keeps service inventory collapsed', () => {
  const output = render(Overview, { data, setScreen() {} });
  assert.ok(output.indexOf('Event stream') < output.indexOf('Connect your app'));
  assert.match(output, /<details class="overview-services"><summary>/);
  assert.doesNotMatch(output, /Reset world services|secret-real-value/);
});

const { MessageContent } = await server.ssrLoadModule('/src/components/ContentDetails.jsx');
test('expanded content escapes text and isolates HTML with scripts and network disabled', () => {
  const text = render(MessageContent, { content: { text: '<script>bad()</script>', comments: [{ id: 1, body: '<img src=x onerror=bad()>' }] } });
  assert.doesNotMatch(text, /<script>|<img/);
  assert.match(text, /&lt;script&gt;/);
  const html = render(MessageContent, { content: { html: '<script>bad()</script><a href="https://example.test">link</a>' } });
  assert.match(html, /sandbox=""/);
  assert.match(html, /default-src &#x27;none&#x27;/);
  assert.doesNotMatch(html, /allow-scripts|allow-same-origin/);
});
