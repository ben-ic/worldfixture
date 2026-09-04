import React from "react";
import { Avatar, Button } from "./Primitives.jsx";

const primary = ["Overview", "People", "Activity", "Target", "Settings"];

// Each surface names the binding that proves this instance actually started it.
//
// A world can be started with only some of its parts -- `worldfixture up --only
// slack,github` -- and then Gmail, Mail, Files and the Website do not exist. The
// sidebar used to list all seven regardless, so a service nobody asked for
// looked present and opened an empty page reporting an internal error. The
// bindings are the honest signal: `up` publishes one per surface it started, and
// nothing else.
//
// So the rule is to hide a service entry when the instance does not contain
// that service, rather than to show one that opens an empty page.
const surfaces = [
  ["Chat", "slack", "SLACK_BASE_URL"],
  ["Gmail", "google api", "GOOGLE_BASE_URL"],
  ["Local Mail", "smtp + imap", "IMAP_HOST_PORT"],
  ["Code", "github", "GITHUB_BASE_URL"],
  ["Files", "s3", "S3_BASE_URL"],
  ["Notion", "rest", "NOTION_BASE_URL"],
  ["Stripe", "payments", "STRIPE_BASE_URL"],
  ["Linear", "issues", "LINEAR_BASE_URL"],
  ["Okta", "identity", "OKTA_BASE_URL"],
  ["Clerk", "app identity", "CLERK_BASE_URL"],
  ["Microsoft Entra", "oauth + graph", "MICROSOFT_BASE_URL"],
  ["Twilio", "sms + verify", "TWILIO_BASE_URL"],
  ["Resend", "email api", "RESEND_BASE_URL"],
  ["Vercel", "deployments", "VERCEL_BASE_URL"],
  ["MongoDB Atlas", "data", "MONGOATLAS_BASE_URL"],
  ["Website", "http", "SITE_BASE_URL"],
];

export function presentSurfaces(bindings = {}) {
  return surfaces.filter(([, , binding]) => Boolean(bindings[binding]));
}

function NavButton({ label, note, badge, screen, setScreen }) {
  // The note names the protocol behind the label. Without it `Gmail` and `Local Mail`
  // are two mail entries with two different numbers and no way to tell which is
  // which -- one is the Google API over HTTP, the other is a real mailbox over
  // SMTP and IMAP, and that is the interesting thing about them.
  return <button className={`nav-item ${screen === label ? "active" : ""}`} onClick={() => setScreen(label)}>
    <span className="nav-label">{label}{note && <small>{note}</small>}</span>
    {badge !== undefined && badge !== "" && <span className="nav-badge">{badge}</span>}
  </button>;
}

export function TopBar({ data, actor, liveState, onActors, onReset }) {
  const running = data.surfaces.filter((surface) => surface.state === "ready").length;
  return <header className="topbar">
    <div className="identity"><span className="mark"/><strong>WorldFixture</strong><span className="divider"/>
      <span><span className="world-id">{data.world.id}:{data.world.version}</span><span className="world-meta">instance local · {new Date().toLocaleString()}</span></span>
    </div>
    <div className="top-actions">
      <Button className="actor-button" onClick={onActors}><Avatar name={actor.name}/><span><small>ACTING AS</small><strong>{actor.name}</strong></span></Button>
      <span className={`status ${running === data.surfaces.length ? "" : "warn"}`}><i/>{running} of {data.surfaces.length} services ready <small>· {liveState === "connected" ? "live" : liveState}</small></span>
      <Button onClick={onReset}>Reset world</Button>
    </div>
  </header>;
}

export function Sidebar({ data, screen, setScreen, onGuide }) {
  const running = data.surfaces.filter((surface) => surface.state === "ready").length;
  // Every read is optional: a surface this instance did not start has no
  // provider payload, and a badge must not be the thing that throws.
  const liveBadges = {
    Chat: data.providers.slack?.messageCount,
    Gmail: (data.providers.gmail?.inbox?.resultSizeEstimate ?? 0) + (data.providers.gmail?.sent?.resultSizeEstimate ?? 0),
    "Local Mail": (data.providers.mail?.inbox?.exists ?? 0) + (data.providers.mail?.sent?.exists ?? 0),
    // Repositories, not open issues. It summed `open_issues_count`, which the
    // GitHub projection has never carried, so this read 0 in every world however
    // much code was in it -- next to a GitHub service that was working. Every
    // other row counts the things the screen lists, and 14 here matches the
    // "14 repositories" the first screen prints.
    Code: (data.providers.github?.repositories ?? []).length,
    Files: (data.providers.s3?.details ?? []).reduce((total, bucket) => total + bucket.objects.length, 0),
    Notion: data.providers.notion?.pages?.length,
    Stripe: data.providers.stripe?.customers?.length,
    Linear: data.providers.linear?.issues?.length,
    Okta: data.providers.okta?.users?.length,
    Clerk: data.providers.clerk?.users?.length,
    "Microsoft Entra": data.providers.microsoft?.users?.length,
    Twilio: data.providers.twilio?.phone_numbers?.length,
    Resend: data.providers.resend?.emails?.length,
    Vercel: data.providers.vercel?.projects?.length,
    "MongoDB Atlas": data.providers.mongoatlas?.projects?.length,
  };
  return <aside className="sidebar">
    <div className="nav-head">WORKBENCH</div>
    {primary.map((label) => <NavButton key={label} label={label} screen={screen} setScreen={setScreen}
      badge={label === "People" ? data.people.length : label === "Activity" ? data.activity.length : label === "Target" ? "ok" : ""}/>) }
    <div className="nav-head">IN THIS WORLD</div>
    {/* The badge is a COUNT or nothing. It used to fall back to the second
        column, which is a description -- so the Website, which has nothing to
        count, displayed the word "http" where every other row displayed a
        number. */}
    {presentSurfaces(data.bindings).map(([label, note]) => <NavButton key={label} label={label} note={note} badge={liveBadges[label]} screen={screen} setScreen={setScreen}/>) }
    <div className="nav-head">CATALOGUE</div>
    <NavButton label="Services" badge={`${running} / ${data.surfaces.length}`} screen={screen} setScreen={setScreen}/>
    <div className="sidebar-foot"><button className="button small" onClick={onGuide}>Show first-run guide</button><code>worldfixture status</code><span>{running === data.surfaces.length ? "running" : "starting"}</span></div>
  </aside>;
}

export function FirstRunGuide({ open, setOpen, connectedSeen, setScreen, activityCount, resetProven }) {
  const [minimized, setMinimized] = React.useState(false);
  const steps = [
    { title: "See what you got", body: "Review the people, history, services, and stories in this world.", target: "Overview", done: true },
    { title: "Connect your app", body: "Copy this instance’s actual bindings and start your target application.", target: "Target", done: connectedSeen },
    { title: "Do one thing by hand", body: "Use Chat, Mail, Code, or Files through the real provider interface.", target: "Chat", done: activityCount > 0 },
    { title: "Reset when you are done", body: "Remove every change and prove that the accepted state returned.", target: "Overview", done: resetProven },
  ];
  const complete = steps.filter((step) => step.done).length;
  function close() { localStorage.setItem("wf-workbench-tour", "seen"); setOpen(false); }
  if (!open) return null;
  return <aside className="first-run">
    <header><span><strong>Getting started</strong><small>{complete} of 4 done · active world is running</small></span><span><button onClick={() => setMinimized((value) => !value)}>{minimized ? "Expand" : "Hide"}</button><button onClick={close}>Done</button></span></header>
    {!minimized && <><div className="guide-steps">{steps.map((step, index) => <button key={step.title} onClick={() => setScreen(step.target)} className={step.done ? "done" : ""}><i>{step.done ? "✓" : index + 1}</i><span><strong>{step.title}</strong><small>{step.body}</small></span><code>{step.done ? "done" : step.target}</code></button>)}</div><footer>Each step has a CLI equivalent. The Workbench uses the same provider interfaces as your application.</footer></>}
  </aside>;
}
