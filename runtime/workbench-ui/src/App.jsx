import { useEffect, useMemo, useState } from "react";
import { request, post } from "./api.js";
import { FirstRunGuide, Sidebar, TopBar } from "./components/Chrome.jsx";
import { Button, Notice } from "./components/Primitives.jsx";
import { Overview } from "./screens/Overview.jsx";
import { Activity, People, Services, Settings, Target } from "./screens/WorkbenchScreens.jsx";
import { Chat, Code, Files, Gmail, Mail, Notion, Website } from "./screens/ProviderScreens.jsx";
import { Clerk, Linear, MongoAtlas, Okta, Resend, Stripe, Twilio, Vercel } from "./screens/ProductScreens.jsx";

export function App() {
  const [data, setData] = useState(null);
  const [actorId, setActorId] = useState(null);
  const [screen, setScreen] = useState("Overview");
  const [error, setError] = useState(null);
  const [proof, setProof] = useState(null);
  const [actorsOpen, setActorsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [liveState, setLiveState] = useState("connecting");
  const [liveRevision, setLiveRevision] = useState(0);
  const [guideOpen, setGuideOpen] = useState(() => localStorage.getItem("wf-workbench-tour") !== "seen");
  const [visited, setVisited] = useState(["Overview"]);

  async function load(showProof = false) {
    try {
      const value = await request("/api/overview");
      setData(value); setError(null);
      if (!actorId && value.people.length) setActorId(value.people[0].id);
      if (showProof) setProof(`Accepted starting state returned: ${value.acceptedProof}`);
    } catch (failure) { setError(failure.message); }
  }
  useEffect(() => { load(location.hash === "#reset-complete"); }, []);
  useEffect(() => {
    const source = new EventSource("/api/live");
    let timer;
    const refresh = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      timer = setTimeout(() => { setLiveRevision((value) => value + 1); load(false); }, 120);
    };
    source.onopen = () => setLiveState("connected");
    source.onerror = () => setLiveState("reconnecting");
    for (const event of ["ready", "refresh", "provider-change", "connector-change", "reset-completed"]) source.addEventListener(event, refresh);
    return () => { clearTimeout(timer); source.close(); };
  }, []);
  const actor = useMemo(() => data?.people.find((person) => person.id === actorId) ?? data?.people[0], [data, actorId]);
  if (error && !data) return <main className="disconnected"><Notice kind="error">The Workbench is disconnected: {error}</Notice></main>;
  if (!data || !actor) return <main className="loading-page">Loading the active instance…</main>;

  const common = { data, actor, onChanged: load, liveRevision };
  function navigate(next) {
    setScreen(next);
    setVisited((current) => current.includes(next) ? current : [...current, next]);
  }
  const screens = {
    Overview: <Overview data={data} setScreen={navigate} onRefresh={load} onReset={() => setResetOpen(true)}/>,
    People: <People data={data} actor={actor} setActor={(person) => setActorId(person.id)}/>,
    Activity: <Activity data={data} onRefresh={load}/>, Target: <Target data={data}/>,
    Settings: <Settings data={data} onReset={() => setResetOpen(true)}/>, Services: <Services data={data} setScreen={navigate}/>,
    Chat: <Chat {...common}/>, Gmail: <Gmail {...common}/>, "Local Mail": <Mail {...common}/>, Code: <Code {...common}/>, Files: <Files {...common}/>, Notion: <Notion {...common}/>,
    Stripe: <Stripe {...common}/>, Linear: <Linear data={data}/>, Okta: <Okta data={data}/>, Clerk: <Clerk data={data}/>,
    Twilio: <Twilio data={data}/>, Resend: <Resend data={data}/>, Vercel: <Vercel data={data}/>, "MongoDB Atlas": <MongoAtlas data={data}/>,
    Website: <Website data={data}/>,
  };
  async function reset() {
    setResetting(true);
    try { await post("/api/reset", {}); setResetOpen(false); setProof(null); location.hash = "reset-complete"; await load(true); setScreen("Overview"); }
    catch (failure) { setProof(failure.message); }
    finally { setResetting(false); }
  }
  return <>
    <TopBar data={data} actor={actor} liveState={liveState} onActors={() => setActorsOpen(true)} onReset={() => setResetOpen(true)}/>
    <div className="app-shell"><Sidebar data={data} screen={screen} setScreen={navigate} onGuide={() => setGuideOpen(true)}/><main className="main">{proof && <Notice>{proof}</Notice>}<div className="screen">{screens[screen]}</div></main></div>
    <FirstRunGuide open={guideOpen} setOpen={setGuideOpen} visited={visited} setScreen={navigate} activityCount={data.activity.length} resetProven={Boolean(proof?.startsWith("Accepted starting state returned"))}/>
    {actorsOpen && <div className="modal-backdrop"><section className="modal"><header><div><h2>Act as a world person</h2><p>Provider actions use that person’s declared identity.</p></div><Button kind="small" onClick={() => setActorsOpen(false)}>Close</Button></header><div className="actor-list">{data.people.map((person) => <button key={person.id} onClick={() => { setActorId(person.id); setActorsOpen(false); }}><span>{person.name}<small>{person.role}</small></span><code>{[person.slack_id, person.github_login].filter(Boolean).join(" · ")}</code></button>)}</div></section></div>}
    {resetOpen && <div className="modal-backdrop"><section className="modal"><header><div><h2>Reset this world?</h2><p>Return world and provider services to the accepted starting state.</p></div><Button kind="small" onClick={() => setResetOpen(false)}>Close</Button></header><div className="modal-body"><p>This will remove all messages, issues, objects, mail, website progress, and observed events created since this instance started. It will preserve all PostgreSQL and MySQL data. It will restore <strong>{data.world.id}:{data.world.version}</strong>.</p><div className="reset-steps"><span>○ Stop resettable application surfaces and pause new actions</span><span>○ Preserve application database data</span><span>○ Restore provider, mail, S3, HTTP, and runtime state</span><span>○ Prove readiness and the accepted starting state</span></div></div><footer><Button onClick={() => setResetOpen(false)}>Cancel</Button><Button kind="danger" disabled={resetting} onClick={reset}>{resetting ? "Resetting…" : "Reset world services"}</Button></footer></section></div>}
  </>;
}
