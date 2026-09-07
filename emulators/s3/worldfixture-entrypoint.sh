#!/bin/sh
set -eu
if [ -z "${WORLDFIXTURE_WORLD_PATH:-}" ]; then
  echo "worldfixture: missing world: WORLDFIXTURE_WORLD_PATH is required" >&2
  exit 64
fi

required='WORLDFIXTURE_MASTER_PORT WORLDFIXTURE_MASTER_GRPC_PORT WORLDFIXTURE_VOLUME_PORT WORLDFIXTURE_VOLUME_GRPC_PORT WORLDFIXTURE_FILER_PORT WORLDFIXTURE_FILER_GRPC_PORT WORLDFIXTURE_S3_PORT WORLDFIXTURE_S3_GRPC_PORT WORLDFIXTURE_WORLD_PATH AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY'

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
umask 077
mkdir -p "$data_dir" "$seed_dir"

# The projection is read once, before the server starts, so a malformed world
# fails the container instead of half-seeding a running one.
jq -e '.s3.buckets | type == "array" and length > 0' "$projection" >/dev/null \
  || { echo "projections/aws.json declares no s3.buckets" >&2; exit 64; }
jq -r '.s3.buckets[].name' "$projection" > "$seed_dir/buckets.txt"
jq -r '(.s3.objects // []) | length' "$projection" > "$seed_dir/object-count"
object_count=$(cat "$seed_dir/object-count")
bucket_count=$(wc -l < "$seed_dir/buckets.txt" | tr -d ' ')

# Static credentials use SeaweedFS's supported S3 identity configuration. The
# embedded IAM API stays disabled. Seed requests use the same run identity as
# application requests, so bucket ownership and ListBuckets agree.
region=$(jq -er '.region // .s3.buckets[0].region | select(type == "string" and test("^[a-z0-9-]+$"))' "$projection")
jq -n '{identities: [{name: "worldfixture-run", credentials: [{accessKey: env.AWS_ACCESS_KEY_ID, secretKey: env.AWS_SECRET_ACCESS_KEY}], actions: ["Admin"]}]}' > "$seed_dir/identity.json"
jq -nr --arg region "$region" '
  "user = " + ((env.AWS_ACCESS_KEY_ID + ":" + env.AWS_SECRET_ACCESS_KEY) | tojson),
  "aws-sigv4 = " + (("aws:amz:" + $region + ":s3") | tojson)
' > "$seed_dir/curl.conf"
# Prevent SeaweedFS from adding a second environment-based identity or logging
# its access key. Both private files remain in the owned reset snapshot.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

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

proxy_pids=""
server_pid=""
terminate() {
  for pid in $proxy_pids; do kill -TERM "$pid" 2>/dev/null || true; done
  if [ -n "$server_pid" ]; then kill -TERM "$server_pid" 2>/dev/null || true; fi
}

wait_children() {
  for pid in $proxy_pids; do wait "$pid" 2>/dev/null || true; done
  if [ -n "$server_pid" ]; then wait "$server_pid" 2>/dev/null || true; fi
}

shutdown() {
  # The supervisor treats this shell's exit as proof that the service stopped.
  # Do not exit while SeaweedFS still owns its ports; reset starts this command
  # again as soon as the child record exits.
  trap - INT TERM
  terminate
  wait_children
  exit 0
}
trap shutdown INT TERM

fail() {
  echo "$1" >&2
  terminate
  wait_children
  exit 1
}

# Start forwarding before SeaweedFS can answer readiness. A restored seed gate
# can answer as soon as the filer starts, and the image probes S3 on loopback.
# Starting the relay after those checks lets reset return an unreachable S3 URL.
# A specific container address avoids colliding with SeaweedFS on loopback.
bind=${WORLDFIXTURE_S3_BIND:-127.0.0.1}
case "$bind" in
  127.0.0.1) addresses="" ;;
  0.0.0.0) addresses=$(hostname -i) ;;
  *) echo "unsupported S3 bind: $bind" >&2; exit 64 ;;
esac
for address in $addresses; do
  case "$address" in
    127.*|*:*|localhost) continue ;;
  esac
  # Raw TCP forwarding preserves signed paths, headers, bodies, and streaming.
  socat "TCP4-LISTEN:$WORLDFIXTURE_S3_PORT,bind=$address,reuseaddr,fork" \
    "TCP4:127.0.0.1:$WORLDFIXTURE_S3_PORT" &
  proxy_pid=$!
  proxy_pids="$proxy_pids $proxy_pid"
  attempt=0
  until socat -T 1 -u "TCP4:$address:$WORLDFIXTURE_S3_PORT,connect-timeout=1" \
      OPEN:/dev/null 2>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 120 ] || ! kill -0 "$proxy_pid" 2>/dev/null; then
      fail "S3 HTTP forwarding did not start"
    fi
    sleep 0.25
  done
  kill -0 "$proxy_pid" 2>/dev/null || fail "S3 HTTP forwarding stopped"
done
if [ "$bind" = "0.0.0.0" ] && [ -z "$proxy_pids" ]; then
  fail "S3 forwarding requires a container IPv4 address"
fi

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
# All SeaweedFS HTTP and gRPC APIs stay on loopback. The relay forwards S3
# HTTP alone: SeaweedFS 4.41 shares its S3 bind flag with S3 gRPC.
/usr/bin/weed -logtostderr=true server \
  -dir="$data_dir" \
  -volume.fileSizeLimitMB=64 \
  -volume.minFreeSpace=16MiB \
  -volume.preStopSeconds=0 \
  -master.volumeSizeLimitMB=128 \
  -master.volumePreallocate=false \
  -master.telemetry=false \
  -ip=127.0.0.1 \
  -ip.bind=127.0.0.1 \
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
  -s3.config="$seed_dir/identity.json" \
  -s3.ip.bind=127.0.0.1 \
  -s3.port="$WORLDFIXTURE_S3_PORT" \
  -s3.port.grpc="$WORLDFIXTURE_S3_GRPC_PORT" \
  -s3.port.iceberg=0 \
  -s3.concurrentFileUploadLimit=4 \
  -s3.concurrentUploadLimitMB=128 &
server_pid=$!

attempt=0
until wget -q -O /dev/null "$filer/healthz"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ] || ! kill -0 "$server_pid" 2>/dev/null; then
    fail "SeaweedFS filer did not start"
  fi
  sleep 0.25
done

attempt=0
until [ "$(curl -K "$seed_dir/curl.conf" -s -o /dev/null -w '%{http_code}' "$s3/")" = "200" ]; do
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
  code=$(curl -K "$seed_dir/curl.conf" -sS -o /dev/null -w '%{http_code}' -X PUT "$s3/$bucket")
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
  # Older curl versions in the combined image need the explicit file payload
  # hash. Without it, SeaweedFS refuses the signed PUT with SignatureDoesNotMatch.
  code=$(curl -K "$seed_dir/curl.conf" -sS -o /dev/null -w '%{http_code}' -X PUT \
    --data-binary "@$seed_dir/body" \
    -H "x-amz-content-sha256: $(sha256sum "$seed_dir/body" | cut -d ' ' -f 1)" \
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

# A failed relay is a failed service, including after startup.
while kill -0 "$server_pid" 2>/dev/null; do
  for pid in $proxy_pids; do
    kill -0 "$pid" 2>/dev/null || fail "S3 HTTP forwarding stopped"
  done
  sleep 1
done
terminate
wait "$server_pid"
