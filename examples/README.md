# Examples

Use `demo_app` for the main Account Desk demo. It currently contains design
exports, not a runnable application. Its implementation must use the installed
`worldfixture` package through the public `npx worldfixture` commands.
See the [Account Desk implementation plan](demo_app/IMPLEMENTATION_PLAN.md) for
the screens, services, build phases, and completion checks.

| Directory | Purpose | Recommendation |
| --- | --- | --- |
| `demo_app/` | Account Desk UI designs; the planned main demo and service verification app | Build this as the main app. |
| [onboarding/](onboarding/) | Small Slack examples in JavaScript, Python, and curl | Keep. These examples support the documentation. |
| [protocol-app/](protocol-app/README.md) | Python example for HTTP, SMTP, IMAP, S3, and a local callback | Keep. This shows standard protocols without a provider SDK. |
| [mcp-server/](mcp-server/README.md) | MCP stdio server and a separate Renewal Copilot browser demo | Keep the server. Consider removing the browser demo after Account Desk covers its workflow. |
| [minimal-world/](minimal-world/README.md) | Small world source used by `worldfixture new` | Keep. This is an authoring example, not an application. |
| `lib/` | Shared code used by the MCP example | Keep while it has callers. Do not copy its checkout-specific CLI calls or fixed resource names into Account Desk. |

`real-container.test.mjs` tests the MCP and Python protocol examples against a
running container. It also checks Workbench actions, fallback ports, and reset.

## Removed example

`regular-app` (Relay Digest) was removed in favor of Account Desk. Its files
remain in Git history. Account Desk does not yet replace its test coverage.

Before Account Desk is complete, add tests for the removed application flows:

- Customer reads across providers and an approved Gmail, Slack, and S3 write.
- Slack, GitHub, and Google OAuth, including token invalidation after reset.
- Connector plan without writes, authenticated seed, repeated seed and event
  delivery, status, and disabled app-owned reset.

The runtime connector tests remain. They do not prove these Account Desk flows.
