# Connect an application

Every run selects free host ports and writes the actual connection values to
its local state directory. Always read these values. Do not copy a port from a
different run.

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
[`examples/onboarding/slack.mjs`](../../examples/onboarding/slack.mjs):

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

From the application root:

```sh
npx worldfixture connector prompt http://localhost:3000
npx worldfixture connector check http://localhost:3000
npx worldfixture connector plan http://localhost:3000 --scale smoke
npx worldfixture connector seed http://localhost:3000 --scale smoke
```

See the [connector overview](../connectors/overview.md) before you add this
development-only control surface to an application.
