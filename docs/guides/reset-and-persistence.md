# Reset and persistence

`npx worldfixture reset` restores provider, Local Mail, S3, HTTP target,
runtime, clock, timeline, and event state to the accepted start. It then checks
readiness and returns proof of the accepted state.

Provider APIs restore their accepted service snapshots. Local Mail, S3, and
HTTP targets restart from their prepared projections. HTTP
request counters, page variants, and flapping probe positions return to their
start values.

PostgreSQL and MariaDB are different. A normal reset preserves their data. The
application connector also declares database reset unavailable. WorldFixture
does not truncate an application database.

`npx worldfixture down` stops and removes the container. It keeps local
diagnostic files in `.worldfixture/`.
