#!/bin/sh
set -eu

required='WORLDFIXTURE_MASTER_PORT WORLDFIXTURE_MASTER_GRPC_PORT WORLDFIXTURE_VOLUME_PORT WORLDFIXTURE_VOLUME_GRPC_PORT WORLDFIXTURE_FILER_PORT WORLDFIXTURE_FILER_GRPC_PORT WORLDFIXTURE_S3_PORT WORLDFIXTURE_S3_GRPC_PORT WORLDFIXTURE_WORLD_PATH'

for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "missing required session value: $name" >&2
    exit 64
  fi
done

# Nothing about the object store is compiled into this image. Every bucket and
# every object comes from the mounted world, so a missing projection is a
# startup failure rather than an empty fixture that looks like it worked.
projection="$WORLDFIXTURE_WORLD_PATH/projections/aws.json"
if [ ! -f "$projection" ]; then
  echo "WORLDFIXTURE_WORLD_PATH has no projections/aws.json" >&2
  exit 64
fi

filer="http://127.0.0.1:$WORLDFIXTURE_FILER_PORT"
s3="http://127.0.0.1:$WORLDFIXTURE_S3_PORT"
data_dir=/tmp/seaweedfs
seed_dir=/tmp/worldfixture-s3
mkdir -p "$data_dir" "$seed_dir"

# The projection is read once, before the server starts, so a malformed world
# fails the container instead of half-seeding a running one.
jq -e '.s3.buckets | type == "array" and length > 0' "$projection" >/dev/null \
  || { echo "projections/aws.json declares no s3.buckets" >&2; exit 64; }
jq -r '.s3.buckets[].name' "$projection" > "$seed_dir/buckets.txt"
jq -r '(.s3.objects // []) | length' "$projection" > "$seed_dir/object-count"
object_count=$(cat "$seed_dir/object-count")
bucket_count=$(wc -l < "$seed_dir/buckets.txt" | tr -d ' ')

# A bucket name and an object key both end up in a URL path and in a shell
# variable. Refuse anything outside the character set this fixture can carry
# without escaping, rather than guessing at an encoding and seeding something
# the world did not declare.
while IFS= read -r bucket; do
  case "$bucket" in
    ''|*[!a-z0-9.-]*) echo "invalid S3 bucket name: $bucket" >&2; exit 64 ;;
  esac
done < "$seed_dir/buckets.txt"

index=0
while [ "$index" -lt "$object_count" ]; do
  key=$(jq -r --argjson i "$index" '.s3.objects[$i].key' "$projection")
  bucket=$(jq -r --argjson i "$index" '.s3.objects[$i].bucket' "$projection")
  case "$key" in
    ''|/*|*//*|*[!A-Za-z0-9._/-]*) echo "invalid S3 object key: $key" >&2; exit 64 ;;
  esac
  grep -qxF "$bucket" "$seed_dir/buckets.txt" \
    || { echo "object $key names undeclared bucket $bucket" >&2; exit 64; }
  index=$((index + 1))
done

terminate() {
  kill -TERM "$server_pid" 2>/dev/null || true
}

shutdown() {
  # The supervisor treats this shell's exit as proof that the service stopped.
  # Do not exit while SeaweedFS still owns its ports; reset starts this command
  # again as soon as the child record exits.
  trap - INT TERM
  terminate
  wait "$server_pid" 2>/dev/null || true
  exit 0
}
trap shutdown INT TERM

# WHERE THE SPACE BOUND ACTUALLY COMES FROM, since it is not this command.
#
# An emulator runs with a read-only rootfs, so the agent mounts scratch tmpfs at /tmp
# and /run sized `memory / (2 * mounts)` and capped at 256 MB. All SeaweedFS state
# lives under /tmp/seaweedfs, so the store is RAM-backed and already bounded by the
# platform — and filling it costs the µVM memory rather than disk, which is the
# worse failure.
#
# So `-volume.max` is not a space control and never was. It gates how many
# COLLECTIONS can exist, and an S3 bucket is a collection: at `-volume.max=1` the one
# slot was consumed before the first bucket, and every write failed while /healthz,
# the filer UI and bucket listing all answered normally. The flag is left unset —
# upstream's default of 8 is ample once a collection stops claiming seven slots at
# once, which is what `master.toml` fixes. See that file; the default breaks a
# world with three buckets, and this world has two.
#
# `-volume.minFreeSpace` is the control that matters here. SeaweedFS marks volumes
# read-only as the device fills instead of failing raggedly at ENOSPC, which on a
# tmpfs is the difference between a fixture that stops accepting uploads and a µVM
# under memory pressure. 16 MiB of the ~128-256 MB scratch.
#
# THE BRIDGE, because this listener's surface is published. An app signs a URL
# against this endpoint and hands it to the visitor's browser, so the endpoint has to
# be somewhere a browser can reach. Bound to loopback it produced exactly the failure
# the profile's own test warns about: a hostname that resolves, routes, and answers
# nothing.
#
# WHAT THE SIGNATURE DOES, measured against this build rather than assumed:
# `-s3.iam=false` with no `-s3.config` leaves the S3 endpoint with no identity at
# all. Every request is served, signed correctly or not, and a presigned URL's
# signature and expiry are both ignored. README.md states this plainly; nothing here
# authenticates anything.
/usr/bin/weed -logtostderr=true server \
  -dir="$data_dir" \
  -volume.fileSizeLimitMB=64 \
  -volume.minFreeSpace=16MiB \
  -volume.preStopSeconds=0 \
  -master.volumeSizeLimitMB=128 \
  -master.volumePreallocate=false \
  -master.telemetry=false \
  -ip=127.0.0.1 \
  -ip.bind=0.0.0.0 \
  -master.port="$WORLDFIXTURE_MASTER_PORT" \
  -master.port.grpc="$WORLDFIXTURE_MASTER_GRPC_PORT" \
  -volume.port="$WORLDFIXTURE_VOLUME_PORT" \
  -volume.port.grpc="$WORLDFIXTURE_VOLUME_GRPC_PORT" \
  -volume.publicUrl="127.0.0.1:$WORLDFIXTURE_VOLUME_PORT" \
  -filer \
  -filer.port="$WORLDFIXTURE_FILER_PORT" \
  -filer.port.grpc="$WORLDFIXTURE_FILER_GRPC_PORT" \
  -filer.concurrentFileUploadLimit=4 \
  -filer.concurrentUploadLimitMB=128 \
  -s3 \
  -iam=false \
  -s3.iam=false \
  -s3.ip.bind=0.0.0.0 \
  -s3.port="$WORLDFIXTURE_S3_PORT" \
  -s3.port.grpc="$WORLDFIXTURE_S3_GRPC_PORT" \
  -s3.port.iceberg=0 \
  -s3.concurrentFileUploadLimit=4 \
  -s3.concurrentUploadLimitMB=128 &
server_pid=$!

fail() {
  echo "$1" >&2
  terminate
  wait "$server_pid" || true
  exit 1
}

attempt=0
until wget -q -O /dev/null "$filer/healthz"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    fail "SeaweedFS filer did not start"
  fi
  sleep 0.25
done

attempt=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$s3/")" = "200" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    fail "SeaweedFS S3 endpoint did not start"
  fi
  sleep 0.25
done

# A restored reset snapshot already contains every bucket, object, and the seed
# gate document. Do not write them again: a new PUT would give otherwise
# identical SeaweedFS state a new storage timestamp.
if [ ! -e "$seed_dir/seeded-v1" ]; then

# Seeding goes through the S3 API, not the filer directory API, for one reason:
# the filer write path drops `X-Amz-Meta-*` and the S3 write path keeps it. The
# world's own `last_modified` has to survive to something a client can read back,
# and this is the only header SeaweedFS carries through.
while IFS= read -r bucket; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$s3/$bucket")
  case "$code" in
    # 409 is BucketAlreadyOwnedByYou. Creating a bucket that is already there is
    # what an idempotent seed looks like on a restart, not a failure.
    200|409) ;;
    *) fail "creating bucket $bucket returned $code" ;;
  esac
done < "$seed_dir/buckets.txt"

index=0
while [ "$index" -lt "$object_count" ]; do
  bucket=$(jq -r --argjson i "$index" '.s3.objects[$i].bucket' "$projection")
  key=$(jq -r --argjson i "$index" '.s3.objects[$i].key' "$projection")
  content_type=$(jq -r --argjson i "$index" '.s3.objects[$i].content_type' "$projection")
  last_modified=$(jq -r --argjson i "$index" '.s3.objects[$i].last_modified' "$projection")
  owner=$(jq -r --argjson i "$index" '.s3.objects[$i].owner // ""' "$projection")
  # `jq -j` writes the string with no trailing newline of its own, so an object's
  # bytes are the projection's bytes and a document that does not end in a
  # newline does not acquire one.
  jq -j --argjson i "$index" '.s3.objects[$i].content' "$projection" > "$seed_dir/body"
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
    --data-binary "@$seed_dir/body" \
    -H "Content-Type: $content_type" \
    -H "X-Amz-Meta-Last-Modified: $last_modified" \
    -H "X-Amz-Meta-Owner: $owner" \
    "$s3/$bucket/$key")
  [ "$code" = "200" ] || fail "seeding $bucket/$key returned $code"
  index=$((index + 1))
done
rm -f "$seed_dir/body"

# Readiness is the seed, not the listener. The filer answers /healthz long before
# a single bucket exists, so a probe on /healthz says only that a process is up —
# and this fixture once shipped able to answer /healthz and unable to store an
# object at all. This document exists only after every declared bucket and object
# is in place, and it names the fixture and the counts it seeded, so a probe can
# tell this service apart from whatever else might be holding the port.
jq -n -c --argjson buckets "$bucket_count" --argjson objects "$object_count" \
  '{source: "worldfixture-s3", ready: true, buckets: $buckets, objects: $objects}' \
  > "$seed_dir/ready.json"
touch "$seed_dir/seeded-v1"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT \
  --data-binary "@$seed_dir/ready.json" \
  -H 'Content-Type: application/json' \
  "$filer/worldfixture/ready")
case "$code" in
  200|201) ;;
  *) fail "publishing readiness returned $code" ;;
esac
echo "worldfixture-s3: seeded $bucket_count buckets and $object_count objects from $projection"

else
  echo "worldfixture-s3: restored accepted storage snapshot"
fi

wait "$server_pid"
