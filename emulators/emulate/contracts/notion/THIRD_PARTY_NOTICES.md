# Third-party notices

The three files in this directory are interface descriptions, not Notion code.
Nothing here is a copy of Notion's implementation, and the emulator does not
link against or embed any Notion software. They are vendored so that the Notion
emulator's contract tests assert against a fixed, digest-pinned description of
the real API rather than against whatever the network returned that day.

| File | Source | Retrieved | SHA-256 |
| --- | --- | --- | --- |
| `public-api-2026-03-11.openapi.json` | The official public Notion API OpenAPI description published with the API reference at https://developers.notion.com/, for `Notion-Version: 2026-03-11` | 2026-09-03 | `1542bad104f5ca9f559e34400a9206fdb672a98f5a7a9e6ae01f1a3c81655888` |
| `admin-api-2026-06-01.openapi.json` | The official Notion Admin API OpenAPI description published with the API reference at https://developers.notion.com/, for `Notion-Version: 2026-06-01` | 2026-09-03 | `3379d21cf33cad65a5fe9719ebfaf66cc884bf26de6745e9bd542171a419a772` |
| `hosted-mcp-tools-free-2026-09-03.json` | Not vendored. A `tools/list` response captured from `https://mcp.notion.com/mcp` on a Free Plan account and normalised by `runtime/bin/normalize-mcp-tools.mjs` into the `worldfixture.mcp-tools-capture/v1` envelope | 2026-09-03 | `5f417aa0b77a168737d4c680733c2492dee57583fb8909ecdaefed223c8cf8bc` |

Both OpenAPI documents carry Notion's terms of service link in their `info`
block and neither carries a licence declaration. They are redistributed here as
the published, publicly readable interface description of a public API, for the
purpose of testing an independent implementation of that interface. That is the
whole of the basis: no other Notion material is included, no Notion credential
or account data is included, and the OAuth grant used for the MCP capture was
never stored. If Notion asks for these to be removed, the tests read the paths
through the `NOTION_PUBLIC_OPENAPI` and `NOTION_ADMIN_OPENAPI` environment
overrides, so the files can be dropped and supplied locally instead.

The MCP capture is WorldFixture's own recording of a live response, made with
`worldfixture-capture` through `mcp-remote` 0.1.38 over MCP protocol version
`2025-11-25`. The request boundary was `initialize`,
`notifications/initialized`, and `tools/list`; no workspace tool was called. Its
content is the tool descriptions Notion's hosted server returns, which are
Notion's, and it is kept for the same contract-testing reason and on the same
basis as the OpenAPI documents above.

How each capture is refreshed, and the exact normalisation command, are in
[`docs/providers/notion.md`](../../../../docs/providers/notion.md).

Notion is a trademark of Notion Labs, Inc. This project is not affiliated with,
sponsored by, or endorsed by Notion Labs, Inc.
