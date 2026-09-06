import { useState } from "react";
import { Avatar, Button } from "./Primitives.jsx";
import { PRIMARY_SCREENS, selectedNavigation, serviceBadge } from "../navigation.mjs";

function NavButton({ label, target = label, note, badge, screen, setScreen }) {
  return <button className={`nav-item ${screen === target ? "active" : ""}`} onClick={() => setScreen(target)}>
    <span className="nav-label">{label}{note && <small>{note}</small>}</span>
    {badge !== undefined && badge !== "" && <span className="nav-badge">{badge}</span>}
  </button>;
}

export function TopBar({ data, actor, liveState, onActors, onReset, onWorlds }) {
  const surfaces = data.surfaces ?? [], running = surfaces.filter(surface => surface.state === "ready").length;
  return <header className="topbar">
    <div className="identity"><span className="mark"/><strong>WorldFixture</strong><span className="divider"/>
      <span><span className="world-id">{data.world.id}:{data.world.version}</span><span className="world-meta">instance local · {new Date().toLocaleString()}</span></span>
    </div>
    <div className="top-actions">
      <Button className="actor-button" onClick={onActors} disabled={!(data.people ?? []).length}>{actor && <Avatar name={String(actor.name ?? actor.id)}/>}<span><small>ACTING AS</small><strong>{actor ? actor.name ?? actor.id : "No person selected"}</strong></span></Button>
      <span className={`status ${running === surfaces.length ? "" : "warn"}`}><i/>{running} of {surfaces.length} services ready <small>· {liveState === "connected" ? "updates connected" : liveState}</small></span>
      {onWorlds && <Button onClick={onWorlds}>Choose world</Button>}
      <Button onClick={onReset}>Reset world</Button>
    </div>
  </header>;
}

export function Sidebar({ data, screen, setScreen, onGuide }) {
  const navigation = selectedNavigation(data);
  const running = navigation.filter(entry => entry.surface.state === "ready").length;
  const runtimeStatus = data.phase && data.phase !== "ready" ? data.phase
    : !navigation.length ? "no services" : running === navigation.length ? "services ready"
      : navigation.some(entry => entry.surface.state === "failed") ? "failed" : "not ready";
  const groups = [...new Set(navigation.map(entry => entry.group))];
  return <aside className="sidebar">
    <div className="nav-head">WORKBENCH</div>
    {PRIMARY_SCREENS.filter(label => label !== "Services").map(label => <NavButton key={label} label={label} screen={screen} setScreen={setScreen}
      badge={label === "People" ? (data.people ?? []).length : label === "Activity" ? (data.activity ?? []).length : ""}/>) }
    <div className="nav-head">IN THIS WORLD</div>
    {groups.map(group => <div className="nav-group" key={group}><div className="nav-subhead">{group}</div>
      {navigation.filter(entry => entry.group === group).map(entry => <NavButton key={entry.id} label={entry.label} target={entry.screen} note={entry.note} badge={serviceBadge(data, entry.id)} screen={screen} setScreen={setScreen}/>) }
    </div>)}
    {!navigation.length && <p className="muted">No service surfaces are selected.</p>}
    <div className="nav-head">CATALOGUE</div>
    <NavButton label="Services" badge={`${running} / ${navigation.length}`} screen={screen} setScreen={setScreen}/>
    <div className="sidebar-foot"><button className="button small" onClick={onGuide}>Show first-run guide</button><a className="button small docs-link" href="/docs/">Read the documentation</a><code>worldfixture status</code><span>{runtimeStatus}</span></div>
  </aside>;
}

export function FirstRunGuide({ open, onClose, steps, setScreen }) {
  const [minimized, setMinimized] = useState(true);
  const complete = steps.filter(step => step.done).length;
  if (!open) return null;
  return <aside className="first-run">
    <header><span><strong>Getting started</strong><small>{complete} of {steps.length} done · current run</small></span><span><button onClick={() => setMinimized(value => !value)}>{minimized ? "Expand" : "Hide"}</button><button onClick={onClose}>Close</button></span></header>
    {!minimized && <><div className="guide-steps">{steps.length ? steps.map((step, index) => <button key={step.id} onClick={() => setScreen(step.target)} className={step.done ? "done" : ""}><i>{step.done ? "✓" : index + 1}</i><span><strong>{step.title}</strong><small>{step.body}</small></span><code>{step.done ? "done" : step.target}</code></button>) : <p>No guide actions are available for this run.</p>}</div><footer><a href="/docs/getting-started/quick-start">Open the complete five-minute guide</a></footer></>}
  </aside>;
}
