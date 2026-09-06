import { useEffect, useState } from "react";
import { post, request } from "../api.js";
import { serviceScreen } from "../navigation.mjs";
import { ALL_ORGANIZATIONS, NO_ORGANIZATION, peopleSelection, resourceCountText, surfaceResources } from "../runtime-data.mjs";
import { ActivityTable, Bindings } from "../components/RuntimeViews.jsx";
import { Avatar, Button, CopyButton, Notice, PageHead, Panel } from "../components/Primitives.jsx";

export function People({ data, actor, setActor }) {
  const [organizationId, setOrganizationId] = useState(() => data.world.organizationId ?? ALL_ORGANIZATIONS);
  const [query, setQuery] = useState("");
  useEffect(() => { setOrganizationId(data.world.organizationId ?? ALL_ORGANIZATIONS); setQuery(""); }, [data.world.id, data.world.version, data.world.organizationId]);
  const selected = peopleSelection(data, { organizationId, query });
  const organization = selected.organizations.find((entry) => entry.id === organizationId);
  return <><PageHead title="People" subtitle="World records with organization and provider identities." command="worldfixture people"/>
    <div className="action-form"><label>ORGANIZATION<select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}><option value={ALL_ORGANIZATIONS}>All people in this world · {selected.worldPeople} people</option>{selected.organizations.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select></label><label>FIND A PERSON<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, role, or email"/></label><span className="muted">{selected.summary}</span></div>
    <Panel title={organizationId === ALL_ORGANIZATIONS ? "People in this world" : organizationId === NO_ORGANIZATION ? "People with no organization" : `People in ${organization?.name ?? organizationId}`} tools={<span className="muted">{selected.people.length} of {selected.scope.length} shown</span>}><div className="data-row people-columns table-head"><span>PERSON</span><span>ORGANIZATION</span><span>PROVIDER IDENTITIES</span><span>CONTROL</span></div>
      {selected.people.map((person) => <div className="data-row people-columns" key={person.id}><span className="person"><Avatar name={person.name}/><span><strong>{person.name}</strong><small>{person.role}</small></span></span><span>{person.organization_name || person.organization_id || "No organization"}</span><code className="muted truncate">{[person.slack_id, person.email, person.github_login].filter(Boolean).join(" · ")}</code><Button kind="small" onClick={() => setActor(person)}>{actor?.id === person.id ? "Acting now" : `Act as ${person.name.split(" ")[0]}`}</Button></div>)}
      {selected.people.length === 0 && <div className="empty">No people match this organization and search.</div>}
    </Panel></>;
}

export function Activity({ data, onRefresh, onAction }) {
  return <><PageHead title="Activity" subtitle="Observed provider actions and settled causal consequences." command="worldfixture events"/><ActivityTable data={data} onRefresh={onRefresh} onAction={onAction}/></>;
}

export function Target({ data, onAction }) {
  const [connector, setConnector] = useState(null);
  const [url, setUrl] = useState("http://localhost:3000");
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [scale, setScale] = useState("full");
  const [limits, setLimits] = useState("");

  async function load() {
    try { setConnector(await request("/api/connector")); setError(null); }
    catch (failure) { setConnector(null); setPlan(null); setResult(null); setError(failure.message); }
  }
  useEffect(() => { load(); }, []);

  async function act(action, input = {}) {
    setWorking(true); setError(null);
    try {
      const value = await post(`/api/connector/${action}`, { ...input, ...(["plan", "seed"].includes(action) ? { scale, limits } : {}) });
      if (action === "connect" || action === "disconnect") setConnector(value);
      else if (action === "plan") setPlan(value);
      else setResult(value);
      if (["seed", "event", "reset"].includes(action)) await load();
    } catch (failure) { setError(failure.message); }
    finally { setWorking(false); }
  }

  const connected = connector?.state === "connected";
  return <><PageHead title="Target" subtitle="Connect and fill your application with this world." command="worldfixture connector"/>
    <div className="journey-strip"><span><strong>1</strong> Connect your app</span><span><strong>2</strong> Preview the data</span><span><strong>3</strong> Fill and test</span></div>
    <Panel title="Application connector">
      {connector?.state === "disconnected" && <form className="action-form" onSubmit={(event) => { event.preventDefault(); act("connect", { url }); }}>
        <label>APPLICATION URL<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:3000"/></label>
        <div><Button kind="primary" disabled={working}>{working ? "Checking…" : "Connect application"}</Button></div>
      </form>}
      {connector && !connected && connector.state !== "disconnected" && <div className="connector-state">
        <div><strong>{{
          missing: "Connector not found",
          unauthorized: "The application refused this instance's token",
}[connector.state] ?? "Application is not reachable"}</strong><p>{connector.error}</p>
        {connector.state === "unauthorized" && <p className="muted">The application answered discovery, so it is running. It is reading a different token from the one this instance issued. Check <code>WORLDFIXTURE_TOKEN</code>, or the <code>.worldfixture/token</code> file in the application root — an application started from another project directory has another project's token.</p>}
        <code>{connector.url}</code></div>
        <div className="inline-actions"><CopyButton value={connector.prompt} kind="primary">Copy coding-agent prompt</CopyButton><Button onClick={() => act("connect", { url: connector.url })}>Check again</Button><Button onClick={() => act("disconnect")}>Change URL</Button></div>
      </div>}
      {connected && <>
        <div className="connector-state"><div><strong>{connector.discovery.application.name}</strong><p>Connector v1 is ready at {connector.url}.</p><code>{connector.status?.state ?? "ready"}</code></div>
          <div className="inline-actions"><Button onClick={() => act("plan")}>Preview seed</Button><Button kind="primary" onClick={() => act("seed")} disabled={working}>{working ? "Working…" : "Fill application"}</Button>{connector.discovery.capabilities.reset && <Button kind="danger" onClick={() => window.confirm(`Reset connector-owned development data in ${connector.discovery.application.name}?`) && act("reset")}>Reset app</Button>}<Button onClick={() => act("disconnect")}>Disconnect</Button></div>
        </div>
        {connector.scales && <div className="action-form">
          <label>HOW MUCH OF THE WORLD<select value={scale} onChange={(event) => setScale(event.target.value)}>
            {connector.scales.presets.map((preset) => <option key={preset.name} value={preset.name}>{preset.name} — {preset.summary}</option>)}
          </select></label>
          <label>LIMITS (OPTIONAL)<input value={limits} onChange={(event) => setLimits(event.target.value)} placeholder="people=25,messages=5"/></label>
          <div className="panel-pad muted slice-note">A slice is always whole: it never contains a record that refers to a record it does not contain, and it never empties a collection this world has records in.<br/>This world has {connector.scales.collections.length} collections and {connector.scales.collections.reduce((total, entry) => total + entry.total, 0).toLocaleString()} records.</div>
        </div>}
        {/* Replay, not invention.
            The form used to offer four hard-coded kinds with a `{note}` payload,
            and not one of the five connectors built against this contract
            accepted any of them — so the product's headline demo was unreachable
            from the Workbench while the world was emitting other kinds all
            along. These come from what this world has actually produced, and the
            event delivered is the real observation, translated. */}
        <form className="action-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); act("replay", { event: form.get("kind") }); }}>
          <label>DELIVER SOMETHING THE WORLD DID
            <select name="kind" defaultValue="">
              <option value="">the most recent event</option>
              {(connector.kinds ?? []).map((entry) => <option key={entry.kind} value={entry.kind}>{entry.kind} — {entry.count} observed</option>)}
            </select>
          </label>
          <div className="panel-pad muted slice-note">The event is taken from this instance's ledger and translated into Connector v1, so its actor and subject address the records your application was seeded with.</div>
          <div><Button disabled={working || !connector.discovery.capabilities.event || (connector.kinds ?? []).length === 0}>Deliver to my application</Button></div>
        </form>
      </>}
      {!connector && <div className="loading">Checking for a connected application…</div>}
    </Panel>
    {error && <div className="section"><div className="notice error">{error}</div></div>}
    {plan && <div className="section"><Panel title="Seed preview">
      <div className="connector-plan"><p>{plan.summary}</p>
        {/* `mappings` is required by connector-plan.v1, and a connector that omits
            it used to take this whole screen down with a TypeError in the browser.
            A missing field is the application's bug and it is reported as one. */}
        {(plan.mappings ?? []).map((mapping) => <div key={`${mapping.source}-${mapping.target}`}>
          <div className="data-row connector-columns"><code>{mapping.source}</code><span>→</span><strong>{mapping.target || <span className="muted">nothing</span>}</strong><code className={mapping.status === "mapped" ? "green" : "yellow"}>{mapping.status}</code></div>
          {/* `reason` answers the only question a skipped row raises. Connector
              authors were writing careful reasons that no client ever showed. */}
          {mapping.reason && <div className="panel-pad muted">{mapping.reason}</div>}
        </div>)}
      </div>
      <PlanTotals plan={plan}/>
      <SliceAccount scale={plan.scale}/>
      <SchemaErrors errors={plan.schema_errors}/>
    </Panel></div>}
    {result && <div className="section"><div className="notice">
      {/* A repeated seed used to look exactly like a real one. The receipt has
          always carried `status`; neither client showed it, so the only way to
          confirm idempotency was to count rows in the application's database. */}
      {result.status === "already_applied" && <div><strong>Already applied — nothing changed.</strong> This request matched one this application has already accepted.</div>}
      <div>{result.summary ?? result.status}{countList(result.counts) && ` · ${countList(result.counts)}`}</div>
      {result.delivered && <div className="muted">Delivered <code>{result.delivered.kind}</code>{result.delivered.subject && <> about <code>{result.delivered.subject.worldfixture_ref}</code></>}{result.delivered.actor && <> from <code>{result.delivered.actor.worldfixture_ref}</code></>}.</div>}
    </div><SliceAccount scale={result.scale}/><SchemaErrors errors={result.schema_errors}/></div>}
    <div className="section"><Panel title="Application environment"><div className="panel-pad muted">Start the application with its normal development command. The connector reads the ignored <code>.worldfixture/token</code> file or <code>WORLDFIXTURE_TOKEN</code>. The token is not shown in the browser.</div><Bindings data={data} complete onAction={onAction}/></Panel></div>
  </>;
}

// An empty `counts` used to render a dangling " · " with nothing after it.
function countList(counts) {
  const entries = Object.entries(counts ?? {});
  return entries.length === 0 ? "" : entries.map(([name, count]) => `${count} ${name}`).join(", ");
}

// The rest of the plan. The Workbench showed the mappings and dropped `counts`
// and `warnings`; the CLI did the opposite. Neither client could show a user the
// whole plan, and the warnings are where a connector says things like "seeded
// users share a development password".
function PlanTotals({ plan }) {
  const counts = countList(plan.counts);
  const warnings = plan.warnings ?? [];
  if (!counts && warnings.length === 0) return null;
  return <div className="panel-pad muted">
    {counts && <div>Would create {counts}.</div>}
    {warnings.map((warning) => <div key={warning} className="yellow">Warning: {warning}</div>)}
  </div>;
}

// What was actually sent, counted from what was actually sent. The collections
// that came out SHORT are the only ones that ever surprise anybody, so they are
// the ones named; the rest is a total.
function SliceAccount({ scale }) {
  if (!scale || scale.full) return null;
  const present = scale.collections.filter((entry) => entry.total > 0);
  const sent = present.reduce((total, entry) => total + entry.kept, 0);
  const available = present.reduce((total, entry) => total + entry.total, 0);
  const short = present.filter((entry) => entry.kept < Math.min(entry.limit, entry.total));
  return <div className="panel-pad muted slice-note">
    <div>Sent the <strong>{scale.preset}</strong> slice: {sent.toLocaleString()} of {available.toLocaleString()} records across {present.length} collections.</div>
    {short.length > 0 && <div>Short of the limit, because something they refer to was left out: {short.map((entry) => `${entry.collection} ${entry.kept} of ${entry.total}`).join(", ")}.</div>}
  </div>;
}

function SchemaErrors({ errors }) {
  if (!errors || errors.length === 0) return null;
  return <div className="notice error">
    <strong>The application answered, but its response does not match the published schema.</strong>
    <ul>{errors.map((error) => <li key={error}><code>{error}</code></li>)}</ul>
    Run <code>worldfixture connector check</code> and see <code>schemas/connector-*.v1.schema.json</code>.
  </div>;
}

export function Settings({ data, onReset }) {
  return <><PageHead title="Settings" subtitle="Identity, storage, and reset behavior for this instance." command="worldfixture status --verbose"/>
    <Panel title="This instance"><div className="detail-grid"><strong>World</strong><code>{data.world.id}:{data.world.version}</code><strong>Accepted starting state</strong><span>{data.acceptedProof}</span><strong>Service model</strong><span>Services use stable internal ports and actual host bindings.</span><strong>Runtime history</strong><span>The runtime owns its event history inside the instance.</span></div></Panel>
    <div className="section"><Panel title="Reset"><div className="settings-action"><div><strong>Restore the starting world</strong><p>Reset removes changes from world services. It preserves data in your application databases.</p></div><Button kind="danger" onClick={onReset}>Reset world services</Button></div></Panel></div>
  </>;
}

export function Services({ data, setScreen }) {
  return <><PageHead title="Services" subtitle="Every selected service surface, its current state, and its connection settings." command="environment lock"/>
    <Panel title="Selected for this instance"><div className="data-row resource-columns table-head"><span>SERVICE</span><span>IMPLEMENTATION</span><span>STATE</span><span>ACTION</span></div>
      {(data.surfaces ?? []).map((service) => <div className="data-row resource-columns" key={service.id}><span><strong>{service.name}</strong><small>{service.implementation} {service.version}</small></span><code className="muted">{service.service}</code><code className={service.state === "ready" ? "green" : "yellow"}>{service.state ?? "unknown"}</code><span className="inline-actions"><Button kind="small" onClick={() => setScreen(serviceScreen(service))}>Open</Button><Button kind="small" onClick={() => setScreen(`service:${service.id}`)}>Details</Button></span></div>)}
      {!data.surfaces?.length && <div className="empty">No service surfaces are selected for this instance.</div>}
    </Panel>
  </>;
}

export function ServiceDetail({ data, surfaceId, setScreen, onAction }) {
  const surface = (data.surfaces ?? []).find((entry) => entry.id === surfaceId);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setResult(null); setError(null); }, [surfaceId]);
  if (!surface) return <><PageHead title="Service unavailable" subtitle="This surface is not selected for the current instance."/><Button onClick={() => setScreen("Services")}>View selected services</Button></>;
  const resources = surfaceResources(data, surface);
  const screen = serviceScreen(surface);
  async function probe() {
    setWorking(true); setError(null);
    try {
      const response = await post("/api/probe", {});
      const measured = response.surfaces?.find((entry) => entry.id === surface.id);
      if (!measured) throw new Error("The runtime returned no probe result for this surface.");
      setResult(measured);
      if (measured.ready) onAction?.({ type: "probe", surface: surface.id, target: "services", success: true });
    } catch (failure) { setError(failure.message); }
    finally { setWorking(false); }
  }
  return <><PageHead title={surface.name} subtitle="Selected capabilities, measured state, and connection bindings."/>
    <Panel title="Service details"><div className="detail-grid"><strong>Runtime state</strong><span>{surface.state ?? "unknown"}</span><strong>Service</strong><code>{surface.service ?? surface.id}</code><strong>Implementation</strong><span>{surface.implementation} {surface.version}</span><strong>Selected capabilities</strong><span>{surface.capabilities?.join(" · ") || "Capability metadata is unavailable."}</span></div>
      <div className="panel-pad inline-actions">{screen !== `service:${surface.id}` && <Button onClick={() => setScreen(screen)}>Open workspace</Button>}<Button onClick={probe} disabled={working}>{working ? "Probing…" : "Probe service"}</Button><Button onClick={() => setScreen("Services")}>All services</Button></div>
      {error && <Notice kind="error">Probe unavailable: {error}</Notice>}
      {result && <Notice kind={result.ready ? "" : "error"}>{result.ready ? "Probe passed" : "Probe failed"} · {result.latency_ms} ms{result.detail && ` · ${result.detail}`}</Notice>}
    </Panel>
    <div className="section"><Panel title="Resource reads">{resources.available ? resources.resources.map((resource) => <div className="data-row" key={resource.label}><strong>{resource.label}</strong><span>{resourceCountText(resource)}</span>{resource.error && <span className="muted">{resource.error}</span>}</div>) : <div className="panel-pad"><Notice kind="warning">Resource data is unavailable. {resources.error}</Notice></div>}</Panel></div>
    <div className="section"><Bindings data={data} surfaceId={surface.id} complete onAction={onAction}/></div>
  </>;
}
