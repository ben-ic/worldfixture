# Environment variables and bindings

Run `npx worldfixture env` after each start or world switch. The output contains
the host-side values for the active world. `npx worldfixture run -- <command>`
passes the same values to a new application process, including `WORKBENCH_URL`
and `WORLDFIXTURE_TOKEN`.

## Three address types

| Address type | Use | Example shape |
| --- | --- | --- |
| Local browser or application URL | A process on your computer | `http://127.0.0.1:<dynamic-port>` |
| Internal container URL | A service inside the WorldFixture container | `http://127.0.0.1:<fixed-container-port>` |
| Public provider URL | A real provider client outside WorldFixture | Do not use for a local run |

Docker maps a fixed container port to a dynamic host port. The binding reports
the host value. A Notion Page `url` also uses the advertised host-side Notion
origin, and `public_url` is either a string or `null`.

## Main binding groups

- HTTP providers: `<PROVIDER>_BASE_URL` and `<PROVIDER>_TOKEN`.
- S3: `S3_BASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`,
  `S3_BUCKET`, and `S3_PATH_STYLE`.
- Local Mail: `SMTP_*` and `IMAP_*`.
- Twilio: `TWILIO_BASE_URL`, `TWILIO_ACCOUNT_SID`, and
  `TWILIO_AUTH_TOKEN`. `TWILIO_TOKEN` is a legacy bearer-token binding. It is
  not the Twilio Auth Token.
- Optional databases: `POSTGRES_*` and `MYSQL_*`.
- Browser surfaces: `WORKBENCH_URL` and `SITE_BASE_URL`.

Tokens and mail credentials are local synthetic credentials. Do not commit
them. A new run can create new connection values.

A personal token must belong to the selected person. A missing token cannot
use another person's shared token. An alias for the same person's token is
accepted. Organization and service credentials, such as the Stripe, Resend,
and Twilio account credentials, keep their declared scope. A world switch creates new provider
credentials; read the new values before you reconnect the application.
