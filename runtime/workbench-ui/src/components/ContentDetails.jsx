import { useEffect, useState } from "react";
import { request } from "../api.js";
import { Button, Notice } from "./Primitives.jsx";

export function MessageContent({ content }) {
  return <>
    {content.text ? <pre className="message-content">{content.text}</pre> : content.html ? <iframe title="Email content" className="message-html" sandbox="" referrerPolicy="no-referrer"
      srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>body{font:15px/1.6 system-ui;overflow-wrap:anywhere}</style>${content.html}`}/> : <p className="muted">No message body.</p>}
    {content.attachments?.length > 0 && <p className="muted">Attachments: {content.attachments.map(item => item.name).join(", ")}</p>}
    {content.comments?.map(comment => <article className="issue-comment" key={comment.id}><strong>{comment.user?.login ?? "Comment"}</strong><small>{comment.created_at}</small><pre className="message-content">{comment.body}</pre></article>)}
    {content.commentsStatus && content.commentsStatus.status !== "complete" && <Notice kind="warning">Some comments are unavailable.</Notice>}
  </>;
}

export function ContentDetails({ summary, endpoint, onReply, initialText }) {
  const [open, setOpen] = useState(false), [content, setContent] = useState(null), [error, setError] = useState(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController(); setContent(null); setError(null);
    request(endpoint, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setContent(value); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause.message); });
    return () => abort.abort();
  }, [open, endpoint, retry]);
  return <details className="content-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}<span className="content-hint">{open ? "Close" : "Open"}</span></summary>
    {open && <div className="content-detail-body">
      {content ? <MessageContent content={content}/> : <>{initialText && <pre className="message-content">{initialText}</pre>}{!error && <p className="muted">Loading content…</p>}</>}
      {error && <Notice kind="error">{error} <Button kind="small" onClick={() => setRetry(value => value + 1)}>Retry</Button></Notice>}
      {onReply && <Button kind="small" onClick={onReply}>Reply</Button>}
    </div>}
  </details>;
}
