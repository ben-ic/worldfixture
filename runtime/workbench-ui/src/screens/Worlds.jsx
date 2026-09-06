import { useEffect, useState } from "react";
import { post, request } from "../api.js";
import { Button, Notice, PageHead, Panel } from "../components/Primitives.jsx";

export function SessionProgress({ session }) {
  if (!session?.managed || session.phase === "ready") return null;
  return <Notice kind={session.phase === "stopped" ? "error" : "warning"}><strong>{session.phase === "stopped" ? "World services are stopped." : "Changing the active world."}</strong>
    {session.transition?.phase && <p>Current step: {session.transition.phase.replaceAll("_", " ")}</p>}
    <p>Provider actions are unavailable until the new session is ready.</p>
    {session.transition?.error && <p>{session.transition.error}</p>}
  </Notice>;
}

export function ConnectionConfirmation({ session, onSession }) {
  const [applicationUrl, setApplicationUrl] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  if (!session?.reconnect_required || session.phase !== "ready") return null;
  async function confirm(input) {
    setBusy(true); setError(null);
    try { await onSession(await post("/api/world/connection", input)); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Panel title="Confirm the application connection" className="session-connection">
    <p>The new world is paused in setup. Its provider URLs and credentials can differ. Update your application connection settings before you start the timeline.</p>
    <form className="timeline-command" onSubmit={event => { event.preventDefault(); confirm({ applicationUrl }); }}>
      <label>Application URL<input type="url" value={applicationUrl} onChange={event => setApplicationUrl(event.target.value)} placeholder="http://localhost:3000" required disabled={busy}/></label>
      <Button disabled={busy || !applicationUrl.trim()} type="submit">Confirm application connection</Button>
      <Button disabled={busy} type="button" onClick={() => confirm({ withoutApplication: true })}>Continue without an application</Button>
    </form>
    <p className="muted">Continuing without an application is available only when no scheduled event requires one.</p>
    {error && <Notice kind="error">Connection was not confirmed: {error}</Notice>}
  </Panel>;
}

export function worldSwitchInput(selected, customPath, noRebase) {
  const worldPath = customPath.trim() || (selected?.valid ? selected.artifactPath : null);
  if (!worldPath) throw new Error("Select a verified artifact or enter its path.");
  return { worldPath, noRebase };
}

export function Worlds({ session, onSession }) {
  const [entries, setEntries] = useState(null), [error, setError] = useState(null), [selected, setSelected] = useState(null);
  const [customPath, setCustomPath] = useState(""), [noRebase, setNoRebase] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    if (session?.managed) request("/api/worlds", { signal: abort.signal }).then(value => {
      if (!Array.isArray(value.data)) throw new Error("The catalogue response has no world list.");
      setEntries(value.data); setError(null);
    }).catch(failure => { if (!abort.signal.aborted) setError(failure.message); });
    return () => abort.abort();
  }, [session?.managed, session?.generation]);
  async function switchWorld() {
    setBusy(true); setError(null);
    try {
      const input = worldSwitchInput(selected, customPath, noRebase);
      await onSession(await post("/api/world/switch", input));
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <>
    <PageHead title="Choose a world" subtitle="The catalogue comes from verified local artifacts and their source provenance." command="worldfixture worlds"/>
    <Notice kind="warning"><strong>Switching starts a new provider baseline.</strong><p>It removes manual changes in the current world and provider services. Application database data is preserved. The new world starts paused in setup. Confirm its application connection before you start delivery.</p></Notice>
    {!session?.managed && <Notice>World switching is unavailable for this run.</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {session?.managed && entries === null && !error && <p>Reading the world catalogue…</p>}
    <WorldCatalogue entries={entries ?? []} selected={customPath.trim() ? null : selected} busy={busy} onSelect={entry => { setSelected(entry); setCustomPath(""); }}/>
    {session?.managed && <Panel title="Switch the active run" className="world-switch-form">
      <label>Or use a local artifact directory<input value={customPath} onChange={event => { setCustomPath(event.target.value); setSelected(null); }} placeholder="/path/to/prepared-world" disabled={busy}/></label>
      <label className="world-checkbox"><input type="checkbox" checked={noRebase} onChange={event => setNoRebase(event.target.checked)} disabled={busy}/> Keep the artifact's original dates</label>
      <p>{customPath.trim() || (selected ? `${selected.id}:${selected.version}` : "Select a world or enter its prepared artifact path.")}</p>
      <Button kind="danger" disabled={busy || session.phase !== "ready" || (!customPath.trim() && !selected?.valid)} onClick={switchWorld}>{busy ? "Switching world…" : "Switch world and restore baseline"}</Button>
    </Panel>}
  </>;
}

export function WorldCatalogue({ entries, selected, busy, onSelect }) {
  return <div className="world-catalogue">{entries.map(entry => {
      const chosen = selected?.artifactPath === entry.artifactPath;
      return <Panel key={entry.artifactPath} className={`world-choice ${chosen ? "selected" : ""}`}>
        <strong>{entry.id ? `${entry.id}:${entry.version}` : entry.artifactPath}</strong>
        <span>{entry.valid ? "Verified artifact" : "Unavailable · invalid artifact"}</span>
        <code>{entry.digest ?? "No verified digest"}</code>
        <details><summary>Artifact and source</summary><p>{entry.artifactPath}</p><p>{entry.sourcePath ?? "Source is not available for date rebasing."}</p></details>
        {(entry.errors ?? []).length > 0 && <ul>{entry.errors.map((message, index) => <li key={index}>{message}</li>)}</ul>}
        <Button disabled={!entry.valid || busy} onClick={() => onSelect(entry)}>{chosen ? "Selected" : "Select this world"}</Button>
      </Panel>;
    })}</div>;
}
