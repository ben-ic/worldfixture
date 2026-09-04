# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 docker.io/library/node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c

ARG SOURCE_DATE_EPOCH=1787284800
ARG WORLDFIXTURE_SOURCE_COMMIT
ARG WORLDFIXTURE_SOURCE_TREE_SHA256
ARG WORLDFIXTURE_RUNTIME_CONTRACT_SHA256

LABEL org.opencontainers.image.revision="${WORLDFIXTURE_SOURCE_COMMIT}" \
      org.worldfixture.source.tree.sha256="${WORLDFIXTURE_SOURCE_TREE_SHA256}" \
      org.worldfixture.runtime.contract.sha256="${WORLDFIXTURE_RUNTIME_CONTRACT_SHA256}" \
      org.opencontainers.image.version="1.4.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.worldfixture.role="emulator"

WORKDIR /opt/worldfixture-http-targets
COPY server.mjs ./server.mjs
COPY feed.mjs ./feed.mjs
# The test directory keeps its shape rather than being flattened, so the layout
# in the image is the layout in the repository. The protocol test now boots the
# server itself and resolves `../server.mjs`; flattening it here would leave a
# test that runs from a checkout and not from the image, or the reverse.
COPY test ./test

ENV WORLDFIXTURE_HTTP_TARGETS_LISTEN=0.0.0.0:8080
EXPOSE 8080
USER node
ENTRYPOINT ["node", "/opt/worldfixture-http-targets/server.mjs"]
