# Five-minute quick start

Start one local provider, open its state, and get the API endpoint for your
application.

You need Docker and Node.js 22 or later. WorldFixture supports `arm64` and
`amd64` machines.

## 1. Start

```sh
npx worldfixture up --only slack
```

The first run downloads the WorldFixture image. The command prints progress,
the Workbench URL, and the local Slack API endpoint. Wait until it reports that
the world is ready.

## 2. Open

In a second terminal, run:

```sh
npx worldfixture open
```

The Workbench opens in your browser. It shows the people, conversations, and
messages in the running world.

[See where to find each control in the Workbench screenshot guide](../guides/workbench.md).

## 3. Get the API endpoint

```sh
npx worldfixture env --json
```

Read `SLACK_BASE_URL` and `SLACK_TOKEN` from this output. The URL contains the
dynamic port for this run. Use these values in your application instead of a
production Slack URL and token.

You now have a local Slack API and a Workbench that uses the same state.

## Next steps

- [Connect an application](./connect-an-app.md).
- [Check the exact supported Slack operations](../providers/slack.md).

When you finish, run `npx worldfixture down`. If a start fails, run
`npx worldfixture doctor`.
