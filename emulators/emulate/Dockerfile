# syntax=docker/dockerfile:1
# WorldFixture API emulator — a WorldFixture composer over `emulate` 0.10.0's published packages.
#
# This is a PLATFORM artifact, not a catalogue application. It joins a demo session's
# existing Kata/Firecracker µVM as a `service_images` entry and serves stateful,
# in-memory fakes of third-party APIs, so a demo can exercise a real integration
# without a real credential and usually without egress.
#
# WHAT CHANGED AT v1.0.0, and why the artifact is no longer the upstream CLI.
#
# Until now this image ran `emulate`'s own binary with a `--service` list. That worked
# and could not be extended: the CLI's service registry is private to the CLI, so
# there was nowhere to add a surface, fix a vendor bug, or choose a bind address. What
# we needed was not a fork — upstream's value is ~46,000 lines of vendor route
# implementations and owning them would be a permanent merge burden — but a seam.
#
# `@emulators/core` is published separately and exports `createServer`, `serve` and the
# `ServicePlugin` interface; each vendor is published as its own package. Only the CLI
# is closed. So the routes stay upstream and pinned, and the wiring is ours: see
# src/main.mjs, which documents each thing composing bought.
#
# THE SUPPLY CHAIN MOVED, AND IMPROVED. The old artifact's `source_commit` was
# UPSTREAM's v0.8.0 tag, which is why it could not move: 0.9.0 and 0.10.0 were
# published to npm with no git tag, no release and no `gitHead`, so they have no commit
# and no tree for the four digests a launch re-verifies. Now the source is this repo and
# upstream is pinned by lockfile sha512 — which attests the bytes npm actually served,
# where a git tag attests nothing and can be moved.
FROM --platform=linux/amd64 docker.io/library/node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c

ARG WORLDFIXTURE_SOURCE_COMMIT
ARG WORLDFIXTURE_SOURCE_TREE_SHA256
ARG WORLDFIXTURE_RUNTIME_CONTRACT_SHA256
LABEL org.opencontainers.image.revision="${WORLDFIXTURE_SOURCE_COMMIT}" \
      org.worldfixture.source.tree.sha256="${WORLDFIXTURE_SOURCE_TREE_SHA256}" \
      org.worldfixture.runtime.contract.sha256="${WORLDFIXTURE_RUNTIME_CONTRACT_SHA256}"

LABEL org.opencontainers.image.version="1.5.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.worldfixture.role="emulator"

WORKDIR /opt/emulator

# The lockfile is the artifact's real pin: nineteen packages, each with sha512
# integrity — `@emulators/*` and `emulate` (Apache-2.0), `jose` (MIT), `yaml` (ISC),
# `commander` (MIT), `picocolors` (ISC).
#
# `emulate` itself is still a dependency, and only for Linear. `@emulators/linear` and
# `@emulators/twilio` are NOT PUBLISHED — they exist only bundled inside the CLI — so
# Linear is started through upstream's `createEmulator`, which takes no plugins and no
# bind address. That is the one real cost of composing, and it is confined to one
# vendor. `npm ci` fails rather than resolving anything the lockfile does not name.
COPY package.json package-lock.json ./
COPY scripts/patch-core-rate-limit.mjs ./scripts/patch-core-rate-limit.mjs

# --ignore-scripts is deliberate and load-bearing. An npm lifecycle script is arbitrary
# code executing at image-build time with the network available, which is precisely the
# supply-chain step this artifact exists to avoid trusting. If a future bump needs one,
# that is a review decision and not something to discover from a silently different
# image.
RUN npm ci --omit=dev --ignore-scripts \
    && node scripts/patch-core-rate-limit.mjs \
    && npm cache clean --force \
    && rm -rf /root/.npm

COPY src ./src
COPY contracts ./contracts

# The seed is CONTENT, and content may be baked. Credentials may not.
#
# A demo mailbox is the same for every session by design — deterministic content is
# what makes two runs of one version comparable — so it belongs in the image. What may
# never be baked is key material: a credential here would be shared by every session
# that ever runs this artifact, which is the one thing the per-session design exists to
# prevent. Per-session values stay environment at launch.
#
# Every address in the seed is `.worldfixture.test`, which cannot resolve, and the mail is
# written to read as sample content. The `worldfixture.arrivals` block at the end is read by
# the composer and never by the vendor emulator; it is what makes the mailbox move.
COPY seed.yaml ./

# The image's own unprivileged user. Nothing here needs root, and the run plane
# additionally sets a read-only rootfs for role "emulator". State is in memory only —
# no database, no volume, no persistence adapter — so everything this process knows
# dies with the µVM and the seed is re-applied at every start.
USER node

ENV NODE_ENV=production

# A DEFAULT PORT FOR THE BUILD PROBE, and nothing else.
#
# At session time every listener is addressed explicitly — `WORLDFIXTURE_PORT_<VENDOR>`,
# assigned per session by the control plane — which is the whole point of composing.
# But a build has no control plane, so without a default nothing listens and the probe
# has nothing to talk to. Google is the default because it is the vendor with the
# published surface and the one the health check proves.
#
# A session overrides this, and a session that enables a vendor gives it a port; a
# vendor with no port is simply not started.
# 0.0.0.0, and this is not a build-only convenience: the probe connects from OUTSIDE
# the container, so a loopback-bound listener is refused — "server started but the
# published port refused", which is exactly what the first attempt reported. Every
# vendor is published at session time and binds the bridge there too; the composer's
# own default stays loopback so an undeclared listener is never wider than asked.
ENV WORLDFIXTURE_PORT_GOOGLE=4000 \
    WORLDFIXTURE_BIND_GOOGLE=0.0.0.0
EXPOSE 4000

# The readiness contract, declared here rather than in a submission.
#
# `automatic_artifact.py` extracts one literal loopback path from the selected
# HEALTHCHECK — a quoted `fetch` whose port matches the proven EXPOSE qualifies — and
# uses it as the build probe. Without it the probe defaults to `/`, which this emulator
# does not serve: the process starts, prints its listeners, and the build fails with
# `http 404 at /`.
#
# The discovery document is a real answer rather than a bound socket, and at v1.0.0 it
# proves one thing more: `id_token_signing_alg_values_supported` reads RS256 only
# because src/overrides/google-signing.mjs is in the request path. A build where the
# override failed to load reports HS256 and fails here.
HEALTHCHECK --start-period=20s --interval=10s --timeout=5s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/.well-known/openid-configuration').then(async r => { const b = await r.json(); if (!r.ok || !b.id_token_signing_alg_values_supported.includes('RS256')) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "src/main.mjs"]
