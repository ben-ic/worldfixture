import { useEffect, useRef, useState } from "react";
import { generationResponse, request } from "../api.js";
import { serviceScreen } from "../navigation.mjs";
import { peopleSelection, resourceCountText, surfaceResources, worldLabels } from "../runtime-data.mjs";
import { acceptClockSample, clockSample, elapsedLabel, readClockCommandResponse, timelineReadReady } from "../timeline-model.mjs";
import { Bindings } from "../components/RuntimeViews.jsx";
import { Button, Notice, Panel } from "../components/Primitives.jsx";
import { TimelineControls } from "./Timeline.jsx";

function WorldStream({ setScreen, onChanged, session }) {
  const [sample, setSample] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(null);
  const latest = useRef(null), lifetime = useRef(null);
  function receive(value) { const next = acceptClockSample(latest.current, clockSample(value, performance.now())); latest.current = next; setSample(next); }
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    const poll = async () => { try { const value = await request("/api/clock", { signal: abort.signal }); if (!abort.signal.aborted) { receive(value); setError(null); } } catch (cause) { if (!abort.signal.aborted) setError(cause.message); } };
    poll(); const timer = setInterval(poll, 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, []);
  async function command(input) {
    setBusy(input.action); setError(null);
    try {
      const response = await generationResponse("/api/clock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: lifetime.current?.signal });
      const result = await readClockCommandResponse(response);
      if (lifetime.current?.signal.aborted) return;
      if (result.status) receive(result.status);
      if (!result.accepted) setError(result.error);
      await onChanged?.();
    } catch (cause) { if (!lifetime.current?.signal.aborted) setError(cause.message); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(null); }
  }
  const totals = sample?.status.timeline;
  return <div className="overview-stream">
    <div className="overview-section-head"><h2>Event stream</h2><Button kind="small" onClick={() => setScreen("Timeline")}>Open timeline →</Button></div>
    {error && <Notice kind="error">{error}</Notice>}
    {sample ? <><TimelineControls sample={sample} busy={busy || Boolean(error)} onCommand={command} reconnectRequired={session?.reconnect_required}/>
      {timelineReadReady(sample.status) && <div className="overview-totals"><span><strong>{totals.delivered}</strong> delivered</span><span><strong>{totals.pending}</strong> pending</span><span><strong>{totals.failed + totals.uncertain}</strong> need review</span><span>Next event <strong>{totals.next_due_ms === null ? "Schedule complete" : elapsedLabel(totals.next_due_ms)}</strong></span></div>}
    </> : <Notice>Reading the world clock…</Notice>}
  </div>;
}

export function Overview({ data, setScreen, onRefresh, onAction, session }) {
  const surfaces = data.surfaces ?? [], labels = worldLabels(data), people = peopleSelection(data);
  const [selected, setSelected] = useState(surfaces[0]?.id);
  const surfaceId = surfaces.some(surface => surface.id === selected) ? selected : surfaces[0]?.id;
  const ready = surfaces.filter(surface => surface.state === "ready").length;
  const peopleById = new Map((data.people ?? []).map(person => [person.id, person.name]));
  return <div className="overview-page">
    <header className="overview-header"><div><small>YOUR WORLD</small><h1>{labels.heading}</h1><p>{data.world.description || labels.detail}</p></div>
      <div className="overview-health"><button className="link" onClick={() => setScreen("Services")}>{ready} of {surfaces.length} services ready</button><button className="link" onClick={() => setScreen("People")}>{people.worldPeople} people →</button></div>
    </header>
    {ready < surfaces.length && <Notice kind="warning">Some services are not ready. Open Services to see their state.</Notice>}
    <WorldStream setScreen={setScreen} onChanged={onRefresh} session={session}/>
    <div className="overview-columns">
      <div><div className="overview-section-head"><h2>Connect your app</h2><a href="/docs/getting-started/connect-an-app">Setup guide ↗</a></div>
        {surfaces.length ? <><label className="overview-service">Service<select value={surfaceId} onChange={event => setSelected(event.target.value)}>{surfaces.map(surface => <option key={surface.id} value={surface.id}>{surface.name}</option>)}</select></label><Bindings key={surfaceId} compact data={data} surfaceId={surfaceId} onAction={onAction}/></> : <Notice>No services are selected.</Notice>}
      </div>
      <div><div className="overview-section-head"><h2>Recent activity</h2><Button kind="small" onClick={() => setScreen("Activity")}>View all →</Button></div>
        <Panel>{(data.activity ?? []).slice(0, 3).map(event => { let evidence = event.provider_evidence ?? {}; if (typeof evidence === "string") { try { evidence = JSON.parse(evidence); } catch { evidence = {}; } } return <article className="overview-activity" key={event.id}><small>{peopleById.get(event.actor_id) ?? event.source ?? "World"} · {event.occurred_at ? new Date(event.occurred_at).toLocaleTimeString() : ""}</small><strong>{event.type?.replace(/[._]+/g, " ")}</strong>{(evidence.text || evidence.subject || evidence.reason) && <p>{evidence.text || evidence.subject || evidence.reason}</p>}</article>; })}{!data.activity?.length && <p className="empty">Events will appear here after delivery.</p>}</Panel>
      </div>
    </div>
    <details className="overview-services"><summary>Explore services · {surfaces.length} selected</summary><div className="metric-grid">{surfaces.map(surface => { const read = surfaceResources(data, surface); return <Panel key={surface.id} className="metric"><div className="metric-top"><strong>{surface.name}</strong><span>{surface.state}</span></div><div className="metric-lines">{read.resources.map(resource => <span key={resource.label}>{resource.label}: {resourceCountText(resource)}</span>)}{!read.available && <span>Unavailable · {read.error}</span>}<button className="link" onClick={() => setScreen(serviceScreen(surface))}>Open service →</button></div></Panel>; })}</div></details>
  </div>;
}
