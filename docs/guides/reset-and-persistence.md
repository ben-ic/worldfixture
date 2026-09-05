# Reset and persistence

`npx worldfixture reset` restores provider, Local Mail, S3, HTTP target,
runtime, clock, timeline, and event state to the accepted start. It then checks
readiness and returns proof of the accepted state.

The provider composer restores its accepted in-memory store snapshot. Local
Mail, S3, and HTTP targets restart from their immutable projections. HTTP
request counters, page variants, and flapping probe positions return to their
start values.

PostgreSQL and MySQL are different. A normal reset preserves their data. The
application connector also declares database reset unavailable. WorldFixture
does not truncate an application database.

`npx worldfixture down` stops and removes the container. It keeps local
diagnostic files in `.worldfixture/`.
