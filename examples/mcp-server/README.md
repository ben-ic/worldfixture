# Renewal Copilot MCP server

Start WorldFixture. Then run one command here:

```sh
npm start
```

Open the printed URL. The first screen uses MCP tools to show the accepted
Lumen Labs state from Slack, Gmail, GitHub, and Stripe. Select **Run the agent**
to call the read tools and write a draft through SeaweedFS S3. The workflow
stops before it sends a message. Select **Approve and send** to call the Gmail
and Slack mutation tools.

The server is also a standard MCP stdio server:

```sh
npm run mcp
```

It supports `initialize`, `tools/list`, and `tools/call`. Provider addresses and
credentials come from `worldfixture env`. Run
`node ../../runtime/bin/worldfixture.mjs reset` to remove the draft and sent
messages and restore the accepted starting state.
