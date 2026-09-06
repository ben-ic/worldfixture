import assert from "node:assert/strict";
import test from "node:test";
import { ALL_ORGANIZATIONS, bindingGroupsFor, NO_ORGANIZATION, overviewExamples, peopleSelection, surfaceResources, worldLabels } from "./runtime-data.mjs";

test("all bindings remain reachable, including new services and unassigned names", () => {
  const bindings = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`NEW_${index}`, String(index)]));
  bindings.WORKBENCH_URL = "http://localhost:1234";
  const data = { bindings, bindingGroups: [{ id: "custom", name: "Custom store", capabilities: ["custom.objects.v1"], bindings: ["NEW_19", "ABSENT"] }] };
  const groups = bindingGroupsFor(data);
  assert.deepEqual(new Set(groups.flatMap((group) => group.entries.map(([name]) => name))), new Set(Object.keys(bindings)));
  assert.equal(bindingGroupsFor(data, { query: "custom.objects" })[0].entries[0][0], "NEW_19");
  assert.equal(bindingGroupsFor(data, { query: "workbench_url" })[0].entries[0][0], "WORKBENCH_URL");
});

test("service details scope bindings by capability metadata, not name prefixes", () => {
  const data = { bindings: { OPAQUE: "value", OTHER: "hidden" }, surfaces: [{ id: "new:service", capabilities: ["custom.v1"] }],
    bindingGroups: [{ id: "profile-group", name: "Custom", capabilities: ["custom.v1"], bindings: ["OPAQUE"] }] };
  assert.deepEqual(bindingGroupsFor(data, { surfaceId: "new:service" })[0].entries, [["OPAQUE", "value"]]);
  assert.deepEqual(bindingGroupsFor(data, { surfaceId: "missing" }), []);
});

test("failed, absent and unknown provider reads never become measured zero counts", () => {
  const surface = { id: "slack", name: "Slack", state: "ready" };
  for (const providers of [{}, { slack: { status: "error", available: false, channels: [], messageCount: 0, error: "HTTP 503" } }]) {
    assert.equal(surfaceResources({ providers }, surface).available, false);
    assert.deepEqual(surfaceResources({ providers }, surface).resources, []);
  }
  assert.equal(surfaceResources({ providers: { future: { status: "ready" } } }, { id: "future" }).available, false);
  const measured = surfaceResources({ providers: { slack: { status: "ready", available: true, channels: [], messageCount: 0 } } }, surface);
  assert.deepEqual(measured.resources.map((row) => row.count), [0, 0]);
});

test("partial and failed collection reads retain their measured state", () => {
  const result = surfaceResources({ providers: { stripe: { status: "ready", available: true, customers: [], invoices: [{ id: "one" }],
    collectionStatus: { customers: { status: "failed", error: "HTTP 500" }, invoices: { status: "partial" } } } } }, { id: "stripe" });
  assert.deepEqual(result.resources.map(({ count, status }) => ({ count, status })), [{ count: null, status: "unavailable" }, { count: null, status: "partial" }]);
});

test("modern partial providers retain successful counts despite optional errors", () => {
  const result = surfaceResources({ providers: {
    errors: [{ provider: "notion", message: "Admin token unavailable" }],
    notion: { status: "partial", available: true, pages: [{ id: "page" }], databases: [],
      collectionStatus: { pages: { status: "complete" }, databases: { status: "failed", error: "HTTP 403" } } },
  } }, { id: "notion", name: "Notion" });
  assert.equal(result.available, true);
  assert.deepEqual(result.resources.map(row => row.count), [1, null]);
});

test("Gmail resource counts use labelled mailbox estimates, not preview lengths", () => {
  const result = surfaceResources({ providers: { gmail: { status: "ready", available: true,
    inbox: { messages: [{ id: "preview" }], resultSizeEstimate: 145 }, sent: { messages: [], resultSizeEstimate: 80 } } } }, { id: "google" });
  assert.deepEqual(result.resources.map(({ count, status }) => ({ count, status })), [{ count: 145, status: "estimate" }, { count: 80, status: "estimate" }]);
});

test("people counts and filters distinguish the primary organization from the world", () => {
  const data = { world: { organizationId: "primary", organizationPeople: 1, worldPeople: 2 },
    people: [{ id: "a", name: "Ada", organization_id: "primary" }, { id: "b", name: "Bela", organization_id: "customer" }] };
  assert.deepEqual(peopleSelection(data, { organizationId: "primary" }).people.map((row) => row.id), ["a"]);
  assert.deepEqual(peopleSelection(data, { query: "Bela" }).people.map((row) => row.id), ["b"]);
  assert.equal(peopleSelection(data).worldPeople, 2);
  assert.equal(peopleSelection(data).organizationPeople, 1);
});

test("a world without organizations retains its title and all people without an invented organization count", () => {
  const data = { world: { id: "world.uncommon", version: "v4", title: "Independent people", organizationId: null,
    organizationPeople: 0, worldPeople: 2 }, organizations: [],
    people: [{ id: "person.tavi", name: "Tavi", organization_id: null }, { id: "person.ren", name: "Ren" }] };
  const before = structuredClone(data);
  assert.deepEqual(worldLabels(data), { organization: null, heading: "Independent people", detail: "world.uncommon:v4" });
  const all = peopleSelection(data);
  assert.equal(all.worldPeople, 2);
  assert.equal(all.organizationPeople, null);
  assert.equal(all.organizationSummary, "No primary organization declared");
  assert.equal(all.summary, "2 in the world");
  assert.deepEqual(all.organizations, [{ id: NO_ORGANIZATION, name: "No organization" }]);
  assert.deepEqual(peopleSelection(data, { organizationId: NO_ORGANIZATION, query: "Ren" }).people.map(row => row.id), ["person.ren"]);
  assert.deepEqual(data, before, "Display and filtering must not change canonical records");
});

test("unnamed organizations show their ID, and unassigned people remain a separate selectable group", () => {
  const data = { world: { id: "world.uncommon", version: "v4", organizationId: "org.47" },
    organizations: [{ id: "org.47" }], people: [{ id: "person.tavi", name: "Tavi", organization_id: "org.47" },
      { id: "person.ren", name: "Ren", organization_id: null }] };
  assert.deepEqual(worldLabels(data), { organization: "org.47", heading: "org.47", detail: "world.uncommon:v4" });
  const selected = peopleSelection(data, { organizationId: "org.47" });
  assert.equal(selected.organizationPeople, 1);
  assert.equal(selected.summary, "1 in org.47 · 2 in the world");
  assert.deepEqual(selected.organizations, [{ id: "org.47", name: "org.47" }, { id: NO_ORGANIZATION, name: "No organization" }]);
  assert.deepEqual(selected.people.map(row => row.id), ["person.tavi"]);
  assert.deepEqual(peopleSelection(data, { organizationId: NO_ORGANIZATION }).people.map(row => row.id), ["person.ren"]);
});

test("a world without a title uses its identity, while a declared organization keeps its authored name", () => {
  assert.deepEqual(worldLabels({ world: { id: "world.empty", version: "v1", title: "" } }),
    { organization: null, heading: "world.empty:v1", detail: "world.empty:v1" });
  const data = { world: { id: "world.named", version: "v2", title: "A working week", organizationId: "org.named", company: "Named Company" } };
  assert.deepEqual(worldLabels(data), { organization: "Named Company", heading: "Named Company", detail: "A working week · world.named:v2" });
  assert.equal(peopleSelection({ world: { id: "world.empty", version: "v1" }, people: [] }).summary, "0 in the world");
});

test("an authored organization named all remains distinct from all-people and no-organization filters", () => {
  const data = { world: { organizationId: "all" }, organizations: [{ id: "all" }, { id: "org.other", name: "Other" }],
    people: [{ id: "person.one", name: "One", organization_id: "all" },
      { id: "person.two", name: "Two", organization_id: "org.other" },
      { id: "person.three", name: "Three", organization_id: null }, { id: "person.four", name: "Four" }] };
  assert.deepEqual(peopleSelection(data, { organizationId: "all" }).people.map(row => row.id), ["person.one"]);
  assert.equal(peopleSelection(data, { organizationId: ALL_ORGANIZATIONS }).people.length, 4);
  assert.deepEqual(peopleSelection(data, { organizationId: NO_ORGANIZATION }).people.map(row => row.id), ["person.three", "person.four"]);
  assert.deepEqual(peopleSelection(data).organizations.map(row => row.id), ["all", "org.other", NO_ORGANIZATION]);
  assert.equal(peopleSelection(data).organizationPeople, 1);
});

test("examples depend on selected capabilities even when stale bindings remain", () => {
  const data = { surfaces: [{ id: "http", capabilities: ["http.public-site.v1"] }], providers: { website: { previewPath: "/p3/kind" } }, bindings: { SITE_BASE_URL: "http://site.test", SLACK_BASE_URL: "http://slack.test", SLACK_TOKEN: "token" } };
  const examples = overviewExamples(data);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].surface, "http");
  assert.match(examples[0].command, /'\/p3\/kind'/);
  assert.ok(!examples.some((entry) => entry.command.includes("SLACK")));
  data.surfaces[0].capabilities = ["http.metrics.v1"];
  assert.ok(!overviewExamples(data).some((entry) => entry.surface === "http"));
  data.surfaces = [{ id: "slack", capabilities: ["slack.messaging.v1"] }];
  assert.equal(overviewExamples(data)[0].surface, "slack");
  assert.match(overviewExamples(data)[0].command, /conversations\.list/);
});

test("HTTP examples require a declared preview path and retain an authored root", () => {
  const data = { surfaces: [{ id: "http", capabilities: ["http.public-site.v1"] }], bindings: { SITE_BASE_URL: "http://site.test" } };
  assert.ok(!overviewExamples(data).some(entry => entry.surface === "http"));
  data.providers = { website: { previewPath: "/" } };
  assert.match(overviewExamples(data)[0].command, /'\/'$/);
});
