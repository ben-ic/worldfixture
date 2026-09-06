import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const GOOGLE_SEED_RECEIPT = "worldfixture.google-seed-receipt/v1";
export const GOOGLE_SYSTEM_LABELS = new Set([
  "INBOX", "SENT", "UNREAD", "STARRED", "IMPORTANT", "TRASH", "SPAM", "DRAFT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
]);

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function equal(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Google seed verification failed: ${label}`);
}
const sorted = values => [...values].sort();
const pair = (left, right) => JSON.stringify([left, right]);
const textBody = value => String(value ?? "").replace(/\r\n/g, "\n").trimEnd();

// Gmail's pinned seed entry point deduplicates IDs across all mailboxes.
// Give each owner a distinct provider ID while retaining the source identity.
export function googleWorldMessageId(world, ownerId, sourceId) {
  for (const [label, value] of Object.entries({ world: world?.id, version: world?.version, ownerId, sourceId })) required(value, label);
  return `wf_${createHash("sha256").update(JSON.stringify([world.id, world.version, ownerId, sourceId])).digest("hex").slice(0, 32)}`;
}

export function prepareWorldGoogleSeed({ world, config, arrivals = [] }) {
  required(world?.id, "world.id");
  required(world?.version, "world.version");
  if (!/^[a-f0-9]{64}$/.test(world?.digest ?? "")) throw new Error("world.digest must be a SHA-256 digest");
  if (!Array.isArray(config?.users) || !Array.isArray(config?.messages)) throw new Error("Google seed needs explicit users and messages arrays");
  const seed = structuredClone(config), owners = new Map(), emails = new Set(), messages = [], labels = new Map();
  for (const user of seed.users) {
    const id = required(user.worldfixture_person_id, "Google user worldfixture_person_id");
    const email = required(user.email, `Google user ${id} email`);
    if (owners.has(id) || emails.has(email)) throw new Error(`Duplicate Google mailbox: ${id}`);
    owners.set(id, user);
    emails.add(email);
  }
  const ownerFor = (id, email) => {
    const user = owners.get(id);
    if (!user || email && user.email !== email) throw new Error(`Unknown or mismatched Google mailbox owner: ${id}`);
    return user;
  };
  const addLabel = (user, name, id = name) => {
    required(name, "Google label name");
    required(id, "Google label ID");
    if (GOOGLE_SYSTEM_LABELS.has(id)) {
      if (name !== id) throw new Error(`Google system label cannot be renamed: ${id}`);
      return;
    }
    const key = pair(user.email, name), existing = labels.get(key);
    if (existing && existing.id !== id) throw new Error(`Conflicting Google label IDs: ${user.email}/${name}`);
    if ([...labels.values()].some(label => label.user_email === user.email && label.id === id && label.name !== name)) {
      throw new Error(`Conflicting Google label names: ${user.email}/${id}`);
    }
    labels.set(key, { id, name, user_email: user.email, type: "user" });
  };
  for (const label of seed.labels ?? []) {
    const user = [...owners.values()].find(owner => owner.email === label.user_email);
    if (!user) throw new Error(`Unknown Google label owner: ${label.user_email}`);
    addLabel(user, label.name, label.id ?? label.name);
  }
  const addReferences = (user, values) => {
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())) throw new Error("Google label references must be nonempty strings");
    if (new Set(values).size !== values.length) throw new Error("Duplicate Google label reference");
    for (const id of values) {
      if (!GOOGLE_SYSTEM_LABELS.has(id) && ![...labels.values()].some(label => label.user_email === user.email && label.id === id)) {
        throw new Error(`Undeclared Google custom label: ${user.worldfixture_person_id}/${id}`);
      }
    }
  };
  const identities = new Set();
  seed.messages = seed.messages.map(message => {
    const source = required(message.worldfixture_message_id, "Google message worldfixture_message_id");
    const owner = required(message.worldfixture_owner_id, "Google message worldfixture_owner_id");
    const user = ownerFor(owner, message.user_email);
    const key = pair(owner, source);
    if (identities.has(key)) throw new Error(`Duplicate Google source message for mailbox: ${owner}/${source}`);
    identities.add(key);
    addReferences(user, message.label_ids ?? []);
    const id = googleWorldMessageId(world, owner, source);
    messages.push({ source_person_id: owner, source_message_id: source, provider_message_id: id });
    return { ...message, id, user_email: user.email };
  });
  for (const arrival of arrivals) {
    if (arrival.via === "smtp") continue;
    const user = ownerFor(arrival.worldfixture_owner_id, arrival.user_email);
    addReferences(user, arrival.label_ids ?? ["INBOX", "UNREAD"]);
  }
  const driveIds = new Set();
  seed.drive_items = (seed.drive_items ?? []).map(item => {
    const owner = required(item.worldfixture_owner_id, "Google Drive worldfixture_owner_id");
    const user = ownerFor(owner, item.user_email);
    const source = required(item.worldfixture_document_id, "Google Drive worldfixture_document_id");
    required(item.id, "Google Drive ID");
    required(item.name, "Google Drive name");
    required(item.mime_type, "Google Drive mime_type");
    if (typeof item.data !== "string") throw new Error(`Google Drive data must be a string: ${source}`);
    if (driveIds.has(item.id)) throw new Error(`Duplicate Google Drive ID: ${item.id}`);
    driveIds.add(item.id);
    return { ...item, user_email: user.email };
  });
  for (const row of [...seed.calendars ?? [], ...seed.calendar_events ?? []]) {
    if (!emails.has(row.user_email)) throw new Error(`Unknown Google calendar owner: ${row.user_email}`);
  }
  seed.labels = [...labels.values()];
  return { seed, receipt: {
    api_version: GOOGLE_SEED_RECEIPT, world: { id: world.id, version: world.version, digest: world.digest },
    mailboxes: [...owners].map(([source_person_id, user]) => ({ source_person_id, email: user.email })),
    messages,
    drive_items: seed.drive_items.map(item => ({ source_person_id: item.worldfixture_owner_id,
      source_document_id: item.worldfixture_document_id, provider_file_id: item.id })),
    labels: [...owners].flatMap(([source_person_id, user]) => seed.labels
      .filter(label => label.user_email === user.email)
      .map(label => ({ source_person_id, source_label_id: label.id, name: label.name, provider_label_id: label.id }))),
  } };
}

function bodyText(part) {
  if (part?.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part?.parts ?? []) {
    const found = bodyText(child);
    if (found !== null) return found;
  }
  return null;
}

// seedFromConfig is a caller-supplied normal vendor seed entry point. fetchImpl
// must run the real Google routes. No helper opens or modifies a vendor store.
// On restore, supply the saved receipt after restoring the accepted snapshot;
// this mode performs reads only and checks that the receipt still fits the input.
export async function seedWorldGoogle({ world, config, arrivals, seedFromConfig, fetchImpl = fetch,
  baseUrl, tokensByPerson, receipt, signal, pageSize = 100 }) {
  const prepared = prepareWorldGoogleSeed({ world, config, arrivals });
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("Google pageSize must be between 1 and 500");
  for (const owner of prepared.receipt.mailboxes) required(tokensByPerson?.[owner.source_person_id], `Google credential for ${owner.source_person_id}`);
  if (receipt) equal(receipt, prepared.receipt, "saved receipt does not match selected artifact");
  signal?.throwIfAborted();
  // Upstream seedFromConfig creates fallback system labels even for users: [].
  if (!receipt && prepared.seed.users.length) await seedFromConfig(prepared.seed);
  const request = async (path, owner, media = false) => {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        headers: { authorization: `Bearer ${tokensByPerson[owner.source_person_id]}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
    } catch { throw new Error(`Google seed read failed: ${path}`); }
    if (!response.ok) throw new Error(`Google seed read returned HTTP ${response.status}: ${path}`);
    if (media) return response.text();
    const body = await response.json();
    if (body?.error) throw new Error(`Google seed read returned an API error: ${path}`);
    return body;
  };
  for (const owner of prepared.receipt.mailboxes) {
    const who = await request("/oauth2/v2/userinfo", owner);
    equal(who.email, owner.email, `credential identity for ${owner.source_person_id}`);
    const prefix = `/gmail/v1/users/${encodeURIComponent(owner.email)}`;
    const labelList = await request(`${prefix}/labels`, owner);
    if (!Array.isArray(labelList.labels)) throw new Error("Google labels response omitted labels");
    const custom = labelList.labels.filter(label => label.type !== "system");
    equal(sorted(custom.map(label => pair(label.id, label.name))),
      sorted(prepared.seed.labels.filter(label => label.user_email === owner.email).map(label => pair(label.id, label.name))), `custom labels for ${owner.source_person_id}`);
    const labelIds = new Set(labelList.labels.map(label => label.id));
    equal(labelIds.size, labelList.labels.length, `duplicate labels for ${owner.source_person_id}`);
    const listed = [], cursors = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ includeSpamTrash: "true", maxResults: String(pageSize) });
      if (cursor) query.set("pageToken", cursor);
      const page = await request(`${prefix}/messages?${query}`, owner);
      if (!Array.isArray(page.messages)) throw new Error("Google messages response omitted messages");
      listed.push(...page.messages);
      cursor = page.nextPageToken;
      if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Google pagination cursor did not advance");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const expected = prepared.seed.messages.filter(message => message.user_email === owner.email);
    equal(sorted(listed.map(message => message.id)), sorted(expected.map(message => message.id)), `message IDs for ${owner.source_person_id}`);
    for (const source of expected) {
      const live = await request(`${prefix}/messages/${encodeURIComponent(source.id)}?format=full`, owner);
      const headers = Object.fromEntries((live.payload?.headers ?? []).map(header => [header.name.toLowerCase(), header.value]));
      equal({ id: live.id, thread: live.threadId, from: headers.from, to: headers.to, subject: headers.subject,
        body: textBody(bodyText(live.payload)), labels: sorted(live.labelIds ?? []) },
      { id: source.id, thread: source.thread_id, from: source.from, to: source.to, subject: source.subject,
        body: textBody(source.body_text), labels: sorted(source.label_ids ?? []) }, `message ${source.worldfixture_owner_id}/${source.worldfixture_message_id}`);
      for (const id of live.labelIds ?? []) if (!labelIds.has(id)) throw new Error(`Google message references an absent label: ${id}`);
      if (source.date) equal(Number(live.internalDate), Date.parse(source.date), `message date ${source.id}`);
    }
    const files = [], fileCursors = new Set();
    let fileCursor;
    do {
      const query = new URLSearchParams({ pageSize: String(pageSize) });
      if (fileCursor) query.set("pageToken", fileCursor);
      const page = await request(`/drive/v3/files?${query}`, owner);
      if (!Array.isArray(page.files)) throw new Error("Google Drive response omitted files");
      files.push(...page.files);
      fileCursor = page.nextPageToken;
      if (fileCursor && (typeof fileCursor !== "string" || fileCursors.has(fileCursor))) throw new Error("Google Drive pagination cursor did not advance");
      if (fileCursor) fileCursors.add(fileCursor);
    } while (fileCursor);
    const expectedFiles = prepared.seed.drive_items.filter(item => item.user_email === owner.email);
    equal(sorted(files.map(item => item.id)), sorted(expectedFiles.map(item => item.id)), `Drive file IDs for ${owner.source_person_id}`);
    for (const item of expectedFiles) {
      const path = `/drive/v3/files/${encodeURIComponent(item.id)}`;
      const live = await request(path, owner);
      equal({ id: live.id, name: live.name, mime: live.mimeType, parents: live.parents },
        { id: item.id, name: item.name, mime: item.mime_type, parents: item.parent_ids ?? ["root"] }, `Drive metadata ${item.id}`);
      equal(await request(`${path}?alt=media`, owner, true), item.data, `Drive content ${item.id}`);
    }
  }
  return prepared.receipt;
}
