# WorldFixture S3 service

This document is for contributors who run S3 by itself. For product use, start
with the [five-minute quick start](../../docs/getting-started/quick-start.md).

This service turns one world's AWS projection into a working S3 service.
SeaweedFS is the only object store. All state is under `/tmp/seaweedfs`, the
fixture has no persistent volume, and every object dies with the session.

The image contains no world-specific object data. Every bucket and every object
comes from `$WORLDFIXTURE_WORLD_PATH/projections/aws.json` at startup.
Startup fails if that projection is not there.

## What the world decides

| Thing | Where it comes from |
| --- | --- |
| Buckets | one per `s3.buckets[]` record, by `name` |
| Objects | one per `s3.objects[]` record |
| Key | the record's `key`, which the compiler derives from the document id and the document name's own suffix |
| Bytes | the record's `content`, byte for byte, with no trailing newline added |
| `Content-Type` | the record's `content_type`, which is the document's `mime_type` |
| `x-amz-meta-last-modified` | the record's `last_modified`, which is the document's `modified_at` |
| `x-amz-meta-owner` | the record's `owner`, which is the owning person's login — the same string this projection's IAM users are named by |

A world's `communication.documents` become objects in its documents bucket:
eight in `northstar-relay-documents` for the default world
`business.saas-company:v3`, and two for `business.saas-company:v2`, which is the
world the commands below build. Seeding reads no clock.

### The exports bucket is empty, and that is a world-data finding

`northstar-relay-exports` is declared and created, and nothing is in it. The work
pack's `task-cancel-cleanup` says a cancelled export "leaves a partial object" in
that bucket, but **no world record declares that object**. The compiler projects
records, not prose, so it does not invent one, and the protocol test asserts the
bucket is empty rather than papering over the gap.

This is a gap in the world data, for the world's author to close: if the story
needs a partial export object, a world record has to declare it. Until then the
story and the artifact disagree, and the artifact is the honest one.

## What this SeaweedFS build does about signatures

Measured against this exact image, not assumed:

| Request | Result |
| --- | --- |
| Correct AWS SigV4 header | 200 |
| No `Authorization` header at all | 200 |
| SigV4 header with the signature replaced by `fff…` | 200 |
| Presigned URL query with a forged signature and an expiry in 2020 | 200 |

**There is no authentication on this endpoint.** The service runs
`-iam=false -s3.iam=false` with no `-s3.config` identity file, which leaves the S3
API with no identity at all. A signature is neither required nor verified, and a
presigned URL's expiry is not honoured either.

The protocol test asserts the four rows above. A presigned URL proves only that
the application created one; it does not protect data in this configuration. A
build that starts to enforce signatures will fail the test instead of silently
changing the contract.

`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are still generated for the
session and handed to the application, because an S3 client cannot be constructed
without them. The server ignores them. They are not a security boundary and
nothing here should be pointed at real data.

One more identity-shaped limitation: `ListBuckets` (`GET /`) answers `200` with an
**empty** bucket list, because the listing is scoped to the caller's identity and
there is none. Every declared bucket is there — `HEAD /<bucket>` and
`ListObjectsV2` both work — but a client that enumerates buckets sees nothing. The
protocol test asserts this too, so it becomes visible if it ever changes.

## Ports

| Container port | Name | Product access |
| --- | --- | --- |
| 61006 | S3 API | Dynamic host port in `S3_BASE_URL` |
| 61004 | filer UI and readiness | Internal container URL only |

All eight listeners — master, volume, filer and S3, HTTP and gRPC — take their
ports from the session. The image's `ENV` values exist so the image can be
inspected and so a direct local run fails on a collision instead of quietly
picking an upstream default.

Readiness is `GET /worldfixture/ready` on the filer port. It is a document the
entry point writes **after** seeding finishes, naming the fixture and the counts
it seeded:

```json
{"source":"worldfixture-s3","ready":true,"buckets":2,"objects":2}
```

The counts are the mounted world's, so that document reads `"objects":8` for the
default world and `"objects":2` for the `v2` world the run below mounts.

That replaces the old `/healthz` probe deliberately. This artifact once shipped
unable to store any object at all while `/healthz`, the filer UI and bucket
listing all answered normally, so a liveness probe is exactly the probe that
missed the only failure this fixture has actually had.

## Run it

```text
PYTHONPATH=compiler python3 -m worldfixture_compiler build \
  worlds/business.saas-company.v2/world.json --output /tmp/wf-s3

cd emulators/s3
docker build --platform=linux/amd64 -t worldfixture-s3:test .
docker run -d --name worldfixture-s3-test \
  -v /tmp/wf-s3:/world:ro -e WORLDFIXTURE_WORLD_PATH=/world \
  -p 127.0.0.1:4990:61006 -p 127.0.0.1:4991:61004 \
  worldfixture-s3:test
```

The S3 API is then on `http://127.0.0.1:4990/` and readiness on
`http://127.0.0.1:4991/worldfixture/ready`. These URLs use standalone protocol-test
ports. A normal WorldFixture run assigns a dynamic S3 host port. Read it from
`S3_BASE_URL`. Filer readiness stays internal.

## The protocol test

Run from the repository root:

```text
node emulators/s3/test/protocol-test.mjs
```

It boots its own service: it builds the artifact, starts the container, waits for
the seed, asserts, and removes the container again — including when an assertion
fails. `WORLDFIXTURE_ARTIFACT` points it at an artifact you already built,
`WORLDFIXTURE_S3_IMAGE` at another image tag, `TEST_S3_PORT` and `TEST_FILER_PORT`
at other ports in 4990-4999.

It refuses to test a service it did not start. The ports must be free before it
starts, the container it started has to still be running when readiness answers,
and the readiness document has to name this fixture and agree with the
projection's own bucket and object counts.

Over the real S3 API, with every request in the happy path signed with a real
SigV4 header computed in the test:

- every declared bucket exists, and a bucket the world never declared is a 404;
- every seeded object is listed with the world's byte size, and fetches with the
  world's exact bytes, its `Content-Type`, its md5 `ETag`, and the world's
  `last_modified` and `owner` in user metadata;
- the exports bucket is empty;
- put, get and delete round-trip, and the bucket's key count returns to zero; and
- the four signature rows above hold.

## Determinism

Seeding reads no clock. The bucket set, the object set, every key, every byte,
every content type and the world timestamp each object carries are functions of
the projection alone.

Verified: two fresh containers were started from one artifact and each was dumped
over the S3 API — every bucket listing, and for every object its
`Content-Type`, `Content-Length`, `ETag`, `x-amz-meta-*` and its bytes. The two
dumps are byte-identical (1851 bytes, sha256
`f000376965df0458acd13c348028b843ac02c249d0d4873936d44bd446d216b8` in both).

What is *not* identical between runs is SeaweedFS's own `Last-Modified`, on both
the object and its listing. The filer stamps `Mtime` from `time.Now()` on every
write and no HTTP parameter overrides it, so the world's authored time cannot be
the object's `Last-Modified` — which is why it is carried as
`x-amz-meta-last-modified` instead, where a client can read it back and where it
is stable. Slack, GitHub, and mail have the same wall-clock limit.

Seeding is also idempotent. Re-running the entry point re-creates the buckets
(`BucketAlreadyOwnedByYou` is accepted, not treated as a failure) and re-`PUT`s
the objects, which is a no-op on the bytes.

## `master.toml`, and why it is not a tuning knob

An S3 bucket is a SeaweedFS collection, and the master grows a collection by
`copy_1` volumes at once. Upstream's `copy_1` is 7 and `weed server`'s
`-volume.max` defaults to 8, so measured on this image: the first bucket written
to takes **seven** of the eight slots and the second takes the last one. Nothing
is left. A third bucket, or any write outside a bucket, then fails with

```text
failed to find writable volumes for collection: ... no free volumes left
```

while `/healthz`, the filer UI and bucket listing all keep answering. That is the
same failure shape the image comment records for `-volume.max=1`.

`master.toml` sets `copy_1 = 1`, so the slot budget scales with the number of
buckets the world declares instead of with an upstream constant. Volumes still
grow on demand up to `-volume.max`, which stays at upstream's default.

## Pins and provenance

| Component | Repository | Version | License |
| --- | --- | --- | --- |
| SeaweedFS | `https://github.com/seaweedfs/seaweedfs` | `4.41`, revision `de34a1a87c02893507f961cda9574172ee5064e9` | Apache-2.0 |
| jq | `https://github.com/jqlang/jq` | Alpine package `1.8.2-r0` | MIT |

- Pinned linux/amd64 image manifest:
  `sha256:3bbe24f6d5f5818327adcfeda7d85240ed53212dab05f91af14484c6446ec5eb`
- Official multi-platform image index:
  `sha256:43b768cd62b00d132439cda881b93fd1adebf1b315e996e794087743821d771d`

This service image is amd64-only. WorldFixture supports arm64 hosts by running
this service under emulation.

`emulator.json` records the upstream repositories, versions, licences and the
runtime contract. `THIRD_PARTY_NOTICES.md` records the Apache-2.0 attribution and
the notice of change Apache-2.0 requires; the upstream image ships no copyright
file, so there is none to preserve inside the image.

## Security boundary

- There is no authentication. See the signature table above.
- The mounted world is read-only to this fixture and is read once, at startup.
- Telemetry, Iceberg, WebDAV, SFTP and the IAM management API are disabled.
- All state is in `/tmp` and ends with the session. No volume is attached.
- A bucket name outside `[a-z0-9.-]`, or an object key outside `[A-Za-z0-9._/-]`,
  is refused at startup rather than escaped or guessed at.
