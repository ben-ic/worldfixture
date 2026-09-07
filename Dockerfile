# syntax=docker/dockerfile:1

# One complete WorldFixture runtime. The tag resolves to this multi-architecture
# index; the digest prevents a later tag update from changing the build input.
ARG NODE_IMAGE=docker.io/library/node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e

FROM ${NODE_IMAGE} AS compiler
WORKDIR /source
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 python3-jsonschema=4.10.3-1 \
 && rm -rf /var/lib/apt/lists/*
COPY compiler ./compiler
COPY schemas ./schemas
COPY worlds ./worlds
# Every reviewed world. `business.saas-company:v3` is the default an instance
# starts; v2 stays in the image because it is the parity fixture; and
# `consumer.retail-brand:v1` is the consumer world. `--world-path` selects any
# of them.
RUN PYTHONPATH=compiler python3 -m worldfixture_compiler build \
      worlds/business.saas-company.v2/world.json \
      --output /artifact/business.saas-company.v2 \
 && PYTHONPATH=compiler python3 -m worldfixture_compiler build \
      worlds/business.saas-company.v3/world.json \
      --output /artifact/business.saas-company.v3 \
 && PYTHONPATH=compiler python3 -m worldfixture_compiler build \
      worlds/consumer.retail-brand.v1/world.json \
      --output /artifact/consumer.retail-brand.v1

FROM ${NODE_IMAGE} AS emulate-dependencies
WORKDIR /opt/worldfixture/emulators/emulate
COPY emulators/emulate/package.json emulators/emulate/package-lock.json ./
COPY emulators/emulate/scripts/patch-core-rate-limit.mjs ./scripts/patch-core-rate-limit.mjs
RUN npm ci --omit=dev --ignore-scripts \
 && node scripts/patch-core-rate-limit.mjs \
 && npm cache clean --force \
 && rm -rf /root/.npm

FROM ${NODE_IMAGE} AS workbench-ui
WORKDIR /source/runtime/workbench-ui
COPY runtime/workbench-ui/package.json runtime/workbench-ui/package-lock.json ./
RUN npm ci --ignore-scripts \
 && npm cache clean --force \
 && rm -rf /root/.npm
COPY runtime/workbench-ui ./
RUN npm run build

FROM ${NODE_IMAGE} AS documentation
WORKDIR /source/docs
COPY docs/package.json docs/package-lock.json ./
RUN npm ci --ignore-scripts \
 && npm cache clean --force \
 && rm -rf /root/.npm
COPY docs ./
COPY scripts/analytics.mjs /source/scripts/analytics.mjs
RUN npm run build

FROM ${NODE_IMAGE} AS seaweedfs
ARG TARGETARCH
ARG SEAWEEDFS_VERSION=4.41
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in \
      amd64) checksum=730f1ede19972c12954ee407b2d97679a2e4486d24fd987d371761ec395571b8 ;; \
      arm64) checksum=ecfb79fb8e0f235ea537948c9ea6041cec87c545746d369bf1f10e3ca10aa186 ;; \
      *) echo "unsupported SeaweedFS architecture: $TARGETARCH" >&2; exit 64 ;; \
    esac \
 && curl -fsSL \
      "https://github.com/seaweedfs/seaweedfs/releases/download/${SEAWEEDFS_VERSION}/linux_${TARGETARCH}.tar.gz" \
      -o /tmp/seaweedfs.tar.gz \
 && echo "$checksum  /tmp/seaweedfs.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/seaweedfs.tar.gz -C /usr/local/bin weed \
 && chmod 0555 /usr/local/bin/weed

FROM ${NODE_IMAGE} AS runtime
ARG TARGETARCH
ARG WORLDFIXTURE_SOURCE_COMMIT

LABEL org.opencontainers.image.title="WorldFixture" \
      org.opencontainers.image.description="One-container runtime for reproducible software worlds" \
      org.opencontainers.image.version="0.2.6" \
      org.opencontainers.image.revision="${WORLDFIXTURE_SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.worldfixture.architecture="${TARGETARCH}"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PYTHONPATH=/opt/worldfixture/compiler \
    WORLDFIXTURE_SINGLE_CONTAINER=1 \
    WORLDFIXTURE_WORKBENCH_REVEAL_WEBHOOK_SECRETS=0

# Cyrus comes from Debian. SeaweedFS is the one downloaded binary and is copied
# from the checksum-verified stage above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      busybox-static=1:1.35.0-4+deb12u1+b1 \
      ca-certificates=20250419~deb12u1 \
      curl=7.88.1-10+deb12u15 \
      cyrus-imapd=3.6.1-4+deb12u5 \
      jq=1.6-2.1+deb12u2 \
      libsasl2-modules=2.1.28+dfsg-10 \
      mariadb-server=1:10.11.18-0+deb12u1 \
      python3=3.11.2-1+b1 \
      python3-jsonschema=4.10.3-1 \
      postgresql-15=15.19-0+deb12u1 \
      sasl2-bin=2.1.28+dfsg-10 \
      socat=1.7.4.4-2 \
      tini=0.19.0-1+b3 \
      wget=1.21.3-1+deb12u1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/worldfixture /state \
      /usr/share/worldfixture-mail/licenses \
      /usr/share/worldfixture-s3 \
 && cp /usr/share/doc/cyrus-common/copyright \
      /usr/share/worldfixture-mail/licenses/CYRUS-COPYRIGHT

WORKDIR /opt/worldfixture

COPY --from=compiler /artifact ./dist
COPY --from=seaweedfs /usr/local/bin/weed /usr/bin/weed
COPY compiler ./compiler
COPY schemas ./schemas
COPY docs ./docs
COPY skills ./skills
COPY worlds ./worlds
COPY runtime ./runtime
COPY LICENSE /usr/share/licenses/worldfixture/LICENSE
COPY --from=workbench-ui /source/runtime/workbench-ui/dist ./runtime/workbench-ui/dist
COPY --from=documentation /source/docs/.vitepress/dist ./runtime/docs-site

COPY emulators/emulate ./emulators/emulate
COPY --from=emulate-dependencies /opt/worldfixture/emulators/emulate/node_modules \
     ./emulators/emulate/node_modules
COPY emulators/http-targets ./emulators/http-targets
COPY emulators/domain ./emulators/domain
COPY emulators/mail/service.json ./emulators/mail/service.json
COPY emulators/s3/service.json ./emulators/s3/service.json
COPY emulators/postgres/service.json ./emulators/postgres/service.json
COPY emulators/mysql/service.json ./emulators/mysql/service.json

COPY emulators/mail/cyrus.conf /etc/worldfixture-mail/cyrus.conf
COPY emulators/mail/imapd.conf /etc/worldfixture-mail/imapd.conf
COPY emulators/mail/world-mail.pl /usr/share/worldfixture-mail/world-mail.pl
COPY emulators/mail/lmtp-submit.pl /usr/share/worldfixture-mail/lmtp-submit.pl
COPY emulators/mail/smtp-submit.pl /usr/share/worldfixture-mail/smtp-submit.pl
COPY emulators/mail/smtp-server.pl /usr/share/worldfixture-mail/smtp-server.pl
COPY emulators/mail/mailbox-web.pl /usr/share/worldfixture-mail/mailbox-web.pl
COPY emulators/mail/test/protocol-test.sh /usr/share/worldfixture-mail/protocol-test.sh
COPY emulators/mail/THIRD_PARTY_NOTICES.md /usr/share/worldfixture-mail/THIRD_PARTY_NOTICES.md
COPY emulators/mail/worldfixture-entrypoint.sh /usr/local/bin/worldfixture-mail

COPY emulators/s3/filer.toml /etc/seaweedfs/filer.toml
COPY emulators/s3/master.toml /etc/seaweedfs/master.toml
COPY emulators/s3/THIRD_PARTY_NOTICES.md /usr/share/worldfixture-s3/THIRD_PARTY_NOTICES.md
COPY emulators/s3/worldfixture-entrypoint.sh /usr/local/bin/worldfixture-s3
COPY emulators/postgres/worldfixture-entrypoint.sh /usr/local/bin/worldfixture-postgres
COPY emulators/mysql/worldfixture-entrypoint.sh /usr/local/bin/worldfixture-mysql

RUN chmod 0555 \
      /usr/local/bin/worldfixture-mail \
      /usr/local/bin/worldfixture-s3 \
      /usr/local/bin/worldfixture-postgres \
      /usr/local/bin/worldfixture-mysql \
      /usr/share/worldfixture-mail/protocol-test.sh \
      /usr/share/worldfixture-mail/world-mail.pl \
      /usr/share/worldfixture-mail/lmtp-submit.pl \
      /usr/share/worldfixture-mail/smtp-submit.pl \
      /usr/share/worldfixture-mail/smtp-server.pl \
      /usr/share/worldfixture-mail/mailbox-web.pl

# Only application surfaces are mapped by the run command. Private readiness,
# filer, mailbox, gRPC, master, and volume ports stay inside the container.
EXPOSE 4701 4702 4703 4704 4705 4706 4707 4708 4709 4710 4711 4712 4713 4714 4715 4716 4717 \
       8080 2525 1143 3306 5432 61006

HEALTHCHECK --start-period=60s --interval=15s --timeout=10s --retries=4 \
  CMD ["node", "runtime/bin/worldfixture.mjs", "status", "--state", "/state"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "runtime/bin/worldfixture.mjs", "up", "--service-root", "/opt/worldfixture/emulators", "--state", "/state"]
