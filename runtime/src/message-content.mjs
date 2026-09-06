// Decode provider message bodies. The UI renders text as text and HTML in a
// sandbox with a restrictive CSP; message HTML is never part of the app DOM.
export function gmailContent(payload = {}) {
  const result = { text: '', html: '', attachments: [] };
  function visit(part) {
    if (part.filename) { result.attachments.push({ name: part.filename, size: part.body?.size }); return; }
    if (part.body?.data) {
      const value = Buffer.from(part.body.data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/html') result.html += value;
      else if (!part.mimeType || part.mimeType === 'text/plain') result.text += value;
    }
    for (const child of part.parts ?? []) visit(child);
  }
  visit(payload); return result;
}

export function mimeContent(source) {
  const result = { text: '', html: '', attachments: [] };
  function visit(raw) {
    const split = raw.search(/\r?\n\r?\n/);
    if (split < 0) return;
    const head = raw.slice(0, split).replace(/\r?\n[ \t]+/g, ' ');
    const headers = Object.fromEntries(head.split(/\r?\n/).map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]; }));
    let body = raw.slice(split).replace(/^\r?\n\r?\n/, '');
    const type = headers['content-type'] ?? 'text/plain';
    const parameter = name => type.match(new RegExp(`${name}="([^"]+)"|${name}=([^;\\s]+)`, 'i'))?.slice(1).find(Boolean);
    const boundary = parameter('boundary');
    if (/^multipart\//i.test(type) && boundary) {
      const sections = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*(?:\\r?\\n|$)`));
      for (let index = 2; index < sections.length; index += 2) { if (sections[index - 1] === '--') break; visit(sections[index]); }
      return;
    }
    if (/attachment/i.test(headers['content-disposition'] ?? '') || parameter('name')) {
      result.attachments.push({ name: parameter('name') ?? headers['content-disposition']?.match(/filename="?([^";]+)/i)?.[1] ?? 'Attachment' }); return;
    }
    const encoding = headers['content-transfer-encoding']?.toLowerCase();
    let bytes;
    if (encoding === 'base64') bytes = Buffer.from(body, 'base64');
    else if (encoding === 'quoted-printable') bytes = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    else bytes = Buffer.from(body, 'utf8');
    try { body = new TextDecoder(parameter('charset') ?? 'utf-8').decode(bytes); } catch { body = bytes.toString('utf8'); }
    if (/^text\/html/i.test(type)) result.html += body;
    else if (/^text\/plain/i.test(type)) result.text += body;
  }
  visit(source); return result;
}
