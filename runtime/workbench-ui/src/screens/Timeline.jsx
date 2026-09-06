import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGeneration, generationResponse, request } from "../api.js";
import { Button, Notice, PageHead, Panel } from "../components/Primitives.jsx";
import { acceptClockSample, clockSample, elapsedLabel, followTimeWindow, initialTimeWindow, interpolatedElapsed,
  OUTCOMES, readClockCommandResponse, readTimelineWindow, recordsForView, timelineReadReady, timeWindowFromInputs, VIEW_UNITS, visibleEventGroups } from "../timeline-model.mjs";

function useElapsed(sample) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    let frame;
    const draw = () => { setNow(performance.now()); frame = requestAnimationFrame(draw); };
    if (sample?.status.clock.running) frame = requestAnimationFrame(draw);
    else setNow(performance.now());
    return () => cancelAnimationFrame(frame);
  }, [sample]);
  return interpolatedElapsed(sample, now);
}

function ClockPosition({ sample }) {
  const elapsed = useElapsed(sample);
  return <strong className="timeline-position">{elapsedLabel(elapsed)}</strong>;
}

export function TimelineAxis({ sample, rows, window, selectedGroup, onSelect }) {
  const ref = useRef(null), elapsed = useElapsed(sample);
  const [slots, setSlots] = useState(12);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setSlots(Math.max(1, Math.floor(entry.contentRect.width / 48))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const groups = useMemo(() => visibleEventGroups(rows, window, slots), [rows, window, slots]);
  const inView = elapsed >= window.from && elapsed <= window.from + window.span;
  return <div className="timeline-plot" ref={ref}>
    <div className="timeline-axis" aria-label="Elapsed time window. Event marks open record groups; the clock cannot be dragged.">
      <div className="timeline-rule"/>
      {groups.map(group => <button key={group.key} type="button" className={`timeline-mark ${selectedGroup?.from === group.from && selectedGroup?.to === group.to ? "selected" : ""}`}
        style={{ left: `${(group.key + 0.5) / slots * 100}%` }}
        aria-pressed={selectedGroup?.from === group.from && selectedGroup?.to === group.to}
        aria-label={`${group.rows.length} loaded ${group.rows.length === 1 ? "event" : "events"} near ${elapsedLabel(group.from)}. ${Object.entries(group.outcomes).map(([status, count]) => `${count} ${OUTCOMES[status].label}`).join(", ")}`}
        onClick={() => onSelect(group)}><span aria-hidden="true">{group.rows.length === 1 ? OUTCOMES[group.rows[0].status].mark : "▦"}</span><small>{group.rows.length}</small></button>)}
      {inView && <div className="timeline-cursor" style={{ left: `${(elapsed - window.from) / window.span * 100}%` }} aria-label={`Current clock position ${elapsedLabel(elapsed)}`}><span>▼</span></div>}
    </div>
    <div className="timeline-ticks"><span>{elapsedLabel(window.from)}</span><span>{elapsedLabel(window.from + window.span / 2)}</span><span>{elapsedLabel(window.from + window.span)} →</span></div>
    <p className="muted">Future stays open. {inView ? "The line marks the current time." : "The current time is outside this view."} Moving this view does not move the clock.</p>
  </div>;
}

export function TimelineRecords({ rows, onInspect }) {
  return <div className="timeline-records">{rows.map(row => <details key={row.id} className={`timeline-record outcome-${row.status}`} onToggle={event => { if (event.currentTarget.open) onInspect?.(); }}>
    <summary><span className="timeline-outcome"><b aria-hidden="true">{OUTCOMES[row.status].mark}</b>{OUTCOMES[row.status].label}</span>
      <time>{elapsedLabel(row.due_at)}</time><span><strong>{row.id}</strong><small>{row.type}</small></span></summary>
    <dl><dt>Schedule sequence</dt><dd>{row.seq}</dd><dt>Due at</dt><dd>{row.due_at} ms after the world start</dd>
      {[["Caused by", row.caused_by], ["Command", row.command_id], ["Accepted event", row.event_id],
        ["Attempt started", row.started_at ?? row.attempted_at], ["Delivered at", row.delivered_at], ["Reason", row.reason], ["Error", row.error]]
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([name, value]) => <div className="timeline-field" key={name}><dt>{name}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd></div>)}
    </dl>
    {Object.hasOwn(row, "payload") && <div className="timeline-payload"><strong>Event payload</strong><pre>{JSON.stringify(row.payload, null, 2)}</pre></div>}
  </details>)}</div>;
}

export function TimelineControls({ sample, busy, onCommand, reconnectRequired = false }) {
  const status = sample.status, setup = status.mode === "setup";
  const [duration, setDuration] = useState(""), [startAt, setStartAt] = useState("0s");
  const [setupRepeat, setSetupRepeat] = useState(() => status.repeat.enabled);
  useEffect(() => setSetupRepeat(status.repeat.enabled), [status.repeat.enabled]);
  const blocked = reconnectRequired || Boolean(busy) || !timelineReadReady(status) || status.mode === "failed";
  const repeatEnabled = setup ? setupRepeat : status.repeat.enabled;
  return <Panel className="timeline-control">
    <div className="timeline-clock"><span><small>WORLD ELAPSED TIME</small><ClockPosition sample={sample}/></span>
      <span className="timeline-mode">{status.mode === "resetting" ? "Resetting · controls unavailable" : status.mode === "initializing" ? "Initializing · controls unavailable" : setup ? "Setup · paused before delivery" : status.mode === "failed" ? "! Failed · paused" : status.mode === "stopped" ? "Stopped" : !status.clock.started ? "Clock not started" : status.clock.running ? "▶ Running" : "Ⅱ Paused"}</span>
      <span className="muted">Provider cycle {status.repeat.cycle}{status.clock.world_now && <small>{status.clock.world_now}</small>}</span>
    </div>
    {setup ? <form className="timeline-command" onSubmit={event => { event.preventDefault(); onCommand({ action: "start", duration: startAt, enabled: setupRepeat }); }}>
      <label>Start at elapsed time<input value={startAt} onChange={event => setStartAt(event.target.value)} placeholder="90s, 5m, 1w" required disabled={blocked}/></label>
      <Button type="submit" disabled={blocked || !startAt.trim()}>{busy === "start" ? "Applying starting position…" : "Apply position and start"}</Button>
      <p>Events due at or before this position run before live delivery starts. Review any failure before you connect an application.</p>
    </form> : <>
      <form className="timeline-command" onSubmit={event => { event.preventDefault(); onCommand({ action: "advance", duration }); }}>
        <Button type="button" disabled={blocked} onClick={() => onCommand({ action: status.clock.running ? "pause" : "resume" })}>{status.clock.running ? "Pause" : "Resume"}</Button>
        <label>Advance by<input value={duration} onChange={event => setDuration(event.target.value)} placeholder="90s, 5m, 1w" required disabled={blocked}/></label>
        <Button type="submit" disabled={blocked || !duration.trim()}>{busy === "advance" ? "Delivering due events…" : "Advance forward"}</Button>
      </form>
      <p className="muted">Advance only moves forward. A paused world stays paused after an advance. For a new run with a starting-position selector, use <code>worldfixture up --setup</code>.</p>
    </>}
    <div className="timeline-repeat"><label><input type="checkbox" checked={repeatEnabled} disabled={blocked || !status.repeat.eligible}
      onChange={event => setup ? setSetupRepeat(event.target.checked) : onCommand({ action: "repeat", enabled: event.target.checked })}/> Repeat with baseline restore</label>
      <p>Each cycle restores world and provider state and removes manual provider changes. Application database data and connector receipts remain. Repeat is off unless you enable it.</p>
      {!status.repeat.eligible && <p>{status.repeat.reason ?? "This run is not eligible for repeat."}</p>}
      <p className="muted">Repeat: {status.repeat.status}{status.repeat.error ? ` · ${status.repeat.error}` : ""}</p>
    </div>
  </Panel>;
}

function WindowChooser({ onChange }) {
  const [from, setFrom] = useState("0"), [span, setSpan] = useState("1"), [unit, setUnit] = useState("minutes"), [error, setError] = useState(null);
  return <details className="timeline-window-picker"><summary>Choose a time window</summary>
    <form className="timeline-command" onSubmit={event => { event.preventDefault(); try { onChange(timeWindowFromInputs(from, span, unit)); setError(null); } catch (cause) { setError(cause.message); } }}>
      <label>View from<input type="number" min="0" step="any" required value={from} onChange={event => setFrom(event.target.value)}/></label>
      <label>Window length<input type="number" min="0" step="any" required value={span} onChange={event => setSpan(event.target.value)}/></label>
      <label>Time unit<select value={unit} onChange={event => setUnit(event.target.value)}>{Object.keys(VIEW_UNITS).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <Button type="submit">View these times</Button>
      <p>This changes the displayed records only. It does not advance, pause, or reset the world.</p>
    </form>{error && <Notice kind="error">{error}</Notice>}
  </details>;
}

export function TimelineOutcome({ played, status }) {
  if (!played || !timelineReadReady(status)) return null;
  return <Notice><strong>{played.action} {played.accepted ? "accepted" : "result"}.</strong> {played.rows.length} scheduled outcomes returned.
    {played.rows.length > 0 && <details><summary>Show operation outcomes</summary><ul>{played.rows.map(row => <li key={row.id}><code>{row.id}</code> · {OUTCOMES[row.status]?.label ?? row.status}{row.reason ? ` · ${row.reason}` : ""}{row.event_id ? ` · event ${row.event_id}` : ""}</li>)}</ul></details>}
  </Notice>;
}

export function Timeline({ onChanged, session }) {
  const [sample, setSample] = useState(null), [clockError, setClockError] = useState(null);
  const [busy, setBusy] = useState(null), [commandError, setCommandError] = useState(null), [played, setPlayed] = useState(null);
  const [window, setWindow] = useState(null), [follow, setFollow] = useState(true), [pages, setPages] = useState(1);
  const [records, setRecords] = useState(null), [recordsError, setRecordsError] = useState(null), [loading, setLoading] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState(null), [refresh, setRefresh] = useState(0);
  const sampleRef = useRef(null), lifetime = useRef(null);
  const receive = useCallback(value => {
    if (value.generation && value.generation !== apiGeneration()) return;
    const next = acceptClockSample(sampleRef.current, clockSample(value, performance.now()));
    sampleRef.current = next;
    setSample(next); setClockError(null);
    setWindow(current => current ?? initialTimeWindow(next.status));
  }, []);
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    const poll = async () => {
      if (document.hidden) return;
      try { receive(await request("/api/clock", { signal: abort.signal })); }
      catch (error) { if (!abort.signal.aborted) setClockError(error.message); }
    };
    poll();
    const timer = setInterval(poll, 5000), events = new EventSource("/api/live");
    const clock = event => { try { receive(JSON.parse(event.data)); } catch (error) { setClockError(error.message); } };
    events.addEventListener("clock", clock);
    return () => { abort.abort(); clearInterval(timer); events.close(); };
  }, [receive]);
  const cycle = sample?.status.repeat.cycle;
  const readingReady = timelineReadReady(sample?.status);
  useEffect(() => { setRecords(null); setPages(1); setPlayed(null); setSelectedGroup(null); }, [cycle]);
  useEffect(() => { if (!readingReady) { setRecords(null); setPlayed(null); setSelectedGroup(null); setRecordsError(null); setLoading(false); } }, [readingReady]);
  useEffect(() => { setRecords(null); setPages(1); setSelectedGroup(null); }, [window]);
  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => {
      if (sampleRef.current) setWindow(current => current ? followTimeWindow(current, interpolatedElapsed(sampleRef.current, performance.now())) : current);
    }, 500);
    return () => clearInterval(timer);
  }, [follow]);
  useEffect(() => {
    if (!window || cycle === undefined || !readingReady) return;
    const abort = new AbortController(); let reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true; setLoading(true);
      try {
        const next = await readTimelineWindow(request, window, pages, abort.signal);
        if (!abort.signal.aborted && timelineReadReady(sampleRef.current?.status) && next.cycle === sampleRef.current?.status.repeat.cycle) { setRecords(next); setRecordsError(null); }
      } catch (error) { if (!abort.signal.aborted) setRecordsError(error.message); }
      finally { reading = false; if (!abort.signal.aborted) setLoading(false); }
    };
    read(); const timer = setInterval(read, 5000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [window, pages, cycle, refresh, readingReady]);
  async function command(input) {
    setBusy(input.action); setCommandError(null); setPlayed(null);
    try {
      const response = await generationResponse("/api/clock", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(input), signal: lifetime.current?.signal });
      const result = await readClockCommandResponse(response);
      if (result.status) {
        receive(result.status);
        if (result.status.repeat.cycle === sampleRef.current?.status.repeat.cycle) setPlayed({ action: input.action, accepted: result.accepted, rows: result.status.played ?? [] });
      }
      if (!result.accepted) setCommandError(result.error);
      setRefresh(value => value + 1);
      await onChanged?.();
    } catch (error) { if (!lifetime.current?.signal.aborted) setCommandError(error.message); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(null); }
  }
  function moveWindow(next) { setWindow(next); setFollow(false); setPages(1); setRecords(null); setSelectedGroup(null); }
  const currentRecords = recordsForView(records, cycle, window, sample?.status);
  const rows = currentRecords?.rows ?? [];
  const selectedRows = selectedGroup ? rows.filter(row => row.due_at >= selectedGroup.from && (row.due_at < selectedGroup.to || selectedGroup.includesEnd && row.due_at === selectedGroup.to)) : rows;
  return <>
    <PageHead title="Timeline" subtitle="Choose a starting position, control forward time, and inspect scheduled outcomes." command="worldfixture clock"/>
    {clockError && <Notice kind="error">Clock status unavailable: {clockError}. Any moving cursor is an estimate from the last server sample.</Notice>}
    {!sample ? <p className="muted">Waiting for the runtime clock…</p> : <>
      <TimelineControls key={cycle} reconnectRequired={session?.reconnect_required} sample={sample} busy={busy || Boolean(clockError)} onCommand={command}/>
      {commandError && <Notice kind="error">Clock operation failed: {commandError}</Notice>}
      {sample.status.mode === "failed" && <Notice kind="error">The timeline has stopped after a failure. Inspect the failed records before reset.</Notice>}
      {readingReady ? <div className="timeline-counts">{Object.entries(OUTCOMES).map(([status, display]) => <span key={status}><b aria-hidden="true">{display.mark}</b>{display.label} <strong>{sample.status.timeline[status] ?? "Unavailable"}</strong></span>)}</div>
        : <Notice>Timeline records and outcomes are unavailable while the runtime is {sample.status.mode}. Wait for the next ready clock state.</Notice>}
      <TimelineOutcome played={played} status={sample.status}/>
      {window && <Panel title="Scheduled records" tools={<Button kind="small" onClick={() => setRefresh(value => value + 1)}>Refresh records</Button>}>
        <div className="timeline-view-controls"><Button kind="small" disabled={window.from === 0} onClick={() => moveWindow({ ...window, from: Math.max(0, window.from - window.span) })}>Earlier view</Button>
          <Button kind="small" disabled={!Number.isSafeInteger(Math.ceil(window.from + window.span * 2))} onClick={() => moveWindow({ ...window, from: window.from + window.span })}>Later view</Button>
          <Button kind="small" disabled={window.span <= 1000} onClick={() => moveWindow({ ...window, span: Math.max(1000, window.span / 2) })}>Zoom in</Button>
          <Button kind="small" disabled={!Number.isSafeInteger(Math.ceil(window.from + window.span * 2))} onClick={() => moveWindow({ ...window, span: window.span * 2 })}>Zoom out</Button>
          <label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)}/> Follow clock</label>
        </div>
        <WindowChooser onChange={moveWindow}/>
        <TimelineAxis sample={sample} rows={rows} window={window} selectedGroup={selectedGroup} onSelect={group => { setSelectedGroup(group); setFollow(false); }}/>
        {recordsError && <Notice kind="error">Timeline records unavailable: {recordsError}. Previously loaded records may be stale.</Notice>}
        <div className="timeline-list-head"><span>{readingReady ? `${rows.length} loaded` : "Waiting for the runtime timeline"}{currentRecords ? ` of ${currentRecords.total} scheduled records in this window` : ""}{loading ? " · Reading…" : ""}</span>
          {selectedGroup && <Button kind="small" onClick={() => setSelectedGroup(null)}>Show all loaded events</Button>}</div>
        {selectedGroup && <p className="muted">Selected group: {elapsedLabel(selectedGroup.from)} to {elapsedLabel(selectedGroup.to)}. Every loaded event in the group is listed below.</p>}
        <TimelineRecords rows={selectedRows} onInspect={() => setFollow(false)}/>
        {currentRecords && !loading && !recordsError && selectedRows.length === 0 && <p className="empty">{selectedGroup ? "No loaded records in this group." : "No scheduled records in this time window."}</p>}
        {currentRecords?.hasMore && <div className="timeline-more"><Button disabled={loading} onClick={() => setPages(value => value + 1)}>Load more events in this window</Button><p className="muted">The marks show loaded records. More events, including overlapping events, remain available.</p></div>}
      </Panel>}
    </>}
  </>;
}
