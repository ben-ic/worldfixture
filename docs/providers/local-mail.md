# Local Mail

Local Mail is Cyrus IMAP 3.6.1 plus a WorldFixture SMTP-to-LMTP bridge. Use the
dynamic `SMTP_*` and `IMAP_*` bindings.

Overall status: **Supported but partial**. Use the exact scope below.

## What works

| Protocol | Exact operations | Test proof |
| --- | --- | --- |
| SMTP | Greeting, `EHLO`, `HELO`, `MAIL FROM`, up to 100 `RCPT TO` values, `DATA`, dot unstuffing, `RSET`, `NOOP`, and `QUIT`; advertises `SIZE 10485760` and `8BITMIME` | Tested by `emulators/mail/test/protocol-test.sh` and supervisor tests |
| IMAP | `LOGIN`, `LIST`, `SELECT`, `SEARCH`, UID search, UID fetch, UID store, mailbox create and delete, expunge, and logout | This subset is **Supported and contract-tested** by `emulators/mail/test/protocol-test.sh` |
| Workbench | Reads live Cyrus state through IMAP and sends through SMTP | The private mailbox web UI is **Workbench-only** |

SMTP delivers only inside the local world. Reset restores the accepted mail
snapshot and removes later messages. `down` removes temporary state.

## What does not work

- SMTP `AUTH`, TLS, `STARTTLS`, `VRFY`, `EXPN`, `HELP`, `PIPELINING`, `DSN`,
  and `SMTPUTF8` are **Not supported**.
- SMTP username and password bindings exist, but the server does not authenticate
  them.
- There are no mail webhooks and no network relay.
- IMAP operations outside the tested subset can come from Cyrus, but they have no
  WorldFixture contract proof. Do not treat them as verified support.

## SDK and production proof

No mail SDK version is pinned. `examples/protocol-app/app.py` uses Python
`smtplib` and `imaplib`. Local Mail is a local service, not a production-provider
copy, so a production-provider comparison does not apply.
