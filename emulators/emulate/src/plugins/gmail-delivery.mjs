// Shared public Gmail delivery for the runtime and standalone composer timers.
// Verify the credential owner before a write, resolve custom labels, then retain
// the actual message ID returned by Gmail.
export async function insertGmailMessage({ baseUrl, token, user, message, fetchImpl = fetch }) {
  if (!token || !user) throw new Error("Gmail delivery needs a recipient and that recipient's credential");
  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gmail answered HTTP ${response.status} for ${path}`);
    const data = await response.json();
    if (data?.error) throw new Error(`Gmail returned an API error for ${path}`);
    return data;
  };
  const identity = await request("/oauth2/v2/userinfo");
  if (identity.email !== user) throw new Error("Gmail credential does not belong to the arrival recipient");
  const prefix = `/gmail/v1/users/${encodeURIComponent(user)}`;
  const available = (await request(`${prefix}/labels`)).labels;
  if (!Array.isArray(available)) throw new Error("Gmail did not return the recipient's labels");
  const labels = message.labelIds ?? message.label_ids ?? ["INBOX", "UNREAD"];
  if (!Array.isArray(labels) || labels.some(label => typeof label !== "string" || !label)) throw new Error("Gmail label references must be strings");
  const labelIds = labels.map(label => {
    const exact = available.filter(row => row.id === label);
    const matches = exact.length ? exact : available.filter(row => row.name === label);
    if (matches.length !== 1) throw new Error(`Gmail recipient has no unique label ${JSON.stringify(label)}`);
    return matches[0].id;
  });
  // The API generates the ID. An authored ID must never stand in for its answer.
  const { id: _id, label_ids: _labelIds, ...body } = message;
  const inserted = await request(`${prefix}/messages`, { method: "POST", body: JSON.stringify({ ...body, labelIds }) });
  if (typeof inserted.id !== "string" || !inserted.id) throw new Error("Gmail accepted the insert but returned no message ID");
  const live = await request(`${prefix}/messages/${encodeURIComponent(inserted.id)}?format=full`);
  if (live.id !== inserted.id || [...new Set(live.labelIds ?? [])].sort().join("\0") !== [...new Set(labelIds)].sort().join("\0")) {
    throw new Error("Gmail message read-back does not match the accepted insert");
  }
  const headers = Object.fromEntries((live.payload?.headers ?? []).map(header => [header.name.toLowerCase(), header.value]));
  for (const field of ["from", "to", "subject"]) {
    if (body[field] !== undefined && headers[field] !== body[field]) throw new Error(`Gmail message read-back has a different ${field}`);
  }
  if (body.body_text !== undefined) {
    const plain = part => {
      if (part?.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
      for (const child of part?.parts ?? []) { const found = plain(child); if (found !== null) return found; }
      return null;
    };
    const normalize = value => String(value ?? "").replace(/\r\n/g, "\n").trimEnd();
    if (normalize(plain(live.payload)) !== normalize(body.body_text)) throw new Error("Gmail message read-back has a different body");
  }
  return { id: live.id, threadId: live.threadId, labelIds: live.labelIds };
}
