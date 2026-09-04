const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "—").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const calls = [];
let state;
let selected;
let activeView = "accounts";
let providerData;

async function api(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`);
  return value;
}

function log(text) {
  calls.unshift(`${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${text}`);
  $("#calls").innerHTML = calls.slice(0, 4).map((entry) => `<code>${escapeHtml(entry)}</code>`).join("");
}

function field(name, label, value = "", type = "input") {
  if (type === "textarea") return `<label>${escapeHtml(label)}<textarea name="${name}" required>${escapeHtml(value)}</textarea></label>`;
  return `<label>${escapeHtml(label)}<input name="${name}" value="${escapeHtml(value)}" required></label>`;
}
function select(name, label, values) {
  return `<label>${escapeHtml(label)}<select name="${name}">${values.map((value) => `<option>${escapeHtml(value)}</option>`).join("")}</select></label>`;
}
function resource(title, meta, text) {
  return `<article class="resource"><div><b>${escapeHtml(title)}</b><small>${escapeHtml(meta)}</small></div><p>${escapeHtml(text)}</p></article>`;
}
function messageHeaders(message) {
  return Object.fromEntries((message.payload?.headers ?? []).map((entry) => [entry.name.toLowerCase(), entry.value]));
}

function choose(account) {
  selected = account;
  document.querySelectorAll(".account").forEach((button) => button.classList.toggle("active", button.dataset.id === account.id));
  $("#account-name").textContent = account.name;
  $("#account-note").textContent = `${account.email} · ${account.note}`;
  $("#metrics").innerHTML = [["GMAIL THREADS", account.mail], ["GITHUB ISSUES", account.issues], ["HEALTH", account.health], ["PROVIDER", "Stripe"]].map(([label, value]) => `<div class="metric"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b><span>read from this instance</span></div>`).join("");
  $("#assemble").disabled = false;
  $("#brief").innerHTML = "";
  $("#empty").classList.remove("hidden");
  $("#publish-row").classList.add("hidden");
}

async function loadAccounts() {
  state = await api("/api/state");
  $("#status").textContent = "provider APIs connected";
  $("#account-count").textContent = state.accounts.length;
  $("#reset-proof").textContent = state.resetProof;
  $("#connections").innerHTML = state.connections.map((item) => `<div class="connection"><span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.mode)} · ${escapeHtml(item.detail)}</small></span>${["slack", "github", "google"].includes(item.id) ? `<a href="/auth/${item.id}/start">${item.ready ? "Use OAuth" : "Connect"}</a>` : `<strong>Ready</strong>`}</div>`).join("");
  $("#accounts").innerHTML = state.accounts.map((account) => `<button class="account" data-id="${escapeHtml(account.id)}"><em>${escapeHtml(account.health)}</em><b>${escapeHtml(account.name)}</b><small>${escapeHtml(account.mail)} mail · ${escapeHtml(account.issues)} issues</small></button>`).join("");
  document.querySelectorAll(".account").forEach((button) => button.onclick = () => choose(state.accounts.find((account) => account.id === button.dataset.id)));
  choose(state.accounts.find((account) => account.id === selected?.id) ?? state.accounts.find((account) => account.name === "Lumen Labs") ?? state.accounts[0]);
  log("Slack, GitHub, Gmail, Stripe, IMAP, SMTP, and S3 are connected");
}

function renderProvider(view, data) {
  const titles = { slack: ["Slack", "Channels and messages through the Slack Web API"], github: ["GitHub", "Repositories and issues through the GitHub API"], gmail: ["Gmail", "Messages through the Google Gmail API"], mail: ["Mail", "A separate mailbox through SMTP and IMAP"], files: ["Files", "Objects through the SeaweedFS S3 API"] };
  const [title, note] = titles[view];
  $("#provider-title").textContent = title;
  $("#provider-note").textContent = note;
  let items = [];
  let metrics = [];
  let actionTitle = "Create";
  let fields = "";
  if (view === "slack") {
    items = [...data.messages].sort((left, right) => Number(right.ts) - Number(left.ts)).map((message) => resource(`#${message.channel}`, message.ts, message.text));
    metrics = [["CHANNELS", data.channels.length], ["MESSAGES", data.messages.length], ["PROTOCOL", "Slack API"]];
    actionTitle = "Post a message";
    fields = select("channel", "Channel", data.channels.map((channel) => channel.name)) + field("text", "Message", "Relay Digest follow-up", "textarea");
  } else if (view === "github") {
    items = data.issues.map((issue) => resource(`${issue.repository} #${issue.number}`, issue.state, `${issue.title} — ${issue.body}`));
    metrics = [["REPOSITORIES", data.repositories.length], ["ISSUES", data.issues.length], ["PROTOCOL", "GitHub API"]];
    actionTitle = "Create an issue";
    fields = select("repository", "Repository", data.repositories.map((repo) => repo.full_name)) + field("title", "Title", "Account follow-up") + field("text", "Description", "Created by Relay Digest through the GitHub API.", "textarea");
  } else if (view === "gmail") {
    items = [...data].sort((left, right) => Number(right.internalDate) - Number(left.internalDate)).map((message) => { const headers = messageHeaders(message); return resource(headers.subject, headers.from, message.snippet); });
    metrics = [["MESSAGES", data.length], ["ACCOUNT", "Maya"], ["PROTOCOL", "Gmail API"]];
    actionTitle = "Send with Gmail";
    fields = field("to", "To", "jon@northstar-relay.worldfixture.test") + field("subject", "Subject", "Relay Digest follow-up") + field("text", "Message", "Sent through the Gmail API.", "textarea");
  } else if (view === "mail") {
    items = [...data.messages].sort((left, right) => right.seq - left.seq).map((message) => resource(message.headers.subject, message.headers.from, message.headers.date));
    metrics = [["INBOX", data.exists], ["UNREAD", data.unseen ? "yes" : "no"], ["PROTOCOL", "IMAP + SMTP"]];
    actionTitle = "Send through SMTP";
    fields = field("to", "To", data.address) + field("subject", "Subject", "Relay Digest mail check") + field("text", "Message", "Sent over SMTP and read back over IMAP.", "textarea");
  } else {
    items = data.flatMap((bucket) => bucket.keys.length ? bucket.keys.map((key) => resource(key, `s3://${bucket.name}`, "Accepted object")) : [resource(bucket.name, "S3 bucket", "No objects")]);
    metrics = [["BUCKETS", data.length], ["OBJECTS", data.reduce((sum, bucket) => sum + bucket.keys.length, 0)], ["PROTOCOL", "S3"]];
    actionTitle = "Put an object";
    fields = select("bucket", "Bucket", data.map((bucket) => bucket.name)) + field("key", "Key", `relay-digest/note-${Date.now()}.json`) + field("text", "Contents", "Created by Relay Digest through S3.", "textarea");
  }
  $("#provider-summary").innerHTML = metrics.map(([label, value]) => `<div class="metric"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b><span>live provider state</span></div>`).join("");
  $("#provider-list").innerHTML = items.length
    ? `${items.slice(0, 20).join("")}${items.length > 20 ? `<div class="list-limit">Showing the 20 newest items. ${items.length - 20} older items are hidden.</div>` : ""}`
    : `<div class="empty">This provider returned no resources.</div>`;
  $("#action-title").textContent = actionTitle;
  $("#action-fields").innerHTML = fields;
  $("#action-result").textContent = "";
}

async function loadProvider(view) {
  $("#provider-list").innerHTML = `<div class="empty">Loading ${escapeHtml(view)} through its public protocol…</div>`;
  providerData = await api(`/api/${view}`);
  renderProvider(view, providerData);
  log(`${view} provider read accepted`);
}

async function show(view) {
  activeView = view;
  document.querySelectorAll("nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelector('[data-panel="accounts"]').classList.toggle("active", view === "accounts");
  document.querySelector('[data-panel="provider"]').classList.toggle("active", view !== "accounts");
  $("#account-nav").classList.toggle("hidden", view !== "accounts");
  if (view === "accounts") await loadAccounts(); else await loadProvider(view);
}

$("#assemble").onclick = async () => {
  $("#assemble").disabled = true;
  $("#assemble").textContent = "Reading providers…";
  try {
    const result = await api("/api/brief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: selected.id }) });
    $("#empty").classList.add("hidden");
    $("#brief").innerHTML = result.sections.map((section) => `<article class="section"><header><b>${escapeHtml(section.title)}</b><span>${escapeHtml(section.source)}</span></header><div>${escapeHtml(section.text)}${section.warning ? `<p class="warning"><b>CAREFUL</b> ${escapeHtml(section.warning)}</p>` : ""}<br><code>evidence · ${escapeHtml(section.evidence)}</code></div></article>`).join("");
    $("#publish-row").classList.remove("hidden");
    log(`${result.sections.length} supported statements assembled from provider responses`);
  } catch (error) { alert(error.message); }
  finally { $("#assemble").disabled = false; $("#assemble").textContent = "Reassemble brief"; }
};

$("#publish").onclick = async () => {
  if (!confirm(`Send the ${selected.name} brief by Gmail, write it to S3, and post its location to Slack?`)) return;
  $("#publish").disabled = true;
  try {
    const result = await api("/api/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: selected.id }) });
    $("#publish").textContent = "Sent";
    log(`${result.phases.join(" → ")} · ${result.marker}`);
    await loadAccounts();
  } catch (error) { alert(error.message); $("#publish").disabled = false; }
};

$("#provider-action").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const input = Object.fromEntries(new FormData(event.currentTarget));
  button.disabled = true;
  try {
    const result = await api(`/api/${activeView}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    $("#action-result").textContent = `Accepted · ${JSON.stringify(result).slice(0, 220)}`;
    log(`${activeView} mutation accepted`);
    await loadProvider(activeView);
  } catch (error) { $("#action-result").textContent = error.message; }
  finally { button.disabled = false; }
};
$("#refresh-provider").onclick = () => loadProvider(activeView);
document.querySelectorAll("nav [data-view]").forEach((button) => button.onclick = () => show(button.dataset.view).catch((error) => alert(error.message)));

loadAccounts().then(() => {
  const requested = location.hash.slice(1);
  const view = requested === "google" ? "gmail" : requested;
  if (["slack", "github", "gmail"].includes(view)) show(view);
}).catch((error) => { $("#status").textContent = "disconnected"; $("#empty").innerHTML = `<b>WorldFixture is not reachable</b><p>${escapeHtml(error.message)}</p>`; });
