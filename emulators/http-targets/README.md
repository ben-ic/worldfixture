# WorldFixture HTTP targets

This document is for contributors who run HTTP targets by themselves. For
product use, start with the [five-minute quick start](../../docs/getting-started/quick-start.md).

This service turns one verified world projection into useful local HTTP
targets. It does not invent another company. It reads
`$WORLDFIXTURE_WORLD_PATH/projections/http-targets.json` and serves the same stories
as:

- an RSS feed;
- archivable and changing web pages;
- stable, failing, and request-sequenced health endpoints;
- Prometheus metrics;
- JSON API responses; and
- one OpenAPI 3 document.

RSS readers can subscribe to the feed. Page-change and archive tools can watch
the pages. Health monitors can call the stable, failing, and flapping endpoints.
Prometheus clients can read the metrics. OpenAPI tools can load the schema.
Dashboard applications can link to all of them.

The fixture keeps only request counters in memory. A restart resets page variants
and flapping probes. The verified world stays read-only and is never changed.
Feed items can declare `available_after_seconds`. The fixture exposes each item
only after that session-relative time. This is a bounded arrival timeline: an RSS
reader imports newly available records when the user refreshes it, while stable
GUIDs prevent duplicate items.

## Tests

Run these commands from `emulators/http-targets`. Both run with no dependencies
and no container.

```text
node test/protocol-test.mjs
node --test test/feed-clock.test.mjs
```

`test/protocol-test.mjs` starts `server.mjs` itself on `127.0.0.1:4971` against the
`test/self-test.json` fixture, exercises every route, and stops it again. Set
`TEST_PORT` to another port in 4970-4979, or `TEST_ORIGIN` to check a server that
is already running instead — which is how the connected image check runs it:

```text
docker exec worldfixture-http-targets-test node /opt/worldfixture-http-targets/test/protocol-test.mjs
```

`test/feed-clock.test.mjs` drives the scheduled feed arrivals with a fixed clock.
`feedItemsAt` takes the current time as a parameter defaulting to `Date.now`, so
each transition is asserted at the second it happens rather than waited out, and
the runtime can pass its own clock later without the fixture changing shape.

## Boundary

- The fixture accepts only `GET` and `HEAD`.
- It has no outbound network path in its code.
- It reads at most 4 MiB from one projection file.
- Every declared route must be an absolute local path.
- The world owns names, facts, and relationships. This fixture owns HTTP behavior.
