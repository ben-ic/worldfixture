# Relay Digest

Start WorldFixture from the repository root. Then run one command here:

```sh
npm start
```

Open the printed URL. The first screen is a normal SaaS account application. It
reads customers from Stripe, mail from Gmail, issues from GitHub, team context
from Slack, and stored briefs from SeaweedFS S3. It uses the actual addresses
from `worldfixture env`; it does not assume host ports.

The navigation also has complete Slack, GitHub, Gmail, Mail, and Files views.
Gmail uses the Google API. Mail is a separate service: it sends with SMTP and
reads the result with IMAP.

The default command uses the pre-authorized fixture credentials from
`worldfixture env`. This mode is useful for CI. To exercise interactive Slack,
GitHub, and Google authorization-code flows, run:

```sh
WORLDFIXTURE_AUTH_MODE=oauth npm start
```

Select **Connect** for each provider. Relay Digest validates OAuth state,
exchanges each code, and keeps the issued tokens in its own process. Exact
world reset removes those issued tokens, so the app returns each provider to
its disconnected state.

Select Lumen Labs and choose **Assemble brief**. Each statement shows the
provider response that supports it. Choose **Approve and send** to write the
brief to S3, send it with Gmail, and post the stored location to Slack.

Run `node ../../runtime/bin/worldfixture.mjs reset`, then refresh the page. The
footer shows that the accepted starting state returned.

## Application connector

Relay Digest contains the reference WorldFixture Connector v1 implementation.
It is disabled unless `WORLDFIXTURE_TOKEN` is set. Start it for connector work:

```sh
node ../../runtime/bin/worldfixture.mjs run -- npm start
```

Then check, preview, and seed it from the repository root:

```sh
node runtime/bin/worldfixture.mjs connector check http://localhost:4300
node runtime/bin/worldfixture.mjs connector plan http://localhost:4300
node runtime/bin/worldfixture.mjs connector seed http://localhost:4300
```
