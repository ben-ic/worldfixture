import { useState } from "react";

import { Button, CopyButton, Panel } from "./Primitives.jsx";

// A CREDENTIAL IS MASKED ON THE SCREEN AND WHOLE EVERYWHERE ELSE.
//
// The world's tokens and passwords are synthetic and the reader came here to
// copy them, so they are in this page and both copy buttons hand over the real
// value. What they are not is printed at rest: a Workbench is a thing people
// screen-share and stand behind, and a column of live-looking secrets trains the
// reader to skim past them.
//
// So the value is hidden behind a toggle, per row, defaulting to hidden. This
// masks the display only; nothing is re-fetched when it is revealed, because the
// value was already sent.
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)/i;
const MASK = "••••••••••••";

export function Bindings({ data, complete = false }) {
  const [revealed, setRevealed] = useState(() => new Set());
  const entries = Object.entries(data.bindings).filter(([name]) => name !== "WORKBENCH_URL");
  const visible = complete ? entries : entries.filter(([name]) => /SLACK|GITHUB|GOOGLE|S3|SMTP|IMAP|SITE/.test(name)).slice(0, 8);
  const environment = entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");

  function toggle(name) {
    setRevealed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  return <Panel title="Bindings for this instance" tools={<CopyButton value={environment}>Copy .env</CopyButton>}>
    {visible.map(([name, value]) => {
      const secret = CREDENTIAL.test(name);
      const shown = !secret || revealed.has(name);
      return <div className="data-row binding-row" key={name}>
        <code className="blue truncate">{name}</code>
        <code className={shown ? "muted truncate" : "dim truncate"}>{shown ? value : MASK}</code>
        <span className="inline-actions">
          {secret && <Button kind="small" onClick={() => toggle(name)}
            aria-label={`${shown ? "Hide" : "Show"} ${name}`}>{shown ? "Hide" : "Show"}</Button>}
          <CopyButton value={value}/>
        </span>
      </div>;
    })}
  </Panel>;
}

function time(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function eventTitle(value = "activity") {
  const words = value.replace(/[._-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function ActivityTable({ data, limit, onRefresh }) {
  const events = data.activity.slice(0, limit ?? data.activity.length);
  const people = new Map(data.people.map((person) => [person.id, person.name]));
  return <Panel title="Recent activity" tools={<button className="button small" onClick={onRefresh}>Refresh</button>}>
    <div className="data-row activity-columns table-head"><span>TIME</span><span>ACTOR</span><span>ACTION</span><span>ACCEPTED BY</span><span>OBSERVED</span></div>
    {events.length ? events.map((event) => <div className="data-row activity-columns" key={event.id ?? event.seq}>
      <code className="dim">{time(event.occurred_at)}</code><span className="truncate">{people.get(event.actor_id) ?? event.actor_id ?? event.source}</span>
      <span className="truncate"><strong>{eventTitle(event.type)}</strong><small>{event.type}</small></span><code className="muted">{event.source}</code><code className="blue">{event.id ?? `event ${event.seq}`}</code>
    </div>) : <div className="empty">No observed changes yet. The accepted seeded state is ready.</div>}
  </Panel>;
}
