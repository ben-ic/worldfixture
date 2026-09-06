import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { post, request, setApiSession } from "./api.js";
import { FirstRunGuide, Sidebar, TopBar } from "./components/Chrome.jsx";
import { Button, Notice } from "./components/Primitives.jsx";
import { guideSteps, reconcileScreen, recordAction, runIdentity, selectAcceptedActor, selectActor, selectedNavigation } from "./navigation.mjs";
import { DomainRecords } from "./screens/DomainRecords.jsx";
import { Overview } from "./screens/Overview.jsx";
import { Clerk, Linear, MongoAtlas, Okta, Resend, Stripe, Twilio, Vercel } from "./screens/ProductScreens.jsx";
import { Chat, Code, Files, Gmail, Mail, Notion, Website } from "./screens/ProviderScreens.jsx";
import { Timeline } from "./screens/Timeline.jsx";
import { Activity, People, ServiceDetail, Services, Settings, Target } from "./screens/WorkbenchScreens.jsx";
import { ConnectionConfirmation, SessionProgress, Worlds } from "./screens/Worlds.jsx";

const peopleOf = data => Array.isArray(data?.people) ? data.people : [];
const guideKey = data => `wf-workbench-tour:${runIdentity(data)}`;
function guideWasClosed(data) {
  try { return localStorage.getItem(guideKey(data)) === "seen"; } catch { return false; }
}

export function App() {
  const [data, setData] = useState(null);
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  const sessionSequence = useRef(0);
  const dataRef = useRef(null);
  const requestSequence = useRef(0);
  const resetInFlight = useRef(false);
  const [actorId, setActorId] = useState(null);
  const [screen, setScreen] = useState("Overview");
  const [error, setError] = useState(null);
  const [proof, setProof] = useState(null);
  const [actorsOpen, setActorsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [liveState, setLiveState] = useState("connecting");
  const [liveRevision, setLiveRevision] = useState(0);
  const [guideOpen, setGuideOpen] = useState(false);
  const [evidence, setEvidence] = useState({ runKey: "", actions: [] });

  const acceptSession = useCallback(value => {
    const next = { ...value, managed: value.managed ?? Boolean(value.generation) };
    const previous = sessionRef.current;
    const changed = previous?.generation !== next.generation || previous?.phase !== next.phase;
    sessionRef.current = next; setSession(next); setApiSession(next);
    if (changed && next.managed) {
      requestSequence.current += 1;
      dataRef.current = null; setData(null); setActorId(null);
      setEvidence({ runKey: "", actions: [] }); setProof(null); setError(null);
      setActorsOpen(false); setResetOpen(false); setGuideOpen(false);
      setScreen(next.reconnect_required ? "Timeline" : "Overview");
    }
    return changed;
  }, []);

  // Manual readers receive the newly fetched data. A failed or superseded
  // request returns null, so a screen cannot report a stale successful read.
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const value = await request("/api/overview");
      if (sequence !== requestSequence.current) return null;
      const previousData = dataRef.current;
      const changed = runIdentity(value) !== runIdentity(previousData);
      dataRef.current = value;
      setData(value); setError(null);
      setActorId(current => selectAcceptedActor(value, previousData, current)?.id ?? null);
      setScreen(current => changed ? sessionRef.current?.reconnect_required ? "Timeline" : "Overview" : reconcileScreen(value, current));
      if (changed) {
        setEvidence({ runKey: runIdentity(value), actions: [] });
        setGuideOpen(!sessionRef.current?.reconnect_required && !guideWasClosed(value));
        setActorsOpen(false); setResetOpen(false); setProof(null);
      }
      return value;
    } catch (failure) {
      if (sequence === requestSequence.current) setError(failure.message);
      return null;
    }
  }, []);
  const refreshSession = useCallback(async () => {
    const sequence = ++sessionSequence.current;
    try {
      const value = await request("/api/session");
      if (sequence !== sessionSequence.current) return;
      const changed = acceptSession(value);
      if (value.phase === "ready" || !value.managed) { if (changed || !dataRef.current) await load(); }
    } catch (failure) { if (sequence === sessionSequence.current) setError(failure.message); }
  }, [acceptSession, load]);
  useEffect(() => { refreshSession(); const timer = setInterval(refreshSession, 2000); return () => clearInterval(timer); }, [refreshSession]);
  useEffect(() => {
    const source = new EventSource("/api/live");
    let timer;
    const refresh = () => {
      if (document.hidden || resetInFlight.current || !sessionRef.current || sessionRef.current.managed && sessionRef.current.phase !== "ready") return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (resetInFlight.current) return; setLiveRevision(value => value + 1); load(); }, 120);
    };
    source.addEventListener("session", event => {
      try {
        sessionSequence.current += 1;
        const value = JSON.parse(event.data), changed = acceptSession(value);
        if (value.phase === "ready" && (changed || !dataRef.current)) load();
      } catch (failure) { setError(failure.message); }
    });
    source.onopen = () => setLiveState("connected");
    source.onerror = () => setLiveState("reconnecting");
    for (const event of ["ready", "refresh", "provider-change", "service-change", "connector-change", "reset-completed"]) source.addEventListener(event, refresh);
    return () => { clearTimeout(timer); source.close(); };
  }, [load, acceptSession]);
  const actor = useMemo(() => selectActor(data, actorId), [data, actorId]);
  if (error && !data) return <main className="disconnected"><SessionProgress session={session}/><Notice kind="error">The Workbench is disconnected: {error}</Notice><Button onClick={refreshSession}>Try again</Button></main>;
  if (!data) return <main className="loading-page"><h1>WorldFixture</h1><SessionProgress session={session}/><p>{session?.phase === "switching" ? "Waiting for the new world and connection settings…" : "Loading the active instance…"}</p></main>;

  const runKey = runIdentity(data);
  async function receiveSession(value) { sessionSequence.current += 1; acceptSession(value); await load(); }
  function onAction(event) {
    setEvidence(current => recordAction(current, event, runKey, dataRef.current));
  }
  const common = { data, actor, onChanged: load, onAction, liveRevision };
  const navigate = next => setScreen(reconcileScreen(dataRef.current, next));
  const activeScreen = reconcileScreen(data, screen);
  const selected = selectedNavigation(data).find(entry => entry.screen === activeScreen || `service:${entry.id}` === activeScreen);
  const screens = {
    Overview: <Overview session={session} data={data} setScreen={navigate} onRefresh={load} onReset={() => setResetOpen(true)} onAction={onAction}/>,
    Worlds: <Worlds session={session} onSession={receiveSession}/>,
    Timeline: <Timeline onChanged={load} session={session}/>,
    People: <People data={data} actor={actor} setActor={person => setActorId(person?.id ?? null)}/>,
    Activity: <Activity data={data} onRefresh={load} onAction={onAction}/>, Target: <Target data={data} onAction={onAction}/>,
    Settings: <Settings data={data} onReset={() => setResetOpen(true)}/>, Services: <Services data={data} setScreen={navigate}/>,
    Chat: <Chat {...common}/>, Gmail: <Gmail {...common}/>, "Local Mail": <Mail {...common}/>, Code: <Code {...common}/>, Files: <Files {...common}/>, Notion: <Notion {...common}/>,
    Stripe: <Stripe {...common}/>, Linear: <Linear {...common}/>, Okta: <Okta {...common}/>, Clerk: <Clerk {...common}/>,
    Twilio: <Twilio {...common}/>, Resend: <Resend {...common}/>, Vercel: <Vercel {...common}/>, "MongoDB Atlas": <MongoAtlas {...common}/>, Website: <Website {...common}/>,
    "World records": <DomainRecords {...common}/>,
  };
  const content = Object.hasOwn(screens, activeScreen) ? screens[activeScreen]
    : <ServiceDetail data={data} surfaceId={selected?.id} setScreen={navigate} onAction={onAction}/>;
  async function reset() {
    const expectedRun = runIdentity(dataRef.current);
    resetInFlight.current = true;
    setResetting(true); setProof(null);
    try {
      const result = await post("/api/reset", {});
      if (result.ok !== true) throw new Error("The reset was not accepted.");
      setResetOpen(false);
      const fresh = await load();
      if (!fresh || runIdentity(fresh) !== expectedRun || !result.acceptedProof || fresh.acceptedProof !== result.acceptedProof) throw new Error("The reset finished, but the accepted starting state could not be confirmed.");
      if (!Array.isArray(fresh.surfaces) || fresh.surfaces.some(surface => surface.state !== "ready")) throw new Error("The reset finished, but the selected services are not all ready.");
      setProof(`Accepted starting state returned: ${fresh.acceptedProof}`);
      setEvidence(current => recordAction(current, { type: "reset", target: "world", success: true }, expectedRun, dataRef.current));
      setScreen("Overview");
    } catch (failure) { if (runIdentity(dataRef.current) === expectedRun) setError(failure.message); }
    finally { resetInFlight.current = false; setResetting(false); }
  }
  function closeGuide() {
    try { localStorage.setItem(guideKey(data), "seen"); } catch { /* The current guide can close without browser storage. */ }
    setGuideOpen(false);
  }
  return <>
    <TopBar data={data} actor={actor} onWorlds={() => navigate("Worlds")} liveState={liveState} onActors={() => setActorsOpen(true)} onReset={() => setResetOpen(true)}/>
    <div className="app-shell"><Sidebar data={data} screen={activeScreen} setScreen={navigate} onGuide={() => setGuideOpen(true)}/><main className="main"><FirstRunGuide key={runKey} open={guideOpen} onClose={closeGuide} steps={guideSteps(data, evidence, { actor })} setScreen={navigate}/><ConnectionConfirmation key={session?.generation ?? "unmanaged"} session={session} onSession={receiveSession}/>{error && <Notice kind="error">{error}</Notice>}{proof && <Notice>{proof}</Notice>}<div className="screen" key={`${runKey}:${activeScreen}`}>{content}</div></main></div>
    {actorsOpen && <div className="modal-backdrop"><section className="modal"><header><div><h2>Act as a world person</h2><p>Provider actions use that person’s declared identity.</p></div><Button kind="small" onClick={() => setActorsOpen(false)}>Close</Button></header><div className="actor-list">{peopleOf(data).length ? peopleOf(data).map(person => <button key={person.id} onClick={() => { setActorId(person.id); setActorsOpen(false); }}><span>{person.name ?? person.id}<small>{person.role}</small></span><code>{[person.slack_id, person.github_login].filter(Boolean).join(" · ")}</code></button>) : <p>No people are declared in this world.</p>}</div></section></div>}
    {resetOpen && <div className="modal-backdrop"><section className="modal"><header><div><h2>Reset this world?</h2><p>Return world and provider services to the accepted starting state.</p></div><Button kind="small" onClick={() => setResetOpen(false)}>Close</Button></header><div className="modal-body"><p>This will remove changes made to resettable services since this instance started. It will preserve all PostgreSQL and MySQL data. It will restore <strong>{data.world.id}:{data.world.version}</strong>.</p><div className="reset-steps"><span>○ Stop resettable application surfaces and pause new actions</span><span>○ Preserve application database data</span><span>○ Restore selected provider and runtime state</span><span>○ Prove readiness and the accepted starting state</span></div></div><footer><Button onClick={() => setResetOpen(false)}>Cancel</Button><Button kind="danger" disabled={resetting} onClick={reset}>{resetting ? "Resetting…" : "Reset world services"}</Button></footer></section></div>}
  </>;
}
