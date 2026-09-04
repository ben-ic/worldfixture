import { CopyButton, Panel } from "./Primitives.jsx";

export function Bindings({ data, complete = false }) {
  const entries = Object.entries(data.bindings).filter(([name]) => name !== "WORKBENCH_URL");
  const visible = complete ? entries : entries.filter(([name]) => /SLACK|GITHUB|GOOGLE|S3|SMTP|IMAP|SITE/.test(name)).slice(0, 8);
  const environment = entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
  return <Panel title="Bindings for this instance" tools={<CopyButton value={environment}>Copy .env</CopyButton>}>
    {visible.map(([name, value]) => <div className="data-row binding-row" key={name}>
      <code className="blue truncate">{name}</code><code className="muted truncate">{value}</code><CopyButton value={value}/>
    </div>)}
  </Panel>;
}

function time(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ActivityTable({ data, limit, onRefresh }) {
  const events = data.activity.slice(0, limit ?? data.activity.length);
  return <Panel title="Recent activity" tools={<button className="button small" onClick={onRefresh}>Refresh</button>}>
    <div className="data-row activity-columns table-head"><span>TIME</span><span>ACTOR</span><span>ACTION</span><span>ACCEPTED BY</span><span>OBSERVED</span></div>
    {events.length ? events.map((event) => <div className="data-row activity-columns" key={event.id ?? event.seq}>
      <code className="dim">{time(event.occurred_at)}</code><span className="truncate">{event.actor_id ?? event.source}</span>
      <span className="truncate">{event.type}</span><code className="muted">{event.source}</code><code className="blue">{event.id ?? `event ${event.seq}`}</code>
    </div>) : <div className="empty">No observed changes yet. The accepted seeded state is ready.</div>}
  </Panel>;
}
