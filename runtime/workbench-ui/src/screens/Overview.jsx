import { useState } from "react";
import { post } from "../api.js";
import { ActivityTable, Bindings } from "../components/RuntimeViews.jsx";
import { Button, Panel, SectionTitle } from "../components/Primitives.jsx";

export function Overview({ data, setScreen, onRefresh, onReset }) {
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState(null);
  const gmailNow = (data.providers.gmail.inbox?.resultSizeEstimate ?? 0) + (data.providers.gmail.sent?.resultSizeEstimate ?? 0);
  const mailNow = (data.providers.mail.inbox?.exists ?? 0) + (data.providers.mail.sent?.exists ?? 0);
  const metrics = [
    ["People", data.world.people, [data.world.company, "provider identities included"]],
    ["Slack", `${data.providers.slack.messageCount} now`, [`${data.world.slackMessages} seeded at start`, `${data.providers.slack.channels.length} visible channels`]],
    ["Mail", `${gmailNow} Gmail now`, [`${mailNow} SMTP/IMAP now`, `${data.world.mailMessages} authored records seeded at start`]],
    ["Code & files", `${data.providers.github.repositories.length} repos`, [`${data.providers.s3.details.length} S3 buckets`, "HTTP target included"]],
  ];
  const priority = ["slack", "microsoft", "mail", "s3", "github", "http"];
  const surfaces = [...data.surfaces].sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id)).filter((surface) => priority.includes(surface.id));
  const probed = new Map((probe?.surfaces ?? []).map((surface) => [surface.id, surface]));
  async function runProbe() { setProbing(true); try { setProbe(await post("/api/probe", {})); } finally { setProbing(false); } }
  return <>
    <SectionTitle number="01" title="What did I get?" detail={data.world.description}/>
    <div className="metric-grid">{metrics.map(([title, value, lines]) => <Panel className="metric" key={title}>
      <div className="metric-top"><strong>{title}</strong><span>{value}</span></div><div className="metric-lines">{lines.map((line) => <span key={line}>{line}</span>)}</div>
    </Panel>)}</div>
    <Panel className="story"><div><strong>{data.world.company}</strong><span>{data.world.title} · {data.world.id}:{data.world.version}</span></div><button className="link" onClick={() => setScreen("People")}>Inspect the people →</button></Panel>
    <div className="section split"><div><SectionTitle number="02" title="How does my app connect?"/><Bindings data={data}/></div>
      <div><SectionTitle number="03" title="Is it working?"/><Panel>
        {surfaces.map((surface) => { const measured = probed.get(surface.id); return <div className="surface-ready" key={surface.id}><span><i className={`state-dot ${surface.state}`}/><span><strong>{surface.name}</strong><small>{surface.implementation} {surface.version}</small></span></span><span><code className={surface.state === "ready" ? "green" : "yellow"}>{surface.state}</code><small>{measured ? `${measured.latency_ms} ms` : "runtime checked"}</small></span></div>; })}
        <div className="probe-row"><span>{probe ? "Application bindings reached these service surfaces." : "Readiness is checked by the runtime. Probe to prove the application bindings too."}</span><Button onClick={runProbe} disabled={probing}>{probing ? "Probing…" : probe ? "Probe again" : "Probe from my app"}</Button></div>
      </Panel></div>
    </div>
    <div className="section"><SectionTitle number="04" title="What happened after my app acted?" detail="Provider acceptance, runtime observation, and consequences."/><ActivityTable data={data} limit={6} onRefresh={onRefresh}/></div>
    <div className="section"><SectionTitle number="05" title="How do I get back to the start?"/><Panel className="reset-box">
      <div><strong>Reset is exact and repeatable</strong><p className="muted">Reset restores world and provider state. It preserves all application database data.</p><Button kind="danger" onClick={onReset}>Reset world services</Button></div>
      <div className="reset-steps"><span>○ Stop application surfaces</span><span>○ Restore provider and protocol state</span><span>○ Clear observed runtime events</span><span>○ Verify the accepted start</span></div>
    </Panel></div>
  </>;
}
