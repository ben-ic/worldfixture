# syntax=docker/dockerfile:1
# WorldFixture mail — Cyrus IMAP 3.6.1 with a loopback SMTP bridge.
# The amd64 child manifest is first because fixture provenance reads the first digest.
FROM --platform=linux/amd64 docker.io/library/debian:bookworm-slim@sha256:362e64223cc0da95422b3b13c045186fc0a81250e765d31c025fbddf257f6143

ARG SOURCE_DATE_EPOCH=1787284800
ARG WORLDFIXTURE_SOURCE_COMMIT
ARG WORLDFIXTURE_SOURCE_TREE_SHA256
ARG WORLDFIXTURE_RUNTIME_CONTRACT_SHA256

LABEL org.opencontainers.image.revision="${WORLDFIXTURE_SOURCE_COMMIT}" \
      org.worldfixture.source.tree.sha256="${WORLDFIXTURE_SOURCE_TREE_SHA256}" \
      org.worldfixture.runtime.contract.sha256="${WORLDFIXTURE_RUNTIME_CONTRACT_SHA256}" \
      org.opencontainers.image.version="2.2.0" \
      org.opencontainers.image.licenses="Apache-2.0 AND BSD-3-Clause-CMU" \
      io.worldfixture.role="emulator"

ENV DEBIAN_FRONTEND=noninteractive

# Exact package versions make a repository update fail the build instead of
# changing its bytes. Alpine is smaller, but it does not package Cyrus IMAP.
# `cyrus-imapd` brings the full `perl` package, which is what supplies JSON::PP
# and MIME::Base64 to the projection reader; `perl-base` alone does not have them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      busybox-static=1:1.35.0-4+deb12u1+b1 \
      cyrus-imapd=3.6.1-4+deb12u4 \
      libsasl2-modules=2.1.28+dfsg-10 \
      sasl2-bin=2.1.28+dfsg-10 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/share/worldfixture-mail/licenses \
 && cp /usr/share/doc/cyrus-common/copyright /usr/share/worldfixture-mail/licenses/CYRUS-COPYRIGHT

COPY cyrus.conf /etc/worldfixture-mail/cyrus.conf
# `imapd.conf` is a template, not the running configuration. Its realm and its
# autocreated folder list are the world's, so the entry point fills them in from
# the projection and writes the result to `/etc/imapd.conf`, which is where every
# service Cyrus master starts reads its configuration from.
COPY imapd.conf /etc/worldfixture-mail/imapd.conf
COPY test/protocol-test.sh /usr/share/worldfixture-mail/protocol-test.sh
COPY world-mail.pl /usr/share/worldfixture-mail/world-mail.pl
COPY lmtp-submit.pl /usr/share/worldfixture-mail/lmtp-submit.pl
COPY smtp-submit.pl /usr/share/worldfixture-mail/smtp-submit.pl
COPY smtp-server.pl /usr/share/worldfixture-mail/smtp-server.pl
COPY mailbox-web.pl /usr/share/worldfixture-mail/mailbox-web.pl
COPY worldfixture-entrypoint.sh /usr/local/bin/worldfixture-mail
COPY THIRD_PARTY_NOTICES.md /usr/share/worldfixture-mail/THIRD_PARTY_NOTICES.md

# There is no SASL database in the image. Every account is a world person, the
# realm is the world's own domain, and both only exist once a world is mounted,
# so `saslpasswd2` runs in the entry point instead of here.
RUN chmod 755 /usr/local/bin/worldfixture-mail /usr/share/worldfixture-mail/protocol-test.sh \
      /usr/share/worldfixture-mail/world-mail.pl \
      /usr/share/worldfixture-mail/lmtp-submit.pl /usr/share/worldfixture-mail/smtp-submit.pl \
      /usr/share/worldfixture-mail/smtp-server.pl /usr/share/worldfixture-mail/mailbox-web.pl

ENV WORLDFIXTURE_SMTP_LISTEN=127.0.0.1:1025 \
    WORLDFIXTURE_IMAP_LISTEN=127.0.0.1:1143 \
    WORLDFIXTURE_MAILBOX_LISTEN=0.0.0.0:8080 \
    WORLDFIXTURE_HEALTH_LISTEN=0.0.0.0:8025 \
    WORLDFIXTURE_WORLD_PATH=/world

EXPOSE 1025 1143 8025 8080
ENTRYPOINT ["/usr/local/bin/worldfixture-mail"]
