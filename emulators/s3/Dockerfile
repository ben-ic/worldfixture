# syntax=docker/dockerfile:1
# WorldFixture S3 — SeaweedFS 4.41, official linux/amd64 image manifest.
#
# This is an unlisted fixture. It joins a session's existing microVM and is never
# listed or launched as an application.
#
# Keep the amd64 child manifest as the first sha256 in this file. Fixture
# provenance reads the first image digest.
FROM --platform=linux/amd64 docker.io/chrislusf/seaweedfs@sha256:3bbe24f6d5f5818327adcfeda7d85240ed53212dab05f91af14484c6446ec5eb

ARG SOURCE_DATE_EPOCH=1787284800
ARG WORLDFIXTURE_SOURCE_COMMIT
ARG WORLDFIXTURE_SOURCE_TREE_SHA256
ARG WORLDFIXTURE_RUNTIME_CONTRACT_SHA256
LABEL org.opencontainers.image.revision="${WORLDFIXTURE_SOURCE_COMMIT}" \
      org.worldfixture.source.tree.sha256="${WORLDFIXTURE_SOURCE_TREE_SHA256}" \
      org.worldfixture.runtime.contract.sha256="${WORLDFIXTURE_RUNTIME_CONTRACT_SHA256}"

LABEL org.opencontainers.image.version="4.41" \
      org.opencontainers.image.source="https://github.com/seaweedfs/seaweedfs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.worldfixture.role="emulator"

# The base image carries no JSON reader, and the whole point of this fixture is
# that its buckets and objects come from a world projection read at runtime. The
# version is exact so an Alpine repository update fails the build instead of
# changing its bytes.
RUN apk add --no-cache jq=1.8.2-r0 socat=1.8.1.3-r0

COPY --chmod=0555 worldfixture-entrypoint.sh /usr/local/bin/worldfixture-s3
COPY --chmod=0444 filer.toml /etc/seaweedfs/filer.toml
COPY --chmod=0444 master.toml /etc/seaweedfs/master.toml
COPY --chmod=0444 THIRD_PARTY_NOTICES.md /usr/share/worldfixture-s3/THIRD_PARTY_NOTICES.md

# Session values replace all eight port placeholders. No listener uses these image
# defaults in a launched session. They exist only so the image can be inspected and
# so a direct local run fails on a collision instead of selecting an upstream
# default that the profile does not know about.
#
# `WORLDFIXTURE_WORLD_PATH` has no useful default: without a mounted world there
# is nothing to serve, and the entry point says so and exits 64.
ENV WORLDFIXTURE_S3_BIND=0.0.0.0 \
    WORLDFIXTURE_MASTER_PORT=61000 \
    WORLDFIXTURE_MASTER_GRPC_PORT=61001 \
    WORLDFIXTURE_VOLUME_PORT=61002 \
    WORLDFIXTURE_VOLUME_GRPC_PORT=61003 \
    WORLDFIXTURE_FILER_PORT=61004 \
    WORLDFIXTURE_FILER_GRPC_PORT=61005 \
    WORLDFIXTURE_S3_PORT=61006 \
    WORLDFIXTURE_S3_GRPC_PORT=61007 \
    WORLDFIXTURE_WORLD_PATH=/world

# The run plane mounts /tmp as scratch for an emulator's read-only rootfs.
# SeaweedFS data and metadata live there and die with the session.
WORKDIR /
USER seaweed

EXPOSE 61006

# The probe is the SEED, not the listener.
#
# It used to be the filer's /healthz, and that limit was worth stating: this
# artifact shipped once unable to store any object at all — `-volume.max=1` left
# one volume slot, already consumed — while /healthz, the filer UI and bucket
# listing all answered normally. No liveness probe catches that.
#
# `/worldfixture/ready` is written by the entry point only after every bucket the
# world declares exists and every object it declares has been stored, so the
# probe now fails for exactly the case /healthz missed. Exercising the protocol
# is still a separate job; see test/protocol-test.mjs.
HEALTHCHECK --start-period=20s --interval=10s --timeout=5s --retries=6 \
  CMD wget -qO- "http://127.0.0.1:${WORLDFIXTURE_FILER_PORT}/worldfixture/ready" >/dev/null

ENTRYPOINT ["/usr/local/bin/worldfixture-s3"]
