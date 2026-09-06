import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createServer } from "@emulators/core";
import { VENDORS } from "../registry.mjs";
import { seedAtlasWebhooks } from "./mongoatlas.mjs";

test("Atlas alert controls send native monitoring facts and signed requests", async t => {
  const received = [];
  const receiver = httpServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received.push({ raw, headers: req.headers, method: req.method });
    res.writeHead(200).end();
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(() => receiver.close());
  const lifecycle = await VENDORS.mongoatlas.load();
  const server = createServer(lifecycle.plugin, { tokens: { token: { login: "admin", id: 1, scopes: [] } } });
  t.after(() => server.webhooks.atlasDelivery.close());
  const request = (path, method = "GET", body) => server.app.request(path, { method,
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const project = await (await request("/api/atlas/v2/groups", "POST", { name: "Fixture", orgId: "bbbbbbbbbbbbbbbbbbbbbbbb" })).json();
  seedAtlasWebhooks(server.store, { webhooks: [{ group_id: project.id, url: `http://127.0.0.1:${receiver.address().port}/atlas`, secret: "atlas-secret" }] });
  const alert = { id: "aaaaaaaaaaaaaaaaaaaaaaaa", groupId: project.id, eventTypeName: "OUTSIDE_METRIC_THRESHOLD", status: "OPEN",
    created: "2026-09-06T12:00:00Z", updated: "2026-09-06T12:00:00Z", humanReadable: "Disk use is 95%. Project: Fixture Organization: Test",
    metricName: "DISK_PARTITION_SPACE_USED_DATA", currentValue: { number: 95, units: "RAW" } };
  assert.equal((await request("/__worldfixture/mongoatlas/alerts", "POST", { event: "alert.open", alert })).status, 202);
  await server.webhooks.atlasDelivery.drain();
  assert.equal(received.length, 1);
  assert.deepEqual(JSON.parse(received[0].raw), alert);
  assert.equal(received[0].headers["x-mms-event"], "alert.open");
  assert.equal(received[0].headers["x-mms-signature"], createHmac("sha1", "atlas-secret").update(received[0].raw).digest("base64"));
  assert.equal(received[0].method, "POST");
  assert.equal(received[0].headers["content-type"], "application/json");
  assert.equal(received[0].headers.authorization, undefined);
  assert.deepEqual(await (await request(`/api/atlas/v2/groups/${project.id}/alerts/${alert.id}`)).json(), alert);
  assert.equal((await request("/__worldfixture/mongoatlas/alerts", "POST", { event: "alert.close", alert })).status, 400);
  assert.equal((await server.app.request("/__worldfixture/mongoatlas/alerts", { method: "POST", body: JSON.stringify({ event: "alert.open", alert }) })).status, 401);
  // The Atlas contract lists six header values. Configured severity is absent
  // from every webhook body, including acknowledgements and informational alerts.
  for (const [event, status] of [["alert.update", "OPEN"], ["alert.acknowledge", "OPEN"], ["alert.close", "CLOSED"], ["alert.cancel", "CANCELLED"], ["alert.inform", "INFORMATIONAL"]]) {
    const value = { ...alert, status };
    assert.equal((await request("/__worldfixture/mongoatlas/alerts", "POST", { event, alert: { ...value, severity: "CRITICAL" } })).status, 202);
    await server.webhooks.atlasDelivery.drain();
    const notification = received.at(-1);
    assert.deepEqual(JSON.parse(notification.raw), value);
    assert.equal(notification.headers["x-mms-event"], event);
    assert.equal(notification.headers["x-mms-signature"], createHmac("sha1", "atlas-secret").update(notification.raw).digest("base64"));
  }
  seedAtlasWebhooks(server.store, { webhooks: [] });
  await request("/__worldfixture/mongoatlas/alerts", "POST", { event: "alert.close", alert: { ...alert, status: "CLOSED" } });
  await server.webhooks.atlasDelivery.drain();
  assert.equal(received.length, 6);
});
