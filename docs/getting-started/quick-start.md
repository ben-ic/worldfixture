# Five-minute quick start

This path starts Slack, sends one test message, confirms the message in the
Workbench, and resets the world.

## 1. Check the requirements

You need Docker and Node.js 22 or later. WorldFixture supports `arm64` and
`amd64` machines.

```sh
docker version
node --version
```

## 2. Start a world

```sh
npx worldfixture up --only slack
```

The first run downloads the image. The command prints the Workbench URL. It also
shows the services that are still loading. Wait until Slack is ready.

For your first run, use only Slack. You can start all services later with
`npx worldfixture up`.

## 3. Open the Workbench

Open the printed URL, or run:

```sh
npx worldfixture open
```

The URL is local and contains a dynamic host port. Do not assume that the port
is `4715`.

In the Workbench:

1. Confirm that Slack shows **Ready**.
2. Open **Chat**.
3. Send `Hello from my first WorldFixture run`.

Chat selects the conversation that has the latest message.

## 4. Read the same state with curl

In a new terminal, load the bindings for this run:

```sh
eval "$(npx worldfixture env)"
```

The command gives your shell the generated URL and token. The URL contains a
dynamic port. Then list the conversations:

```sh
curl -sS -X POST "$SLACK_BASE_URL/api/conversations.list" \
  -H "Authorization: Bearer $SLACK_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data 'limit=100&types=public_channel,private_channel,mpim,im'
```

Next, use a complete [JavaScript, Python, or curl example](./connect-an-app.md).

## 5. Check the event and reset

Open **Activity** in the Workbench. You can also run:

```sh
npx worldfixture events
npx worldfixture reset
```

After reset, the marker is not in Chat and the runtime event ledger is empty.

Stop the world when you finish:

```sh
npx worldfixture down
```

If start fails, run `npx worldfixture doctor`. It reports the failed check and a
repair command. It does not change state.
