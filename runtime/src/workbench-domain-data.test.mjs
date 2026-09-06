import assert from "node:assert/strict";
import test from "node:test";
import { domainCollectionPath, readDomainOverview, validateDomainPage } from "./workbench-domain-data.mjs";

const world = { id: "source.test", version: "v1", artifact_sha256: "a".repeat(64) };
const row = index => ({ name: `work.collection_${index}`, count: index, writable: false, id_field: "id" });
const page = (data, more, next, total) => ({ data, has_more: more, next_cursor: next, total_count: total, world });

test("domain metadata reads every page and retains measured empty collections", async () => {
  const calls = [];
  const result = await readDomainOverview(async path => {
    calls.push(path);
    return calls.length === 1 ? page(Array.from({ length: 100 }, (_, index) => row(index)), true, "after-100", 101)
      : page([row(100)], false, null, 101);
  });
  assert.equal(result.collections.length, 101);
  assert.equal(result.collections[0].count, 0);
  assert.equal(result.collectionStatus.collections.status, "complete");
  assert.match(calls[1], /cursor=after-100/);
  assert.deepEqual(result.world, world);
});

test("domain later-page failures retain rows but do not report complete counts", async () => {
  let calls = 0;
  const result = await readDomainOverview(async () => {
    if (++calls === 1) return page([row(0)], true, "next", 2);
    throw new Error("service disconnected");
  });
  assert.deepEqual(result.collections, [row(0)]);
  assert.equal(result.collectionStatus.collections.status, "failed");
  assert.match(result.collectionStatus.collections.error, /service disconnected/);
});

test("domain pagination rejects repeated cursors, changed totals, and incomplete metadata", async () => {
  let calls = 0;
  const repeated = await readDomainOverview(async () => page([row(calls++)], true, "same", 10));
  assert.match(repeated.collectionStatus.collections.error, /repeated/);
  calls = 0;
  const changed = await readDomainOverview(async () => ++calls === 1 ? page([row(0)], true, "next", 2) : page([row(1)], false, null, 3));
  assert.match(changed.collectionStatus.collections.error, /changed/);
  assert.throws(() => validateDomainPage({ data: [], total_count: 0 }), /pagination metadata/);
});

test("domain detail paths retain opaque IDs without permitting collection path traversal", () => {
  assert.equal(domainCollectionPath("commerce.orders", "order.47/a b"), "/v1/collections/commerce.orders/order.47%2Fa%20b");
  assert.throws(() => domainCollectionPath("../events"), /collection name/);
  assert.throws(() => domainCollectionPath("commerce.orders", ""), /record ID/);
});
