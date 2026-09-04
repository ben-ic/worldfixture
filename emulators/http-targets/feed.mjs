export function availableFeedItems(feed, elapsedSeconds) {
  return feed.items.filter((item) =>
    (item.available_after_seconds ?? 0) <= elapsedSeconds
  );
}

// THE CLOCK IS A PARAMETER, not a read of the wall clock buried in the render
// path. `available_after_seconds` is session-relative, so deciding what has
// arrived means asking the time -- and a test that asks the real time can only
// observe an arrival by sleeping for it.
//
// There is no runtime clock to read yet, so the default is `Date.now` and
// nothing about the running fixture changes. When the runtime arrives it passes
// its own `now` here, which is the whole extent of the seam: one default
// parameter, no clock object and no injection point to configure.
export function feedItemsAt(feed, startedAt, now = Date.now) {
  return availableFeedItems(feed, Math.floor((now() - startedAt) / 1000));
}
