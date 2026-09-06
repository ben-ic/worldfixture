import { useState } from "react";
import { bindingGroupsFor } from "../runtime-data.mjs";

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
// A CONNECTION URL CARRIES ITS PASSWORD IN THE MIDDLE OF IT.
// `POSTGRES_URL` is `postgres://worldfixture:<password>@127.0.0.1:5432/worldfixture`,
// and the name says nothing about a credential -- so masking by name alone
// printed the password in full one row under the masked `POSTGRES_PASSWORD`.
// Since those passwords became per-project generated secrets rather than a
// shared constant, that is a real value to leave on a shared screen.
const EMBEDDED_CREDENTIAL = /:\/\/[^/@\s]*:[^/@\s]+@/;
const MASK = "••••••••••••";

const isSecret = (name, value) => CREDENTIAL.test(name) || EMBEDDED_CREDENTIAL.test(value);

export function Bindings({ data, complete = false, surfaceId, onAction, compact = false }) {
  const [revealed, setRevealed] = useState(() => new Set());
  const [query, setQuery] = useState("");
  const allGroups = bindingGroupsFor(data, { surfaceId });
  const groups = bindingGroupsFor(data, { surfaceId, query });
  const entries = [...new Map(allGroups.flatMap((group) => group.entries))];
  const environment = entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
  const copied = () => onAction?.({ type: "copy", target: "bindings", ...(surfaceId === undefined ? {} : { surface: surfaceId }), success: true });

  function toggle(name) {
    setRevealed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }

  return <Panel title={surfaceId === undefined ? "Bindings for this instance" : "Bindings for this service"} tools={entries.length > 0 && <CopyButton value={environment} onCopy={copied}>Copy .env</CopyButton>}>
    {!compact && entries.length > 0 && <div className="action-form"><label>FIND A BINDING OR CAPABILITY<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Binding name or service"/></label><span className="muted">{entries.length} bindings available. Open a group to view and copy its values.</span></div>}
    {groups.map((group) => <details className="technical-details" key={group.id} open={complete || Boolean(query) || groups.length === 1}>
      <summary>{group.name ?? group.id} · {group.entries.length} bindings</summary>
      {!compact && group.capabilities?.length > 0 && <div className="panel-pad muted">{group.capabilities.join(" · ")}</div>}
      {group.entries.map(([name, value]) => {
      const secret = isSecret(name, value);
      const shown = !secret || revealed.has(name);
      return <div className="data-row binding-row" key={name}>
        <code className="blue truncate">{name}</code>
        <code className={shown ? "muted truncate" : "dim truncate"}>{shown ? value : MASK}</code>
        <span className="inline-actions">
          {secret && <Button kind="small" onClick={() => toggle(name)}
            aria-label={`${shown ? "Hide" : "Show"} ${name}`}>{shown ? "Hide" : "Show"}</Button>}
          <CopyButton value={value} onCopy={copied}/>
        </span>
      </div>;
      })}
    </details>)}
    {groups.length === 0 && <div className="empty">{entries.length ? "No bindings match this search." : "No connection bindings are declared for this selection."}</div>}
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

export function ActivityTable({ data, limit, onRefresh, onAction }) {
  const events = (data.activity ?? []).slice(0, limit ?? data.activity?.length);
  const people = new Map((data.people ?? []).map((person) => [person.id, person.name]));
  async function refresh() {
    const result = await onRefresh?.();
    if (result) onAction?.({ type: "read", target: "activity", eventIds: (result.activity ?? []).map((event) => event.id).filter(Boolean), success: true });
  }
  return <Panel title="Recent activity" tools={<button className="button small" onClick={refresh}>Refresh</button>}>
    <div className="data-row activity-columns table-head"><span>TIME</span><span>ACTOR</span><span>ACTION</span><span>ACCEPTED BY</span><span>OBSERVED</span></div>
    {events.length ? events.map((event) => <div className="data-row activity-columns" key={event.id ?? event.seq}>
      <code className="dim">{time(event.occurred_at)}</code><span className="truncate">{people.get(event.actor_id) ?? event.actor_id ?? event.source}</span>
      <span className="truncate"><strong>{eventTitle(event.type)}</strong><small>{event.type}</small></span><code className="muted">{event.source}</code><code className="blue">{event.id ?? `event ${event.seq}`}</code>
    </div>) : <div className="empty">No observed activity is available.</div>}
  </Panel>;
}
