# Connect an application

Every run first tries the preferred host ports. For example, Slack uses `4703`
and the Workbench uses `4715`. If another process uses a preferred port,
WorldFixture selects a free fallback. It writes the actual connection values to
its local state directory. Always read these values. Do not copy a port from a
different run.

You can also open the Workbench and select
[**Download Postman collection**](http://127.0.0.1:4715/api/postman). The download
contains the active HTTP URLs and synthetic credentials. It includes every
registered route for each selected provider, every supported AWS action, and
every operation in the world's OpenAPI document. If WorldFixture prints a
Workbench port other than `4715`, change the port in this link. Download the
collection again after a new run or world switch. SMTP, IMAP, PostgreSQL, and
MySQL use other protocols, so they are not in the collection.

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

The example sets `base_url` from `SLACK_BASE_URL`. It uses the actual host port
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

## Discover GitHub, Slack, and Notion

Read the active bindings after startup. Each base URL below is the provider
origin; append the complete path shown in the table. The default bindings use
the selected world's primary person where the provider has personal tokens.
Confirm the identity before you select a repository, channel, or page.

| Provider | Bindings | Identity request | First discovery request | Request version and encoding |
| --- | --- | --- | --- | --- |
| GitHub | `GITHUB_BASE_URL`, `GITHUB_TOKEN` | `GET /user` | `GET /orgs/{organization}/repos?per_page=100` | Bearer token. The Node-RED report did not pin a GitHub API version header. |
| Slack | `SLACK_BASE_URL`, `SLACK_TOKEN` | `POST /api/auth.test` | `POST /api/conversations.list` with `{"types":"public_channel","exclude_archived":true,"limit":100}` | Bearer token, JSON body, `Content-Type: application/json`. No API version header. |
| Notion | `NOTION_BASE_URL`, `NOTION_TOKEN` | `GET /v1/users/me` | `POST /v1/search` with `{"filter":{"property":"object","value":"page"},"page_size":100}` | Bearer token, JSON body, `Content-Type: application/json`, `Notion-Version: 2026-03-11`. |

The Node-RED 4.1.10 report tested WorldFixture image 0.2.5 with
`business.saas-company:v3`. Its primary person was Maya Chen, and that person's
`organization_id` was `northstar-relay`. Read this relationship from the selected
world; do not use that organization for every world. The report found zero
repositories through `/user/repos` and 14 through the organization route.
This observation alone does not establish a GitHub permission defect.

For a Slack write and read-back check, select a channel with `is_member: true`,
`is_archived: false`, and `is_private: false`. Check `ok` in every Slack response.
Use POST for the discovery and history methods in this emulator. This is a local
support limit, not a claim that the production API rejects GET.

List requests can need more than one response. Follow GitHub's `Link` header
for the next page, Slack's `response_metadata.next_cursor`, and Notion's
`has_more` with `next_cursor` passed as `start_cursor`. Do not infer completion
from a short page alone. Notion block children have their own pagination.
See the official [GitHub repository reference](https://docs.github.com/en/rest/repos/repos#list-organization-repositories),
[Slack pagination guide](https://docs.slack.dev/apis/web-api/pagination/), and
[Notion pagination reference](https://developers.notion.com/reference/pagination).

For Notion, keep the page ID for API requests. `url` is a link to the page;
`public_url` is the published web URL, or `null` when unpublished. WorldFixture
serves local page links from its advertised Notion origin. This origin choice
belongs to WorldFixture; Notion's API does not require the integrating app's
origin. See the [Notion Page reference](https://developers.notion.com/reference/page).

For complete setup and limits, read the [GitHub](../providers/github.md),
[Slack](../providers/slack.md), and [Notion](../providers/notion.md) pages.
For an app with an older Node.js version, use the
[separate runtime example](../guides/embedded-runtime.md).
