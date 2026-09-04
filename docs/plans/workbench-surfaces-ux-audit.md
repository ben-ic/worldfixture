# Workbench surface UX audit

This audit records the visible problems before the surface UX pass. The review
uses one rule: a first-time user must see the world's useful content before
protocol evidence or controls.

## Provider surfaces

- Chat can select a generated channel first. This hides the authored story in
  worlds that contain many filler channels.
- Gmail and Mail put the compose form before the mailbox. A reader sees a test
  control before the messages that explain the world.
- Code lists repositories but does not show issues. The repository names give
  structure, but the issues carry the current work.
- Files puts all objects from all buckets in one flat table. This makes bucket
  ownership difficult to scan.
- Notion starts with a coverage matrix and renders a panel for each supported
  protocol resource, including empty resources. It looks like a conformance
  report instead of a workspace.
- Website reduces the target page to a short text extract. It does not let the
  reader see the page as a website.
- Stripe, Linear, Okta, Clerk, Microsoft, Twilio, Resend, Vercel, and MongoDB
  Atlas run in the default world but have no Workbench surface.

## Runtime surfaces

- People shows provider identities, but the table does not group identity from
  organization context.
- Activity shows raw event types and identifiers with equal visual weight. The
  user action is difficult to scan.
- Target starts with Connector v1 terms before it explains the user goal.
- Settings lists runtime facts, but it does not explain their effects.
- Services shows that each service runs, but it does not link a service to the
  surface that shows its data.

## Navigation

- The sidebar can say that all services run while more than half of those
  services have no screen.
- Gmail and Mail need names that explain why both exist. The local SMTP and IMAP
  surface must use the name `Local Mail`.
- Counts must describe the content that the linked screen shows.

