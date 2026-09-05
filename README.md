# WorldFixture

WorldFixture runs stateful local provider services for development, demos, and
CI.
Start Slack, GitHub, Google, Notion, Stripe, Local Mail, S3, and more with one
shared synthetic dataset. Connect your app through local APIs and protocols,
inspect live state in the Workbench, and reset it. No production accounts or
credentials are required.

For example, DropLive uses WorldFixture for product demos.

```sh
npx worldfixture up
```

All people, organizations, domains, messages, and financial records are
synthetic. WorldFixture is pre-release software. It implements selected
provider operations and does not claim full provider parity.

## Requirements

- Docker
- Node.js 22 or later
- An `arm64` or `amd64` computer

## First run

Start only Slack for the shortest first run:

```sh
npx worldfixture up --only slack
```

The command prints the Workbench URL and reports which services are still
loading. It uses a free host port, so do not assume a port number. Open the
Workbench with the printed link or:

```sh
npx worldfixture open
```

In **Chat**, send one short marker. Then open **Activity** to see the accepted
provider event. Read the same state from an application with the generated
bindings:

```sh
eval "$(npx worldfixture env)"
curl -sS -X POST "$SLACK_BASE_URL/api/conversations.list" \
  -H "Authorization: Bearer $SLACK_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data 'limit=100&types=public_channel,private_channel,mpim,im'
```

Restore and stop the world:

```sh
npx worldfixture reset
npx worldfixture down
```

If a start fails, run `npx worldfixture doctor`. It reports the problem and a
repair command. It changes no state.

Read the [five-minute quick start](docs/getting-started/quick-start.md) for the
complete path. Run the documentation website locally with:

```sh
npm --prefix docs install
npm run docs:dev
```

The website includes local search, navigation, provider support tables, SDK
examples, Workbench guidance, reset rules, HTTP targets, troubleshooting, and
contributor documentation.

## Connect an application

Use the values from the current run:

```sh
npx worldfixture env
npx worldfixture run -- npm run dev
```

For an application connector:

```sh
npx worldfixture connector prompt http://localhost:3000
npx worldfixture connector check http://localhost:3000
npx worldfixture connector plan http://localhost:3000 --scale smoke
npx worldfixture connector seed http://localhost:3000 --scale smoke
```

See [Connect an application](docs/getting-started/connect-an-app.md),
[Bindings](docs/guides/bindings.md), and the
[connector overview](docs/connectors/overview.md).

## Provider support

The [provider support index](docs/providers/index.md) states which endpoints,
writes, SDK versions, Workbench views, events, and limitations have evidence.
It uses these labels:

- Supported and contract-tested
- Supported but partial
- Workbench-only
- Not supported
- Not verified against the production provider

## Build from this checkout

```sh
npm run build:worlds
npm run build:workbench
docker buildx build --load -t worldfixture:local .
node runtime/bin/worldfixture.mjs up --image worldfixture:local
```

Create and build a world:

```sh
npx worldfixture new ./my-world
npx worldfixture validate ./my-world
npx worldfixture build ./my-world
npx worldfixture up ./dist/demo.my-world.v1
```

See [How worlds work](docs/guides/worlds.md) and
[How WorldFixture fits your development loop](docs/architecture.md).

## Development

Run the documented checks:

```sh
PYTHONPATH=compiler python3 -m unittest discover -s tests -t .
npm run docs:check
npm run docs:build
cd runtime && node --test
cd ../emulators/emulate && npm ci && node --test
cd ../http-targets && node --test test/feed-clock.test.mjs && node test/protocol-test.mjs
```

The first line is the compiler, schema and world-parity gate, and it needs
nothing but Python 3.11. The provider emulator's suite needs its pinned
dependencies installed, which is what the `npm ci` is for.

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[contract testing policy](docs/contract-testing.md), and
[how to add a provider](docs/providers/adding-a-provider.md).

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
