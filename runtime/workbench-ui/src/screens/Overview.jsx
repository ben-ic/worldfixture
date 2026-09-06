import { useState } from "react";
import { post } from "../api.js";
import { serviceScreen } from "../navigation.mjs";
import { overviewExamples, peopleSelection, resourceCountText, surfaceResources, worldLabels } from "../runtime-data.mjs";
import { ActivityTable, Bindings } from "../components/RuntimeViews.jsx";
import { Button, CopyButton, Notice, Panel, SectionTitle } from "../components/Primitives.jsx";

export function Overview({ data, setScreen, onRefresh, onReset, onAction }) {
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState(null);
  const [probeError, setProbeError] = useState(null);
  const surfaces = data.surfaces ?? [];
  const probed = new Map((probe?.surfaces ?? []).map((surface) => [surface.id, surface]));
  const pending = surfaces.filter((surface) => surface.state !== "ready");
  const people = peopleSelection(data);
  const labels = worldLabels(data);
  const examples = overviewExamples(data);
  async function runProbe() {
    setProbing(true); setProbeError(null);
    try {
      const result = await post("/api/probe", {});
      setProbe(result);
      if (surfaces.length > 0 && surfaces.every((surface) => result.surfaces?.some((entry) => entry.id === surface.id && entry.ready))) {
        onAction?.({ type: "probe", target: "services", success: true });
      }
    } catch (failure) { setProbeError(failure.message); }
    finally { setProbing(false); }
  }
  return <>
    <SectionTitle number="01" title="What did I get?" detail={data.world.description}/>
    {pending.length > 0 && <Notice kind="warning"><strong>{pending.length} selected {pending.length === 1 ? "surface is" : "surfaces are"} not ready.</strong> Open <button className="link" onClick={() => setScreen("Services")}>Services</button> for the current state.</Notice>}
    <div className="metric-grid">
      <Panel className="metric"><div className="metric-top"><strong>People</strong><span>{people.worldPeople}</span></div><div className="metric-lines"><span>People in this world</span><span>{people.organizationSummary}</span><button className="link" onClick={() => setScreen("People")}>View people →</button></div></Panel>
      {surfaces.map((surface) => {
        const read = surfaceResources(data, surface);
        const measured = read.resources.some((resource) => resource.count !== null);
        return <Panel className="metric" key={surface.id}>
          <div className="metric-top"><strong>{surface.name}</strong><span>{measured ? "Available" : "Unavailable"}</span></div>
          <div className="metric-lines"><span>Runtime: {surface.state ?? "unknown"}</span>
            {read.resources.map((resource) => <span key={resource.label}>{resource.label}: {resourceCountText(resource)}</span>)}
            {!read.available && <span>{read.error}</span>}
            <button className="link" onClick={() => setScreen(serviceScreen(surface))}>Open service →</button>
          </div>
        </Panel>;
      })}
    </div>
    {surfaces.length === 0 && <Notice>No service surfaces are selected for this instance.</Notice>}
    <Panel className="story"><div><strong>{labels.heading}</strong><span>{labels.detail}</span></div><button className="link" onClick={() => setScreen("People")}>Inspect the people →</button></Panel>
    <Panel className="timeline-overview"><div><strong>Control world time</strong><p>Inspect scheduled events, pause or advance the clock, and choose whether this run repeats.</p></div><Button onClick={() => setScreen("Timeline")}>Open timeline →</Button></Panel>
    <div className="section split"><div><SectionTitle number="02" title="How does my app connect?"/><Bindings data={data} onAction={onAction}/></div>
      <div><SectionTitle number="03" title="Is it working?"/><Panel>
        {surfaces.map((surface) => {
          const measured = probed.get(surface.id);
          return <div className="surface-ready" key={surface.id}><span><i className={`state-dot ${surface.state}`}/><span><strong>{surface.name}</strong><small>{surface.implementation} {surface.version}</small></span></span><span><code className={surface.state === "ready" ? "green" : "yellow"}>{surface.state ?? "unknown"}</code><small>{measured ? `${measured.ready ? "Probe passed" : "Probe failed"} · ${measured.latency_ms} ms` : "Runtime state"}</small>{measured?.detail && <small>{measured.detail}</small>}</span></div>;
        })}
        {probeError && <Notice kind="error">Probe unavailable: {probeError}</Notice>}
        <div className="probe-row"><span>Probe the selected service endpoints. A failed probe does not count as a successful read.</span><Button onClick={runProbe} disabled={probing || surfaces.length === 0}>{probing ? "Probing…" : "Probe services"}</Button></div>
      </Panel></div>
    </div>
    <div className="section"><SectionTitle number="04" title="Try the selected connections" detail="These commands use this run's dynamic bindings."/>
      <Panel className="example-grid">{examples.map(({ name, command }) => <div className="example-card" key={name}><span>{name}</span><pre>{command}</pre><CopyButton value={command}>Copy</CopyButton></div>)}</Panel>
      <p className="muted docs-cta"><a href="/docs/getting-started/connect-an-app">Open SDK setup and complete examples</a></p>
    </div>
    <div className="section"><SectionTitle number="05" title="What happened after my app acted?" detail="Provider acceptance, runtime observation, and consequences."/><ActivityTable data={data} limit={6} onRefresh={onRefresh} onAction={onAction}/></div>
    <div className="section"><SectionTitle number="06" title="How do I get back to the start?"/><Panel className="reset-box">
      <div><strong>Reset is exact and repeatable</strong><p className="muted">Reset restores world and provider state. It preserves all application database data.</p><Button kind="danger" onClick={onReset}>Reset world services</Button></div>
      <div className="reset-steps"><span>○ Stop application surfaces</span><span>○ Restore provider and protocol state</span><span>○ Clear observed runtime events</span><span>○ Verify the accepted start</span><span>When finished: <code>npx worldfixture down</code></span></div>
    </Panel></div>
  </>;
}
