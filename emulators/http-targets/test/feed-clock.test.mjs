import assert from "node:assert/strict";
import {test} from "node:test";

import {availableFeedItems, feedItemsAt} from "../feed.mjs";

// A SCHEDULED ARRIVAL IS THE ONE THING THIS FIXTURE DOES OVER TIME, and until the
// clock became a parameter the only way to observe it was to sleep for it. These
// tests hand `feedItemsAt` a clock that returns whatever the case needs, so the
// transition is asserted at the second it happens and the suite stays instant.
const feed = {
  items: [
    {id: "initial"},
    {id: "arrival", available_after_seconds: 10},
    {id: "late-arrival", available_after_seconds: 90},
  ],
};

const startedAt = 1_756_000_000_000;
const clock = (elapsedMs) => () => startedAt + elapsedMs;
const idsAt = (elapsedMs) => feedItemsAt(feed, startedAt, clock(elapsedMs)).map((item) => item.id);

test("only items with no arrival time are available at the start", () => {
  assert.deepEqual(idsAt(0), ["initial"]);
});

test("an item is still withheld one second before its arrival", () => {
  assert.deepEqual(idsAt(9_000), ["initial"]);
});

test("an item arrives on the second it is due", () => {
  assert.deepEqual(idsAt(10_000), ["initial", "arrival"]);
});

test("elapsed time floors to whole seconds, so a partial second does not arrive early", () => {
  assert.deepEqual(idsAt(9_999), ["initial"]);
  assert.deepEqual(idsAt(10_999), ["initial", "arrival"]);
});

test("arrivals accumulate and keep the authored order", () => {
  assert.deepEqual(idsAt(89_000), ["initial", "arrival"]);
  assert.deepEqual(idsAt(90_000), ["initial", "arrival", "late-arrival"]);
  assert.deepEqual(idsAt(3_600_000), ["initial", "arrival", "late-arrival"]);
});

test("the clock defaults to the wall clock when none is supplied", () => {
  assert.deepEqual(
    feedItemsAt(feed, Date.now() - 10_000).map((item) => item.id),
    ["initial", "arrival"],
  );
});

test("availableFeedItems still selects by elapsed seconds directly", () => {
  assert.deepEqual(availableFeedItems(feed, 9).map((item) => item.id), ["initial"]);
  assert.deepEqual(availableFeedItems(feed, 10).map((item) => item.id), ["initial", "arrival"]);
});
