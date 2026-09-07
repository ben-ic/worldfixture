# Five-minute quick start

Start one local provider, open its state, and get the API endpoint for your
application.

You need Docker and Node.js 22 or later. WorldFixture supports `arm64` and
`amd64` machines.

## 1. Start

```sh
npx worldfixture up --only slack
```

The first run downloads the WorldFixture image. The command ticks off each part
of the world as it becomes usable, with the port it answers on, and keeps a
running clock for the parts still loading. When the world is ready it prints the
full set of addresses, including the Workbench URL and the local Slack API
endpoint. The Workbench URL is the final line. Nothing is offered before the
world works, so wait for the ready report. A fresh interactive start asks
whether to launch the Account Desk demo app. Use `--no-sample-app` when you want
only the selected provider.

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
host port for this run. It is normally `4703`, but WorldFixture selects a free
fallback if that port is busy. Use these values in your application instead of
a production Slack URL and token.

You now have a local Slack API and a Workbench that uses the same state.

## Next steps

- [Connect an application](./connect-an-app.md).
- [Test the local APIs with Postman](../guides/postman.md).
- [Check the exact supported Slack operations](../providers/slack.md).

When you finish, run `npx worldfixture down`. If a start fails, run
`npx worldfixture doctor`.
