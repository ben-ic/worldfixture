# WorldFixture mail emulator

This unlisted fixture turns one verified world mail projection into a working
mail service. Cyrus IMAP is the only mailbox authority. A loopback SMTP bridge
sends accepted messages to Cyrus through LMTP. The fixture has no relay action.
All message state is under `/tmp/worldfixture-mail`, and the fixture has no
persistent volume. The state ends with the session.

Nothing about the mail service is compiled into the image. The accounts, their
folders, the realm and every seeded message come from
`$WORLDFIXTURE_WORLD_PATH/projections/mail.json` at startup. Startup fails if
that projection is not there.

## What the world decides

| Thing | Where it comes from |
| --- | --- |
| Accounts | one per `users[]` record; the login is the record's `login` |
| Realm | the primary organization's `domain` in the artifact's `world.json`, or the most common user domain in the projection when the projection is used alone |
| SASL realm per person | the domain of that person's own address, so people outside the primary organization keep their own domain |
| Folders | each record's `folders[]`, created per person; the union also becomes Cyrus's `autocreate_inbox_folders`, so an address invented later by an application gets the world's folder set too |
| Messages | one RFC 5322 message per `messages[]` record, delivered over LMTP |
| Read state | a message labelled `UNREAD` stays unseen; every other seeded copy is `\Seen` |

Each message reaches its recipient's `INBOX`, and a message labelled `SENT` also
reaches the sender's `Sent` folder, so the delivery count is larger than the
message count. In the default world, `business.saas-company:v3`, 161 people and
3,069 messages produce 805 mailboxes and 4,528 deliveries; in the smaller
`business.saas-company:v2`, 16 people and 74 messages produce 80 mailboxes and
129 deliveries. Seeding those deliveries over LMTP is most of the time a full
start takes.

`Date` comes from the record's `sent_at`, never from the wall clock.
`Message-ID` is derived from the record id. A message that is not the first in
its `thread_id` carries `In-Reply-To` and `References` naming the earlier
messages of that thread. Each message also carries `X-WorldFixture-Record` and
`X-WorldFixture-Labels`, so a projection record can be found again from the
mailbox.

`labels` other than `SENT` and `UNREAD` — `Finance`, `Customers`, `STARRED` and
the rest — are recorded in `X-WorldFixture-Labels` but are not mapped to IMAP
folders or flags. The projection gives every person the same five folders, so
those labels are not a folder set, and no world fact says what else they should
become.

## Passwords

The projection carries `password_ref: "mail-password:<person-id>"` and never a
secret. That reference is resolved at startup:

1. if `WORLDFIXTURE_MAIL_PASSWORDS` names a readable JSON file mapping
   `password_ref` to a password, that file answers; otherwise
2. the reference resolves to its own identifier — `mail-password:maya-chen`
   becomes `maya-chen`.

**The second rule is a local fixture convention, not a security mechanism.** It
exists so a first run needs no setup. Every address in this world is inside
`.test`, which RFC 2606 reserves and which cannot be routed; IMAP and SMTP bind
only the container's loopback address; and the passwords are derived from public
identifiers that are in the artifact. Nothing here hashes, stores, or protects a
credential, and nothing here should be pointed at a real mailbox.

One admin account, `cyrus`, exists so seeding can create another person's
mailbox. It is not a world person. It is created at startup rather than in the
image, because its SASL realm is the world's domain and the world is not known
until a world is mounted.

## Ports

| Container port | Name | Reachable from |
| --- | --- | --- |
| 1025 | SMTP submission | container loopback only |
| 1143 | IMAP | container loopback only |
| 8080 | mailbox page | published |
| 8025 | readiness (`/readyz`) | published |

SMTP and IMAP stay on loopback by design; the entry point refuses to start if
either is asked to bind anything else. Protocol checks therefore run inside the
container.

## Run it

Run these commands from `emulators/mail`:

```text
docker build --platform=linux/amd64 -t worldfixture-mail:test .
docker run -d --name worldfixture-mail-test \
  -v /path/to/artifact:/world:ro \
  -e WORLDFIXTURE_WORLD_PATH=/world \
  -p 4980:8080 -p 4981:8025 \
  worldfixture-mail:test
docker exec worldfixture-mail-test /usr/share/worldfixture-mail/protocol-test.sh
```

The mailbox page is then on `http://127.0.0.1:4980/` and readiness on
`http://127.0.0.1:4981/readyz`. Host ports for this repository come from the
4980-4989 range.

`test/protocol-test.sh` reads the mounted projection itself and asserts the
world's own numbers: every person logs in over IMAP, each `INBOX`, `Sent` and
unseen count matches the projection, a message one world person sent is read
back by its world recipient with the world's text and date, an SMTP submission
reaches Cyrus through LMTP, and the mailbox page lists the world's people.

## Determinism

Seeding reads no clock. The message set, its order, every generated header and
the resulting flags are functions of the projection alone, so two containers
started from the same artifact hold the same mailboxes with the same UIDs.

Verified on `business.saas-company:v2`, which is small enough to dump whole: two
containers started from the same artifact were dumped over IMAP -- every mailbox,
every UID, every flag and every generated header -- and the two dumps are
byte-identical (937 lines, 129 message copies, 8 unseen, sha256
`287f2c46b5aa559058f3af93aad699bcd2b9bd88bbe31484db13b26b4f201da7` in both).

What is *not* identical between runs is Cyrus's own bookkeeping, all of it
clock- or session-derived: the `Received:` header and `X-Cyrus-Session-Id` that
lmtpd prepends, the message's `INTERNALDATE`, and each mailbox's `UIDVALIDITY`
and `MAILBOXID`. Fetching one raw message from both runs shows exactly those
lines differing and nothing else. Slack and GitHub have the same wall-clock
limit. Here it comes through the LMTP delivery path rather than through this
fixture's code.
Byte-equivalent reset needs it fixed; nothing here can fix it without giving up
LMTP delivery.

## Pins and provenance

| Component | Repository | Upstream version | Debian package | License |
| --- | --- | --- | --- | --- |
| Cyrus IMAP | `https://github.com/cyrusimap/cyrus-imapd` | `3.6.1` | `3.6.1-4+deb12u4` | BSD-3-Clause-CMU |

The base is the Debian `bookworm-slim` linux/amd64 child manifest
`sha256:362e64223cc0da95422b3b13c045186fc0a81250e765d31c025fbddf257f6143`. The
image is amd64 only, so it runs under emulation on an arm64 host and builds
slowly there.

`emulator.json` records the upstream repository URLs, versions, package
versions, licenses, and runtime contract. `THIRD_PARTY_NOTICES.md` preserves the
required Cyrus acknowledgment. The image also contains the Debian copyright file
for Cyrus, at `/usr/share/worldfixture-mail/licenses/CYRUS-COPYRIGHT`.

Direct package file SHA-256 values:

| Package | SHA-256 |
| --- | --- |
| `cyrus-imapd_3.6.1-4+deb12u4_amd64.deb` | `83a3bb66081e0a19541c2fd69d440bedf3774feca34e6a5900d76975920caa4a` |
| `sasl2-bin_2.1.28+dfsg-10_amd64.deb` | `b376c65ea788542a6fe69b3301cbd85dac38d7490c91b944decc041b15ec59c7` |
| `libsasl2-modules_2.1.28+dfsg-10_amd64.deb` | `b1966bea9832686a0fd5ddba9787dce5816ebe02218a4a8f7472a1628d73451b` |
| `busybox-static_1.35.0-4+deb12u1+b1_amd64.deb` | `3d3fdbe91d4660c873e14b092c213fe81c1da6362daa236eb25d0171eb108744` |

## Security boundary

- SMTP and IMAP listen only on the container loopback address.
- The mailbox page is the only public listener besides readiness. It is a
  server-side IMAP and SMTP client and has no second message store.
- The SMTP bridge accepts any recipient from the loopback listener, sends it
  only to the local Cyrus LMTP socket, and never relays.
- There is no relay action, smart host, DNS delivery, or outbound SMTP path.
- The readiness listener exposes only `/readyz`.
- The browser receives rendered HTML. It does not parse IMAP or connect to SMTP.
- The mounted world is read-only to this fixture. It is read once, at startup.
