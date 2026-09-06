import { useEffect, useRef, useState } from "react";
import { post, request } from "../api.js";
import { Button, Notice, PageHead, Panel } from "../components/Primitives.jsx";

const label = record => record.name ?? record.title ?? record.number ?? record.id;

export function DomainRecords({ data, actor, onAction, onChanged, liveRevision }) {
  const domain = data.providers?.domain;
  const collections = domain?.collections ?? [];
  const [collection, setCollection] = useState(() => collections[0]?.name ?? "");
  const [page, setPage] = useState(null), [cursors, setCursors] = useState([null]);
  const [query, setQuery] = useState(""), [selected, setSelected] = useState(null);
  const [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(null), [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false), [message, setMessage] = useState(null);
  const sequence = useRef(0), detailSequence = useRef(0);
  const metadata = collections.find(row => row.name === collection);

  async function load(cursor = null, manual = false) {
    if (!collection) return;
    const current = ++sequence.current;
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ collection, limit: "50", ...(cursor ? { cursor } : {}) });
      const value = await request(`/api/provider/domain?${params}`);
      if (current !== sequence.current) return;
      setPage(value);
      if (manual) onAction?.({ type: "read", surface: "domain", target: collection, success: true });
      return true;
    } catch (failure) {
      if (current === sequence.current) { setPage(null); setSelected(null); setError(failure.message); }
    } finally { if (current === sequence.current) setBusy(false); }
  }

  useEffect(() => {
    if (!collections.some(row => row.name === collection)) setCollection(collections[0]?.name ?? "");
  }, [collections, collection]);
  useEffect(() => {
    setPage(null); setSelected(null); setCursors([null]); setQuery(""); setEditor(null);
    detailSequence.current++;
    load();
    return () => { sequence.current++; detailSequence.current++; };
  }, [collection, liveRevision]);

  async function inspect(id) {
    const current = ++detailSequence.current;
    setError(null);
    try {
      const value = await request(`/api/provider/domain?${new URLSearchParams({ collection, id })}`);
      if (current !== detailSequence.current) return;
      setSelected(value.record);
      onAction?.({ type: "read", surface: "domain", target: collection, success: true });
    } catch (failure) { if (current === detailSequence.current) { setSelected(null); setError(failure.message); } }
  }

  async function move(forward) {
    const next = forward ? [...cursors, page.next_cursor] : cursors.slice(0, -1);
    if (await load(next.at(-1), true)) { setCursors(next); setSelected(null); setQuery(""); }
  }
  function edit(method) {
    setError(null); setMessage(null);
    setEditor({ method, recordId: method === "POST" ? undefined : selected.id });
    setDraft(method === "POST" ? '{\n  "id": ""\n}' : JSON.stringify(selected, null, 2));
  }
  async function save() {
    if (!editor || !actor || saving) return;
    setError(null); setMessage(null); setSaving(true);
    try {
      let record;
      if (editor.method !== "DELETE") {
        record = JSON.parse(draft);
        if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Enter a JSON object for the record.");
      }
      const result = await post("/api/actions/domain", { ...editor, collection, actor_id: actor.id,
        ...(editor.method === "POST" ? { record } : editor.method === "PATCH" ? { patch: record } : {}) });
      onAction?.({ type: "write", surface: "domain", target: collection, success: true, eventId: result.event.id });
      setEditor(null); setSelected(null); setCursors([null]); setMessage(result.message);
      await load();
      await onChanged?.();
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  const rows = (page?.data ?? []).filter(row => JSON.stringify(row).toLowerCase().includes(query.trim().toLowerCase()));
  const available = domain?.available && domain.collectionStatus?.collections?.status === "complete";
  return <>
    <PageHead title="World records" subtitle="Read complete records and change collections that permit writes." command="Domain API"/>
    {!available && <Notice kind="warning">Collection metadata is unavailable. {domain?.error}</Notice>}
    {error && <div className="section"><Notice kind="error">{error}</Notice></div>}
    {message && <div className="section"><Notice>{message}</Notice></div>}
    <div className="action-form">
      <label>COLLECTION<select value={collection} onChange={event => setCollection(event.target.value)} disabled={saving || !available || !collections.length}>
        {!collections.length && <option value="">No collections available</option>}
        {collections.map(row => <option key={row.name} value={row.name}>{row.name} · {row.count} records</option>)}
      </select></label>
      <label>FILTER THIS PAGE<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Any record field"/></label>
      <Button onClick={() => load(cursors.at(-1), true)} disabled={busy || !collection}>{busy ? "Reading…" : "Refresh records"}</Button>
      {metadata?.writable && <Button onClick={() => edit("POST")} disabled={!actor || saving}>Create record</Button>}
    </div>
    {metadata && <p className="muted">{metadata.writable ? "This collection accepts changes." : "This collection is read-only."} Full records include nested values and references.</p>}
    {metadata?.writable && metadata.provider_sync === false && <p className="muted">Changes apply to the domain API. They do not update records in other providers.</p>}
    {metadata?.writable && !actor && <Notice kind="warning">Select a person before you change a record.</Notice>}
    {editor && <div className="section"><Panel title={editor.method === "DELETE" ? "Delete record" : editor.method === "POST" ? "Create record" : "Update record"}>
      <div className="action-form">
        <p>{editor.method === "DELETE" ? `Delete ${editor.recordId} from ${collection}.` : `Write to ${collection} as ${actor?.name ?? actor?.id ?? "the selected person"}.`}</p>
        {editor.method !== "DELETE" && <label>RECORD JSON<textarea rows={14} value={draft} onChange={event => setDraft(event.target.value)} disabled={saving}/></label>}
        <Button onClick={save} disabled={saving || !actor}>{saving ? "Saving…" : editor.method === "DELETE" ? "Delete this record" : "Save record"}</Button>
        <Button onClick={() => setEditor(null)} disabled={saving}>Cancel</Button>
      </div>
    </Panel></div>}
    <Panel title={collection || "Records"} tools={<span>{page ? `${page.total_count} total · page ${cursors.length}` : "Count unavailable"}</span>}>
      <div className="data-row domain-columns table-head"><span>RECORD</span><span>ID</span><span>STATE</span></div>
      {rows.map(row => <button className="data-row domain-columns clickable-row" key={row.id} onClick={() => inspect(row.id)}><strong>{label(row)}</strong><code>{row.id}</code><span>{row.status ?? "—"}</span></button>)}
      {page && !rows.length && !error && <div className="empty">{query ? "No records on this page match the filter." : "This collection is empty."}</div>}
      <div className="panel-head"><Button disabled={busy || cursors.length < 2} onClick={() => move(false)}>Previous page</Button><span>{page ? `${rows.length} of ${page.data.length} records on this page` : "No successful read yet"}</span><Button disabled={busy || !page?.has_more} onClick={() => move(true)}>Next page</Button></div>
    </Panel>
    {selected && <div className="section"><Panel title={label(selected)} tools={<Button onClick={() => setSelected(null)}>Close record</Button>}>
      <pre className="domain-record">{JSON.stringify(selected, null, 2)}</pre>
      {metadata?.writable && <div className="panel-head"><Button onClick={() => edit("PATCH")} disabled={!actor || saving}>Edit record</Button><Button onClick={() => edit("DELETE")} disabled={!actor || saving}>Delete record</Button></div>}
    </Panel></div>}
    {page?.world && <p className="muted domain-source">Source: {page.world.id}:{page.world.version} <code>{page.world.artifact_sha256}</code></p>}
  </>;
}
