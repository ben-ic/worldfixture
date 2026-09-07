# Connect an application

Every run selects free host ports and writes the actual connection values to
its local state directory. Always read these values. Do not copy a port from a
different run.

A world switch creates new credentials. Read `worldfixture env` again and update
or restart the application with the new values. If you use an application
connector, confirm its URL with `worldfixture switch --connect <application-url>`.
If the selected world needs no connector, use `worldfixture switch --without-application`.
Then choose the initial position in **Timeline**, or run `worldfixture clock start 0s`.

## Use environment bindings

Run an application with all active bindings:

```sh
npx worldfixture run -- npm run dev
```

For a shell session, use:

```sh
eval "$(npx worldfixture env)"
```

For programmatic tooling, use:

```sh
npx worldfixture env --json
```

## JavaScript with the official Slack SDK

Install the pinned official SDK and run the checked example in
[`examples/onboarding/slack.mjs`](https://github.com/ben-ic/worldfixture/blob/main/examples/onboarding/slack.mjs):

```sh
npm --prefix examples/onboarding install
npx worldfixture run -- node examples/onboarding/slack.mjs
```

The example sets the SDK `slackApiUrl` from `SLACK_BASE_URL`. It does not use the
production Slack host. It reads all visible conversations, selects the one with
the latest message, sends one marker, and reads the marker back.

## Python with the official Slack SDK

Install the pinned requirement and run:

```sh
python3 -m pip install -r examples/onboarding/requirements.txt
eval "$(npx worldfixture env)"
python3 examples/onboarding/slack.py
```

The example sets `base_url` from `SLACK_BASE_URL`. It uses the dynamic host port
from the active run.

## curl

Run:

```sh
eval "$(npx worldfixture env)"
bash examples/onboarding/slack.sh
```

The script uses the same selection and read-back rule as the SDK examples. It
needs `jq` to process JSON.

## Connect WorldFixture to your application model

A provider SDK connects your code to provider state. An application connector
does a different job: it maps neutral world packs to your own database and
domain model.

To map world packs into your application database, use an
[application connector](../connectors/overview.md). You do not need a connector
to use a provider SDK or API.
