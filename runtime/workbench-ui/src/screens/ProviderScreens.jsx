import { useEffect, useState } from "react";
import { post, request } from "../api.js";
import { Avatar, Button, Notice, PageHead, Panel } from "../components/Primitives.jsx";

function ActionResult({ result }) {
  if (!result) return null;
  return <Notice kind={result.error ? "error" : ""}>{result.error ?? result.message}</Notice>;
}

function useAction(onChanged) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  async function run(path, input) {
    setBusy(true); setResult(null);
    try { const value = await post(path, input); setResult(value); await onChanged(false); return value; }
    catch (error) { setResult({ error: error.message }); }
    finally { setBusy(false); }
  }
  return { busy, result, run };
}

// `user_name` IS RESOLVED BY THE WORKBENCH, NOT BY SLACK. A message from
// `conversations.history` is `{type, user, text, ts}`, so this screen used to
// attribute every message to a raw id -- "U6070E88FB" as the author and "U6"
// in the avatar, for all 1,517 messages in the large world. `slackHistory` in
// `runtime/src/workbench.mjs` now resolves the id through the provider's own
// `users.list`, and the raw id stays here as the fallback for an id even Slack
// cannot name.
export function Chat({ data, actor, onChanged, liveRevision }) {
  const channels = data.providers.slack.channels;
  // The latest conversation is the least surprising entry point in every
  // dynamic world. The same timestamp rule applies to channels and DMs.
  const firstChannel = [...channels].sort((left, right) => (right.latestTs ?? 0) - (left.latestTs ?? 0))[0];
  const [channel, setChannel] = useState(firstChannel?.id);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const action = useAction(onChanged);
  async function load() {
    if (!channel) return;
    try { setError(null); setHistory(await request(`/api/provider/slack?channel=${encodeURIComponent(channel)}`)); }
    catch (failure) { setError(failure.message); }
  }
  useEffect(() => { load(); }, [channel, liveRevision]);
  async function submit(event) {
    event.preventDefault();
    // The form element is captured BEFORE the post. React clears
    // `event.currentTarget` once a handler has awaited anything, so reading it
    // afterwards threw, and the throw skipped both the reset and the reload:
    // the message was really in Slack, the channel on screen never changed, and
    // the box still held the text that had already been sent.
    const form = event.currentTarget;
    const text = new FormData(form).get("text");
    const value = await action.run("/api/actions/slack", { channel, text, person_id: actor.id });
    if (value) { form.reset(); await load(); }
  }
  return <><PageHead title="Chat" subtitle="Slack through the real Web API. Read and post as a world person." command="Slack Web API"/>
    <div className="panel channel-layout"><nav className="channel-rail">{[...channels].sort((left, right) => (right.latestTs ?? 0) - (left.latestTs ?? 0)).map((item) => <button className={item.id === channel ? "active" : ""} key={item.id} onClick={() => setChannel(item.id)}>{item.is_im ? "○" : "#"} {item.displayName ?? item.name ?? item.id}</button>)}</nav>
      <div><header className="panel-head"><strong>Channel history · 20 newest</strong><code>conversations.history</code></header>
        {error ? <Notice kind="error">{error}</Notice> : history ? <div className="messages">{history.messages?.length ? history.messages.map((message) => <article className="message" key={message.ts}><div><Avatar name={message.user_name ?? message.user ?? "WF"}/><strong>{message.user_name ?? message.user ?? "World person"}</strong><code>{message.ts}</code></div><p>{message.text}</p></article>) : <div className="empty">No messages in this channel.</div>}</div> : <div className="loading">Loading Slack history…</div>}
        <form className="action-form" onSubmit={submit}><label>MESSAGE<textarea name="text" required placeholder={`Message this channel as ${actor.name}`}/></label><div><Button kind="primary" disabled={action.busy}>{action.busy ? "Posting…" : "Post message"}</Button><span className="muted">Sent with this person’s own Slack token.</span></div><ActionResult result={action.result}/></form>
      </div></div></>;
}

function replyAddress(value = "") {
  return value.match(/<([^>]+)>/)?.[1] ?? value.trim();
}

function replySubject(subject = "") {
  return /^re:/i.test(subject) ? subject : `Re: ${subject || "Message"}`;
}

function FolderTabs({ folder, setFolder, inboxCount, sentCount }) {
  return <div className="folder-tabs"><button className={folder === "inbox" ? "active" : ""} onClick={() => setFolder("inbox")}>Inbox <code>{inboxCount}</code></button><button className={folder === "sent" ? "active" : ""} onClick={() => setFolder("sent")}>Sent <code>{sentCount}</code></button></div>;
}

export function Gmail({ data, actor, onChanged }) {
  const action = useAction(onChanged);
  const [folder, setFolder] = useState("inbox");
  const [draft, setDraft] = useState({ to: "jon@worldfixture.test", subject: "Workbench follow-up", text: "Sent through the real Gmail API from WorldFixture." });
  const folders = data.providers.gmail;
  const mailbox = folders[folder] ?? { messages: [], resultSizeEstimate: 0 };
  const edit = (name) => (event) => setDraft((current) => ({ ...current, [name]: event.target.value }));
  const reply = (message) => {
    setDraft({ to: replyAddress(folder === "sent" ? message.to : message.from), subject: replySubject(message.subject), text: "", thread_id: message.threadId, in_reply_to: message.messageId });
    requestAnimationFrame(() => document.querySelector("#gmail-compose textarea")?.focus());
  };
  async function submit(event) { event.preventDefault(); const value = await action.run("/api/actions/gmail", { ...draft, person_id: actor.id }); if (value) setFolder("sent"); }
  return <><PageHead title="Gmail" subtitle="Google Workspace mail through the Gmail API." command="Google Gmail API"/>
    <Panel title="Gmail mailbox · 20 newest" tools={<FolderTabs folder={folder} setFolder={setFolder} inboxCount={folders.inbox?.resultSizeEstimate ?? 0} sentCount={folders.sent?.resultSizeEstimate ?? 0}/>}><div className="data-row mail-columns table-head"><span>MESSAGE</span><span>{folder === "sent" ? "TO" : "FROM"}</span><span>DATE</span><span></span></div>{mailbox.messages?.length ? mailbox.messages.map((message) => <div className="data-row mail-columns" key={message.id}><span><strong>{message.subject ?? "Gmail message"}</strong><small>{message.threadId}</small></span><code className="muted truncate">{folder === "sent" ? message.to : message.from}</code><span>{message.date ?? "—"}</span><Button kind="small" onClick={() => reply(message)}>Reply</Button></div>) : <div className="empty">This Gmail folder is empty.</div>}{mailbox.resultSizeEstimate > mailbox.messages.length && <div className="list-more muted">Showing the 20 newest. {mailbox.resultSizeEstimate - mailbox.messages.length} older messages are hidden.</div>}</Panel>
    <div className="section"><Panel title={`Compose as ${actor.name}`} tools={<code className="blue">messages.send</code>}><form id="gmail-compose" className="action-form compose-form" onSubmit={submit}><label>TO<input name="to" type="email" required value={draft.to} onChange={edit("to")}/></label><label>SUBJECT<input name="subject" required value={draft.subject} onChange={edit("subject")}/></label><label>MESSAGE<textarea name="text" required value={draft.text} onChange={edit("text")} placeholder="Write a Gmail message…"/></label><div><Button kind="primary" disabled={action.busy}>{action.busy ? "Sending…" : draft.in_reply_to ? "Send reply" : "Send message"}</Button>{draft.in_reply_to && <Button type="button" onClick={() => setDraft({ to: "", subject: "", text: "" })}>Cancel reply</Button>}</div><ActionResult result={action.result}/></form></Panel></div>
  </>;
}

export function Mail({ data, actor, onChanged }) {
  const action = useAction(onChanged);
  const [folder, setFolder] = useState("inbox");
  const [draft, setDraft] = useState({ to: data.bindings.IMAP_USERNAME, subject: "Workbench SMTP check", text: "Sent through SMTP and visible through IMAP." });
  const folders = data.providers.mail;
  const mailbox = folders[folder] ?? { mailbox: folder === "sent" ? "Sent" : "INBOX", exists: 0, messages: [] };
  const edit = (name) => (event) => setDraft((current) => ({ ...current, [name]: event.target.value }));
  const reply = (message) => {
    setDraft({ to: replyAddress(folder === "sent" ? message.headers.to : message.headers.from), subject: replySubject(message.headers.subject), text: "", in_reply_to: message.headers["message-id"] });
    requestAnimationFrame(() => document.querySelector("#smtp-compose textarea")?.focus());
  };
  async function submit(event) { event.preventDefault(); const value = await action.run("/api/actions/mail", { ...draft, person_id: actor.id }); if (value) setFolder("sent"); }
  return <><PageHead title="Local Mail" subtitle="Mail that stays in this WorldFixture instance. Read it through IMAP and send it through SMTP." command="SMTP submission · IMAP4rev1"/>
    <Panel title="Local mailboxes · 20 newest" tools={<FolderTabs folder={folder} setFolder={setFolder} inboxCount={folders.inbox?.exists ?? 0} sentCount={folders.sent?.exists ?? 0}/>}><div className="data-row mail-columns table-head"><span>MESSAGE</span><span>{folder === "sent" ? "TO" : "FROM"}</span><span>DATE</span><span></span></div>{mailbox.messages?.length ? mailbox.messages.map((message) => <div className="data-row mail-columns" key={message.seq}><span><strong>{message.headers.subject ?? "Mail message"}</strong><small>sequence {message.seq} · IMAP</small></span><code className="muted truncate">{folder === "sent" ? message.headers.to : message.headers.from}</code><span>{message.headers.date ?? "—"}</span><Button kind="small" onClick={() => reply(message)}>Reply</Button></div>) : <div className="empty">This IMAP folder is empty.</div>}{mailbox.exists > mailbox.messages.length && <div className="list-more muted">Showing the 20 newest. {mailbox.exists - mailbox.messages.length} older messages are hidden.</div>}</Panel>
    <div className="section"><Panel title={`Compose as ${actor.name}`} tools={<code className="blue">SMTP submission</code>}><form id="smtp-compose" className="action-form compose-form" onSubmit={submit}><label>TO<input name="to" type="email" required value={draft.to} onChange={edit("to")}/></label><label>SUBJECT<input name="subject" required value={draft.subject} onChange={edit("subject")}/></label><label>MESSAGE<textarea name="text" required value={draft.text} onChange={edit("text")} placeholder="Write a local mail message…"/></label><div><Button kind="primary" disabled={action.busy}>{action.busy ? "Sending…" : draft.in_reply_to ? "Send reply" : "Send through SMTP"}</Button>{draft.in_reply_to && <Button type="button" onClick={() => setDraft({ to: "", subject: "", text: "" })}>Cancel reply</Button>}</div><ActionResult result={action.result}/></form></Panel></div>
  </>;
}

// OPEN ISSUES ARE COUNTED, NOT READ. The GitHub emulator emits
// `open_issues_count` as a literal 0 and never increments it when issues are
// inserted, and `??` does not fall back over 0 -- so `open_issues_count ?? …`
// printed 0 for every repository in every world, directly under a panel header
// reporting the real total. The same bug was fixed in the sidebar and missed
// here, which is why the count is now derived in both places rather than read.
export function Code({ data, actor, onChanged }) {
  const repositories = data.providers.github.repositories;
  const issues = data.providers.github.issues ?? [];
  const action = useAction(onChanged);
  async function submit(event) { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); await action.run("/api/actions/github-issue", { ...form, person_id: actor.id }); }
  return <><PageHead title="Code" subtitle="GitHub repositories and issues through the real REST API." command="GitHub REST API"/>
    {issues.length > 0 && <Panel title={`Open issues · ${issues.length}`}><div className="data-row github-issue-columns table-head"><span>ISSUE</span><span>REPOSITORY</span><span>AUTHOR</span><span>UPDATED</span></div>{issues.map((issue) => <div className="data-row github-issue-columns" key={issue.id ?? issue.url}><span><strong>{issue.title}</strong><small>#{issue.number}</small></span><code className="muted truncate">{issue.repository?.full_name ?? issue.repository_url?.split("/repos/").at(-1) ?? "—"}</code><span>{issue.user?.login ?? "—"}</span><span>{issue.updated_at ? new Date(issue.updated_at).toLocaleDateString() : "—"}</span></div>)}</Panel>}
    <div className="section"><Panel title="Repositories"><div className="data-row resource-columns table-head"><span>REPOSITORY</span><span>DEFAULT BRANCH</span><span>OPEN ISSUES</span><span>STATE</span></div>{repositories.map((repository) => <div className="data-row resource-columns" key={repository.id ?? repository.full_name}><strong>{repository.full_name ?? repository.name}</strong><code className="muted">{repository.default_branch ?? "main"}</code><code>{issues.filter((issue) => issue.repository_url?.endsWith(`/repos/${repository.full_name}`)).length}</code><code className="green">ready</code></div>)}</Panel></div>
    <div className="section"><Panel title={`Create an issue as ${actor.name}`} tools={<code className="blue">POST /issues</code>}><form className="action-form" onSubmit={submit}><label>REPOSITORY<select name="repository">{repositories.map((repository) => <option key={repository.full_name}>{repository.full_name}</option>)}</select></label><label>TITLE<input name="title" required defaultValue="Release follow-up from Workbench"/></label><label>BODY<textarea name="text" required defaultValue="Created through the real GitHub API."/></label><Button kind="primary" disabled={action.busy}>{action.busy ? "Creating…" : "Create issue"}</Button><ActionResult result={action.result}/></form></Panel></div>
  </>;
}

export function Files({ data, actor, onChanged }) {
  const buckets = data.providers.s3.details;
  const action = useAction(onChanged);
  async function submit(event) { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); await action.run("/api/actions/s3", { ...form, person_id: actor.id }); }
  return <><PageHead title="Files" subtitle="Standalone SeaweedFS through its S3-compatible API." command="S3 ListObjectsV2 · PutObject"/>
    <div className="bucket-grid">{buckets.map((bucket) => <Panel key={bucket.name} title={bucket.name} tools={<code>{bucket.objects.length} objects</code>}>{bucket.objects.length ? bucket.objects.map((object) => <div className="data-row file-columns" key={object.key}><code className="truncate">{object.key}</code><span>{object.size.toLocaleString()} bytes</span></div>) : <div className="empty">This bucket is empty.</div>}</Panel>)}</div>
    <div className="section"><Panel title="Put an object" tools={<code className="blue">S3 PutObject</code>}><form className="action-form" onSubmit={submit}><label>BUCKET<select name="bucket">{buckets.map((bucket) => <option key={bucket.name}>{bucket.name}</option>)}</select></label><label>OBJECT KEY<input name="key" required defaultValue="workbench/note.txt"/></label><label>CONTENT<textarea name="text" required defaultValue="Created through the SeaweedFS S3 API."/></label><Button kind="primary" disabled={action.busy}>{action.busy ? "Writing…" : "Put object"}</Button><ActionResult result={action.result}/></form></Panel></div>
  </>;
}

function notionTitle(page) {
  const title = Object.values(page.properties ?? {}).find((property) => property.type === "title");
  return title?.title?.map((part) => part.plain_text ?? "").join("") || "Untitled";
}

function notionId(resource) {
  return resource.id ?? resource.notion_id ?? "—";
}

function notionText(value, fallback = "Untitled") {
  if (typeof value === "string") return value || fallback;
  if (Array.isArray(value)) return value.map((part) => part?.plain_text ?? part?.text?.content ?? "").join("") || fallback;
  return fallback;
}

function notionState(resource) {
  return resource.in_trash ? "in trash" : resource.archived ? "archived" : "available";
}

function EmptyNotion({ children }) {
  return <div className="empty">{children}</div>;
}

export function Notion({ data, onChanged }) {
  const notion = data.providers.notion ?? { users: [], pages: [], databases: [], dataSources: [], views: [], comments: [], fileUploads: [], agents: [], agentSessions: [], asyncTasks: [], changes: [] };
  const action = useAction(onChanged);
  const databases = notion.databases ?? [];
  const dataSources = notion.dataSources ?? [];
  const views = notion.views ?? [];
  const comments = notion.comments ?? [];
  const fileUploads = notion.fileUploads ?? [];
  const asyncTasks = notion.asyncTasks ?? [];
  const agents = notion.agents ?? [];
  const agentSessions = notion.agentSessions ?? [];
  const webhookSubscriptions = notion.webhookSubscriptions ?? [];
  const webhookDeliveries = notion.webhookDeliveries ?? [];
  const connectionTokens = notion.connectionTokens ?? [];
  const legalHolds = notion.legalHolds ?? [];
  const adminGroups = notion.groups ?? [];
  const adminAgents = notion.adminAgents ?? [];
  const personalAccessTokens = notion.personalAccessTokens ?? [];
  const mcpClientConnections = notion.mcpClientConnections ?? [];
  const changes = [...(notion.changes ?? [])].sort((left, right) => Number(right.sequence ?? 0) - Number(left.sequence ?? 0)).slice(0, 20);
  const [revealedWebhookValues, setRevealedWebhookValues] = useState({});
  const [selectedPage, setSelectedPage] = useState(null);
  async function createWebhook(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await action.run("/api/actions/notion-admin", { operation: "create_webhook", url: form.url, event_types: String(form.event_types).split(",").map((value) => value.trim()).filter(Boolean) });
  }
  const verifyWebhook = (subscription) => action.run("/api/actions/notion-admin", { operation: "verify_webhook", id: subscription.notion_id });
  const deleteWebhook = (subscription) => action.run("/api/actions/notion-admin", { operation: "delete_webhook", id: subscription.notion_id });
  const revokeTokens = (token) => action.run("/api/actions/notion-admin", { operation: "revoke_tokens", client_id: token.client_id, user_id: token.user_id });
  const updateAgentStatus = (agent) => action.run("/api/actions/notion-admin", { operation: "update_agent_status", agent_id: agent.id, status: agent.status === "active" ? "disabled" : "active" });
  const updateAgentCredit = (event, agent) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); return action.run("/api/actions/notion-admin", { operation: "update_agent_credit", agent_id: agent.id, credit_limit: form.credit_limit }); };
  const createAdminGroup = (event) => { event.preventDefault(); const form = Object.fromEntries(new FormData(event.currentTarget)); return action.run("/api/actions/notion-admin", { operation: "create_admin_group", space_id: notion.spaceId, name: form.name }); };
  const revokeAdminPat = (token) => action.run("/api/actions/notion-admin", { operation: "revoke_admin_pat", space_id: notion.spaceId, bot_id: token.id });
  const revokeAdminMcp = (connection) => action.run("/api/actions/notion-admin", { operation: "revoke_admin_mcp", space_id: notion.spaceId, client_key: connection.client.key, user_id: connection.user.id });
  async function revealWebhookValue(kind, id) {
    const value = await action.run("/api/inspect/notion/webhook-value", { kind, id });
    if (value?.result) setRevealedWebhookValues((current) => ({ ...current, [`${kind}:${id}`]: value.result }));
  }
  return <div className="notion-surface"><PageHead title="Notion" subtitle="Pages, databases, and people in this workspace." command={`${notion.pages.length} pages`}/>
    {!notion.available && <Notice kind="error">Notion is unavailable. The Workbench kept the page usable and shows empty provider data.</Notice>}
    <ActionResult result={action.result}/>
    <details className="technical-details notion-evidence"><summary>API and support details</summary><Panel title="Workbench support and evidence" tools={<code className="blue">Visible coverage, not a completeness claim</code>}>
      <div className="data-row resource-columns table-head"><span>SURFACE</span><span>EVIDENCE</span><span>VISIBLE HERE</span><span>LIMIT</span></div>
      <div className="data-row resource-columns"><strong>REST</strong><code>Notion-Version 2026-03-11</code><span>Selected resource lists</span><span className="muted">Not every public route has a control</span></div>
      <div className="data-row resource-columns"><strong>MCP</strong><code>Streamable HTTP 2025-11-25</code><span>Sessions, call names, and outcomes</span><span className="muted">Call payload details are not shown</span></div>
      <div className="data-row resource-columns"><strong>OAuth</strong><code>Redacted inspection state</code><span>Grant owner, client, generation, state</span><span className="muted">Tokens and client secrets stay server-side</span></div>
      <div className="data-row resource-columns"><strong>Files</strong><code>GET /v1/file_uploads</code><span>Public upload metadata</span><span className="muted">S3 bucket and object keys stay hidden</span></div>
      <div className="data-row resource-columns"><strong>Webhooks</strong><code>Local signed capture</code><span>Subscriptions and captured events</span><span className="muted">External delivery is disabled</span></div>
      <div className="data-row resource-columns"><strong>Agent API</strong><code>/v1/agents · /v1/sessions</code><span>Lists, status, credit, and session state</span><span className="muted">Only selected actions are present</span></div>
      <div className="data-row resource-columns"><strong>Workers</strong><code>@notionhq/workers@0.9.0 runtime</code><span>Not connected to this Workbench</span><span className="muted">No live Worker state is claimed</span></div>
      <div className="data-row resource-columns"><strong>Admin</strong><code>Notion-Version 2026-06-01</code><span>Selected governance resources</span><span className="muted">Requires an organization token</span></div>
    </Panel></details>
    <Panel className="notion-pages" title={`Pages · ${notion.pages.length}`} tools={<code className="blue">Workspace content</code>}>
      <div className="data-row resource-columns table-head"><span>PAGE</span><span>ID</span><span>UPDATED</span><span>STATE</span></div>
      {notion.pages.map((page) => <button className="data-row resource-columns clickable-row" key={page.id} onClick={() => setSelectedPage(page)}><strong>{notionTitle(page)}</strong><code className="muted truncate">{page.id}</code><span>{page.last_edited_time}</span><code className={page.in_trash ? "yellow" : "green"}>{page.in_trash ? "in trash" : "available"}</code></button>)}
      {!notion.pages.length && <EmptyNotion>No pages are visible to the selected Notion token.</EmptyNotion>}
    </Panel>
    <div className="section"><Panel title={`Databases · ${databases.length}`} tools={<code className="blue">GET /v1/databases/:id</code>}>
      <div className="data-row resource-columns table-head"><span>DATABASE</span><span>ID</span><span>PARENT</span><span>STATE</span></div>
      {databases.map((database) => <div className="data-row resource-columns" key={notionId(database)}><strong>{notionText(database.title, "Untitled database")}</strong><code className="muted truncate">{notionId(database)}</code><code className="muted truncate">{database.parent?.page_id ?? database.parent?.database_id ?? database.parent?.type ?? "workspace"}</code><code className={database.in_trash || database.archived ? "yellow" : "green"}>{notionState(database)}</code></div>)}
      {!databases.length && <EmptyNotion>No databases are visible to the selected Notion token.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Data sources · ${dataSources.length}`} tools={<code className="blue">GET /v1/data_sources/:id</code>}>
      <div className="data-row resource-columns table-head"><span>DATA SOURCE</span><span>ID</span><span>PROPERTIES</span><span>STATE</span></div>
      {dataSources.map((source) => <div className="data-row resource-columns" key={notionId(source)}><span><strong>{notionText(source.title ?? source.name, "Untitled data source")}</strong><small>{source.parent?.database_id ?? source.database_id ?? "No database"}</small></span><code className="muted truncate">{notionId(source)}</code><code>{Object.keys(source.properties ?? {}).length}</code><code className={source.in_trash || source.archived ? "yellow" : "green"}>{notionState(source)}</code></div>)}
      {!dataSources.length && <EmptyNotion>No data sources are visible to the selected Notion token.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Views · ${views.length}`} tools={<code className="blue">GET /v1/views</code>}>
      <div className="data-row resource-columns table-head"><span>VIEW</span><span>ID</span><span>TYPE</span><span>DATA SOURCE</span></div>
      {views.map((view) => <div className="data-row resource-columns" key={notionId(view)}><strong>{notionText(view.name ?? view.title, "Untitled view")}</strong><code className="muted truncate">{notionId(view)}</code><code>{view.type ?? "—"}</code><code className="muted truncate">{view.parent?.data_source_id ?? view.data_source_id ?? "—"}</code></div>)}
      {!views.length && <EmptyNotion>No saved views are visible to the selected Notion token.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Comments · ${comments.length}`} tools={<code className="blue">GET /v1/comments</code>}>
      <div className="data-row resource-columns table-head"><span>COMMENT</span><span>ID</span><span>AUTHOR</span><span>UPDATED</span></div>
      {comments.map((comment) => <div className="data-row resource-columns" key={notionId(comment)}><strong className="truncate">{notionText(comment.rich_text, "Empty comment")}</strong><code className="muted truncate">{notionId(comment)}</code><code className="muted truncate">{comment.created_by?.id ?? "—"}</code><span>{comment.last_edited_time ?? comment.created_time ?? "—"}</span></div>)}
      {!comments.length && <EmptyNotion>No comments are visible to the selected Notion token.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`File uploads · ${fileUploads.length}`} tools={<code className="blue">GET /v1/file_uploads</code>}>
      <div className="data-row resource-columns table-head"><span>FILE</span><span>ID</span><span>SIZE</span><span>STATUS</span></div>
      {fileUploads.map((upload) => <div className="data-row resource-columns" key={notionId(upload)}><strong>{upload.filename ?? "Unnamed file"}</strong><code className="muted truncate">{notionId(upload)}</code><span>{upload.content_length ?? "—"}</span><code className={upload.status === "uploaded" ? "green" : "yellow"}>{upload.status ?? "unknown"}</code></div>)}
      {!fileUploads.length && <EmptyNotion>No Notion file uploads have been created.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Async tasks · ${asyncTasks.length}`} tools={<code className="blue">IDs from inspection · GET /v1/async_tasks/:id supported</code>}>
      <div className="data-row resource-columns table-head"><span>TASK</span><span>ID</span><span>STATUS</span><span>UPDATED</span></div>
      {asyncTasks.slice(-20).reverse().map((task) => <div className="data-row resource-columns" key={notionId(task)}><strong>{task.type ?? task.kind ?? task.operation ?? "Notion task"}</strong><code className="muted truncate">{notionId(task)}</code><code className={task.status === "failed" || task.status === "error" ? "yellow" : "green"}>{task.status ?? "unknown"}</code><span>{task.last_edited_time ?? task.updated_at ?? task.created_at ?? "—"}</span></div>)}
      {!asyncTasks.length && <EmptyNotion>No asynchronous tasks have been recorded.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Recent mutations · ${notion.changes?.length ?? 0}`} tools={<code className="blue">latest 20</code>}>
      <div className="data-row resource-columns table-head"><span>CHANGE</span><span>OBJECT</span><span>ACTOR</span><span>TIME</span></div>
      {changes.map((change) => <div className="data-row resource-columns" key={change.sequence ?? `${change.topic}-${change.object_id}`}><strong>{change.topic ?? change.type ?? "mutation"}</strong><code className="muted truncate">{change.object_id ?? change.object?.id ?? "—"}</code><code className="muted truncate">{change.actor_id ?? change.actor?.id ?? "—"}</code><span>{change.occurred_at ?? change.created_at ?? "—"}</span></div>)}
      {!changes.length && <EmptyNotion>No Notion mutations have been recorded.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Workspace users · ${notion.users.length}`} tools={<code className="blue">GET /v1/users</code>}>
      <div className="data-row resource-columns table-head"><span>USER</span><span>EMAIL</span><span>TYPE</span><span>STATE</span></div>
      {notion.users.map((user) => <div className="data-row resource-columns" key={user.id}><strong>{user.name}</strong><code className="muted truncate">{user.person?.email ?? "—"}</code><code>{user.type}</code><code className="green">available</code></div>)}
      {!notion.users.length && <EmptyNotion>No workspace users are visible.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Current Agent API · ${agents.length}`} tools={<code className="blue">POST /v1/agents/query</code>}>
      <div className="data-row resource-columns table-head"><span>AGENT</span><span>STATUS</span><span>CREDIT LIMIT</span><span>ACTION</span></div>
      {agents.map((agent) => <div className="data-row resource-columns" key={agent.id}><span><strong>{agent.name}</strong><small className="truncate">{agent.description ?? "No description"}</small></span><code className={agent.status === "active" ? "green" : "yellow"}>{agent.status}</code><form className="inline-actions" onSubmit={(event) => updateAgentCredit(event, agent)}><input name="credit_limit" type="number" min="0" placeholder="No limit" defaultValue={typeof agent.credit_limit === "number" ? agent.credit_limit : ""}/><Button kind="small" disabled={action.busy}>Set</Button></form><Button kind="small" onClick={() => updateAgentStatus(agent)} disabled={agent.status === "deleted" || action.busy}>{agent.status === "active" ? "Disable" : "Enable"}</Button></div>)}
      {!agents.length && <EmptyNotion>No Custom Agents are visible to this token.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Agent sessions · ${agentSessions.length}`} tools={<code className="blue">POST /v1/sessions/query</code>}>
      <div className="data-row resource-columns table-head"><span>SESSION</span><span>AGENT</span><span>MESSAGES</span><span>STATUS</span></div>
      {agentSessions.map((session) => <div className="data-row resource-columns" key={session.id}><strong className="truncate">{session.title}</strong><code className="muted truncate">{session.agent_id}</code><span>{session.message_count ?? 0}</span><code className={session.status === "completed" ? "green" : "yellow"}>{session.status}</code></div>)}
      {!agentSessions.length && <EmptyNotion>No Agent sessions have run.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title="MCP connection"><div className="detail-grid"><strong>Transport</strong><span>Streamable HTTP</span><strong>MCP URL</strong><code>{notion.mcpUrl ?? "Not selected"}</code><strong>Advertised tools</strong><span>Search and fetch; page, database, data-source, view, comment, file, attachment, and skill operations; Custom Agent and session operations; identity reads; and async task reads. OpenAI clients receive <code>search</code> and <code>fetch</code> aliases.</span><strong>Authorization</strong><span>OAuth authorization code with PKCE S256</span><strong>Sessions</strong><span>{notion.mcpSessions?.length ?? 0}</span><strong>Calls</strong><span>{notion.mcpCalls?.length ?? 0}</span></div></Panel></div>
    <div className="section"><Panel title={`OAuth grants · ${connectionTokens.length}`} tools={<code className="blue">Redacted Workbench inspection and revocation</code>}>
      <div className="data-row resource-columns table-head"><span>CLIENT</span><span>USER</span><span>GENERATION</span><span>STATE</span></div>
      {connectionTokens.map((token) => <div className="data-row resource-columns" key={`${token.client_id}-${token.user_id}-${token.generation}`}><code className="truncate">{token.client_id}</code><code className="muted truncate">{token.user_id}</code><span>{token.generation}</span>{token.active ? <Button kind="small" onClick={() => revokeTokens(token)}>Revoke</Button> : <code className="muted">revoked</code>}</div>)}
      {!connectionTokens.length && <EmptyNotion>No OAuth connection tokens have been issued.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Enterprise legal holds · ${legalHolds.length}`} tools={<code className="blue">Admin 2026-06-01</code>}>
      <div className="data-row resource-columns table-head"><span>HOLD</span><span>STATUS</span><span>USERS</span><span>START</span></div>
      {legalHolds.map((hold) => <div className="data-row resource-columns" key={hold.id}><strong>{hold.name ?? hold.id}</strong><code className={hold.status === "active" ? "green" : "muted"}>{hold.status}</code><span>{hold.users?.total ?? 0}</span><span>{new Date(hold.start_date).toLocaleDateString()}</span></div>)}
      {!legalHolds.length && <EmptyNotion>No legal holds exist.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Enterprise permission groups · ${adminGroups.length}`} tools={<code className="blue">/admin/v1/spaces/:id/groups</code>}>
      <form className="action-form" onSubmit={createAdminGroup}><label>GROUP NAME<input name="name" required maxLength="200" placeholder="Release reviewers"/></label><Button kind="primary" disabled={action.busy}>Create group</Button></form>
      <div className="data-row resource-columns table-head"><span>GROUP</span><span>ID</span><span></span><span>STATE</span></div>
      {adminGroups.map((group) => <div className="data-row resource-columns" key={group.id}><strong>{group.name}</strong><code className="muted truncate">{group.id}</code><span></span><code className="green">available</code></div>)}
      {!adminGroups.length && <EmptyNotion>No enterprise permission groups exist.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Enterprise Admin Agent records · ${adminAgents.length}`} tools={<code className="blue">GET /admin/v1/spaces/:id/agents</code>}>
      <div className="data-row resource-columns table-head"><span>AGENT</span><span>TYPE</span><span>STATUS</span><span>ALIVE</span></div>
      {adminAgents.map((agent) => <div className="data-row resource-columns" key={agent.id}><strong>{agent.name ?? agent.id}</strong><code>{agent.type}</code><code className={agent.status === "active" ? "green" : "yellow"}>{agent.status}</code><span>{agent.alive ? "yes" : "no"}</span></div>)}
      {!adminAgents.length && <EmptyNotion>No enterprise Agent records are visible.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Personal access tokens · ${personalAccessTokens.length}`} tools={<code className="blue">GET /admin/v1/spaces/:id/personal_access_tokens</code>}>
      <div className="data-row resource-columns table-head"><span>TOKEN</span><span>CREATOR</span><span>STATUS</span><span>ACTION</span></div>
      {personalAccessTokens.map((token) => <div className="data-row resource-columns" key={token.id}><strong>{token.name ?? token.id}</strong><code className="muted truncate">{token.creator?.email ?? token.creator?.id}</code><code className={token.status === "active" ? "green" : "muted"}>{token.status}</code>{token.status === "active" ? <Button kind="small" onClick={() => revokeAdminPat(token)}>Revoke</Button> : <span>—</span>}</div>)}
      {!personalAccessTokens.length && <EmptyNotion>No personal access tokens are recorded.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`MCP client connections · ${mcpClientConnections.length}`} tools={<code className="blue">GET /admin/v1/mcp_client_connections</code>}>
      <div className="data-row resource-columns table-head"><span>CLIENT</span><span>USER</span><span>MANAGED</span><span>ACTION</span></div>
      {mcpClientConnections.map((connection) => <div className="data-row resource-columns" key={`${connection.client.key}-${connection.user.id}`}><strong>{connection.client.name}</strong><code className="muted truncate">{connection.user.id}</code><span>{connection.is_enterprise_managed ? "yes" : "no"}</span><Button kind="small" onClick={() => revokeAdminMcp(connection)}>Revoke</Button></div>)}
      {!mcpClientConnections.length && <EmptyNotion>No MCP client connections are recorded.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Webhook subscriptions · ${webhookSubscriptions.length}`} tools={<code className="blue">connection settings emulation</code>}>
      {!notion.liveWebhookDelivery && <Notice>Webhook events are signed and captured locally. External delivery is disabled.</Notice>}
      {!notion.webhookSecretRevealEnabled && <Notice>Webhook value reveal is disabled. Set <code>WORLDFIXTURE_WORKBENCH_REVEAL_WEBHOOK_SECRETS=1</code> for a development run.</Notice>}
      <form className="action-form" onSubmit={createWebhook}><label>HTTPS URL<input name="url" type="url" required defaultValue="https://hooks.worldfixture.test/notion"/></label><label>EVENT TYPES<input name="event_types" required defaultValue="page.created,page.properties_updated,page.content_updated"/></label><Button kind="primary" disabled={action.busy}>{action.busy ? "Saving…" : "Create subscription"}</Button></form>
      <div className="data-row resource-columns table-head"><span>URL</span><span>EVENTS</span><span>STATE</span><span>ACTION</span></div>
      {webhookSubscriptions.map((subscription) => <div key={subscription.notion_id}><div className="data-row resource-columns"><code className="truncate">{subscription.url}</code><span className="truncate">{subscription.event_types.join(", ")}</span><code className={subscription.status === "active" ? "green" : "yellow"}>{subscription.status}</code><span>{subscription.status === "pending" && <Button kind="small" onClick={() => verifyWebhook(subscription)}>Verify</Button>} {subscription.status === "pending" && notion.webhookSecretRevealEnabled && <Button kind="small" onClick={() => revealWebhookValue("verification_token", subscription.notion_id)}>Reveal token</Button>} <Button kind="small" onClick={() => deleteWebhook(subscription)}>Delete</Button></span></div>{revealedWebhookValues[`verification_token:${subscription.notion_id}`] && <pre className="secret-reveal">{revealedWebhookValues[`verification_token:${subscription.notion_id}`].verification_token}</pre>}</div>)}
      {!webhookSubscriptions.length && <EmptyNotion>No webhook subscriptions exist.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Captured webhook deliveries · ${webhookDeliveries.length}`}>
      <div className="data-row resource-columns table-head"><span>EVENT</span><span>ENTITY</span><span>SIGNATURE FINGERPRINT</span><span>STATE</span></div>
      {webhookDeliveries.slice(-20).reverse().map((delivery) => <div key={delivery.notion_id}><div className="data-row resource-columns"><strong>{delivery.event_type}</strong><code className="muted truncate">{delivery.payload?.entity?.id ?? "—"}</code><code className="muted truncate">{delivery.signature_fingerprint ?? "hidden"}</code><span><code className="green">{delivery.status}</code> {notion.webhookSecretRevealEnabled && <Button kind="small" onClick={() => revealWebhookValue("delivery", delivery.notion_id)}>Reveal request</Button>}</span></div>{revealedWebhookValues[`delivery:${delivery.notion_id}`] && <pre className="secret-reveal">{JSON.stringify(revealedWebhookValues[`delivery:${delivery.notion_id}`], null, 2)}</pre>}</div>)}
      {!webhookDeliveries.length && <EmptyNotion>No webhook events have been captured.</EmptyNotion>}
    </Panel></div>
    <div className="section"><Panel title={`Recent MCP calls · ${notion.mcpCalls?.length ?? 0}`}>
      <div className="data-row resource-columns table-head"><span>TOOL</span><span>USER</span><span>SESSION</span><span>RESULT</span></div>
      {(notion.mcpCalls ?? []).slice(-20).reverse().map((call) => <div className="data-row resource-columns" key={call.sequence}><code>{call.tool}</code><code className="muted truncate">{call.user_id}</code><code className="muted truncate">{call.session_id ?? "stateless"}</code><code className={call.is_error ? "yellow" : "green"}>{call.is_error ? "error" : "success"}</code></div>)}
    </Panel></div>
    {selectedPage && <aside className="detail-drawer"><header><strong>{notionTitle(selectedPage)}</strong><Button kind="small" onClick={() => setSelectedPage(null)}>Close</Button></header><div className="notion-page-detail"><span>PAGE</span><h2>{notionTitle(selectedPage)}</h2><p>Updated {selectedPage.last_edited_time ?? "at an unknown time"}</p><code>{selectedPage.id}</code>{selectedPage.url && <Button onClick={() => window.open(selectedPage.url, "_blank")}>Open page URL</Button>}</div></aside>}
  </div>;
}

export function Website({ data }) {
  const targets = data.providers.website.targets ?? [];
  const groups = ["RSS", "Changing page", "stable probe", "failing probe", "flapping probe", "OpenAPI", "JSON API", "Metrics"];
  return <><PageHead title="Website" subtitle="One local site with pages, RSS, JSON, metrics, and predictable failures." command="SITE_BASE_URL"/>
    <Panel title="Live preview" tools={<Button kind="small" onClick={() => window.open(data.bindings.SITE_BASE_URL, "_blank")}>Open in a new tab</Button>}><iframe className="website-preview" src={data.bindings.SITE_BASE_URL} title="World website preview"/><div className="website-fallback"><strong>Current response</strong><p className="muted">{data.providers.website.preview}</p><code>{data.bindings.SITE_BASE_URL}</code></div></Panel>
    <div className="section"><Panel title="Targets in this world"><div className="target-groups">{groups.map((group) => {
      const matches = targets.filter((target) => target.kind === group);
      if (!matches.length) return null;
      return <div className="target-group" key={group}><strong>{group}</strong><span>{group.includes("probe") ? "Repeat the request to see its configured status sequence." : group === "RSS" ? "Subscribe with a reader. More items can arrive while this run is active." : "Open the active local target."}</span>{matches.map((target) => <a key={target.url} href={target.url} target="_blank" rel="noreferrer"><span>{target.name}</span><code>{target.path}</code></a>)}</div>;
    })}</div></Panel></div>
  </>;
}
