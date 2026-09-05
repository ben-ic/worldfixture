# Relay Digest

Run these commands from the repository root:

```sh
npx worldfixture up
WORLDFIXTURE_STATE="$PWD/.worldfixture/runs/local" \
  npm --prefix examples/regular-app start
```

Open the printed URL. The first screen is a normal SaaS account application. It
reads customers from Stripe, mail from Gmail, issues from GitHub, team context
from Slack, and stored briefs from local S3. It uses the actual addresses
from `worldfixture env`; it does not assume host ports.

The navigation also has complete Slack, GitHub, Gmail, Local Mail, and Files
views. Gmail uses the Google API. Local Mail sends with SMTP and reads the
result with IMAP.

The default command uses the pre-authorized fixture credentials from
`worldfixture env`. This mode is useful for CI. To exercise interactive Slack,
GitHub, and Google authorization-code flows, run:

```sh
WORLDFIXTURE_STATE="$PWD/.worldfixture/runs/local" \
WORLDFIXTURE_AUTH_MODE=oauth \
  npm --prefix examples/regular-app start
```

Select **Connect** for each provider. Relay Digest validates OAuth state,
exchanges each code, and keeps the issued tokens in its own process. Exact
world reset removes those issued tokens, so the app returns each provider to
its disconnected state.

The example depends on the default world, which contains Lumen Labs. Select
Lumen Labs and choose **Assemble brief**. Each statement shows the
provider response that supports it. Choose **Approve and send** to write the
brief to S3, send it with Gmail, and post the stored location to Slack.

Run `npx worldfixture reset` from the repository root, then refresh the page. The
footer shows that the accepted starting state returned.

## Application connector

Relay Digest contains the reference WorldFixture Connector v1 implementation.
It is disabled unless `WORLDFIXTURE_TOKEN` is set. Start it for connector work:

```sh
npx worldfixture run -- npm --prefix examples/regular-app start
```

Then check, preview, and seed it from the repository root. Use the URL that the
application prints:

```sh
APP_URL=http://127.0.0.1:PRINTED_PORT
npx worldfixture connector check "$APP_URL"
npx worldfixture connector plan "$APP_URL"
npx worldfixture connector seed "$APP_URL" --scale smoke
```
