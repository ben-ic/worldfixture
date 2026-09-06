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

Reset also preserves accepted connector receipts. A repeated timeline event does
not repeat an application write that was already accepted. Provider records can
be restored and delivered again. See [Timeline controls](./timeline.md).

Use **Choose world** in the Workbench or `worldfixture switch <world>` to change
the active artifact. A switch removes manual provider changes, creates new
credentials, and preserves application database services. The new timeline stays
in setup until you confirm the application connection. Reset before confirmation
keeps this delivery gate. See [Switch a running world](./worlds.md#switch-a-running-world).

`npx worldfixture down` stops and removes the container. It keeps local
diagnostic files in `.worldfixture/`.
