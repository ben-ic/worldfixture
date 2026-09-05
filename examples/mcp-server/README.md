# Renewal Copilot MCP server

Run these commands from the repository root:

```sh
npx worldfixture up
WORLDFIXTURE_STATE="$PWD/.worldfixture/runs/local" \
  npm --prefix examples/mcp-server start
```

Open the printed URL. The first screen uses MCP tools to show the accepted
Lumen Labs state from Slack, Gmail, GitHub, and Stripe. The example depends on
the default world, which contains Lumen Labs. Select **Run the agent** to call
the read tools and write a draft through local S3. The workflow
stops before it sends a message. Select **Approve and send** to call the Gmail
and Slack mutation tools.

The example server is also a standard MCP stdio server. It is separate from the
local Notion MCP endpoint at `${NOTION_BASE_URL}/mcp`:

```sh
WORLDFIXTURE_STATE="$PWD/.worldfixture/runs/local" \
  npm --prefix examples/mcp-server run mcp
```

It supports `initialize`, `tools/list`, and `tools/call`. Provider addresses and
credentials come from `worldfixture env`. From the repository root, run
`npx worldfixture reset` to remove the draft and sent messages and restore the
accepted starting state.
