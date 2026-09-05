import { useState } from "react";
import { post } from "../api.js";
import { Button, Notice, PageHead, Panel } from "../components/Primitives.jsx";

const list = (value) => Array.isArray(value) ? value : [];
const text = (...values) => values.find((value) => value !== undefined && value !== null && value !== "") ?? "—";
const shortDate = (value) => value ? new Date(value).toLocaleDateString() : "—";
const money = (amount, currency = "usd") => new Intl.NumberFormat(undefined, {
  style: "currency", currency: String(currency).toUpperCase(), maximumFractionDigits: 0,
}).format(Number(amount ?? 0) / 100);

// The INTERVAL column is a billing period, so only a billing period belongs in
// it. It used to fall back to `price.type` with its underscores swapped for
// spaces, and a listed Stripe price is `type: "recurring"` with no `recurring`
// object at all, so every row in the catalogue read "recurring" -- which says
// the price repeats without saying how often. `stripeOverview` now fills the
// interval in from the provider's own expanded price; a price the API never
// gives an interval for is blank rather than mislabelled.
function priceInterval(price) {
  if (price?.recurring?.interval) return price.recurring.interval;
  return price?.type === "one_time" ? "one time" : "—";
}

function ProviderError({ data, name }) {
  const error = data.providers.errors?.find((entry) => entry.provider === name);
  return error ? <Notice kind="error">{name} did not answer: {error.message}</Notice> : null;
}

function Metrics({ items }) {
  return <div className="product-metrics">{items.map(([label, value, note]) => <div key={label}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>)}</div>;
}

function EmptyProduct({ children }) {
  return <div className="product-empty"><strong>No content yet</strong><span>{children}</span></div>;
}

function RecordDrawer({ title, value, onClose }) {
  if (!value) return null;
  const fields = Object.entries(value).filter(([, field]) => field !== null && field !== undefined && field !== "");
  return <aside className="detail-drawer"><header><strong>{title}</strong><Button kind="small" onClick={onClose}>Close</Button></header><div className="record-fields">{fields.map(([name, field]) => <div key={name}><span>{name.replaceAll("_", " ")}</span>{typeof field === "object" ? <pre>{JSON.stringify(field, null, 2)}</pre> : <strong>{String(field)}</strong>}</div>)}</div></aside>;
}

export function Stripe({ data, actor, onChanged }) {
  const stripe = data.providers.stripe ?? {};
  const customers = list(stripe.customers);
  const products = list(stripe.products);
  const prices = list(stripe.prices);
  const payments = list(stripe.paymentIntents);
  const invoices = list(stripe.invoices);
  const subscriptions = list(stripe.subscriptions);
  const charges = list(stripe.charges);
  const successful = charges.filter((charge) => charge.status === "succeeded" || charge.paid);
  const volume = successful.reduce((sum, charge) => sum + Number(charge.amount ?? 0), 0);
  const [view, setView] = useState("overview");
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);

  async function act(path, input) {
    setBusy(true); setResult(null);
    try {
      const value = await post(path, { ...input, person_id: actor.id });
      setResult(value); await onChanged(false); return value;
    } catch (error) { setResult({ error: error.message }); }
    finally { setBusy(false); }
  }
  async function simulatePayment(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    await act("/api/actions/stripe-payment", { ...form, amount_cents: Math.round(Number(form.amount) * 100) });
  }
  async function createInvoice(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const value = await act("/api/actions/stripe-create-invoice", { ...form, amount_cents: Math.round(Number(form.amount) * 100) });
    if (value?.ok) setShowInvoiceForm(false);
  }
  const payInvoice = (invoice) => act("/api/actions/stripe-pay-invoice", { invoice_id: invoice.id });
  const tabs = [["overview", "Overview"], ["customers", `Customers ${customers.length}`], ["payments", `Payments ${payments.length}`],
    ["invoices", `Invoices ${invoices.length}`], ["subscriptions", `Subscriptions ${subscriptions.length}`], ["products", `Products ${products.length}`]];

  return <><PageHead title="Stripe" subtitle="Customers, recurring billing, invoices, and payments." command="Stripe API"/>
    <ProviderError data={data} name="Stripe"/>
    <nav className="product-tabs">{tabs.map(([id, label]) => <button className={view === id ? "active" : ""} key={id} onClick={() => { setView(id); setSelected(null); }}>{label}</button>)}</nav>
    {result && <div className="section"><Notice kind={result.error ? "error" : ""}>{result.error ?? result.message}</Notice></div>}
    {view === "overview" && <><div className="stripe-actions"><button onClick={() => setView("payments")}><span>PAYMENTS</span><strong>Create a test payment</strong><small>Call the local Stripe PaymentIntents API.</small></button><button onClick={() => setView("invoices")}><span>INVOICES</span><strong>Review {invoices.length} invoices</strong><small>Create, finalize, and pay through the Stripe API.</small></button><button onClick={() => setView("subscriptions")}><span>SUBSCRIPTIONS</span><strong>Manage {subscriptions.length} plans</strong><small>Cancel through the Stripe Subscriptions API.</small></button></div><Metrics items={[["Customers", customers.length], ["Active subscriptions", subscriptions.filter((item) => item.status === "active").length], ["Open invoices", invoices.filter((item) => item.status !== "paid").length], ["Successful volume", money(volume, successful[0]?.currency)]]}/></>}
    {view === "customers" && (customers.length ? <Panel title="Customers"><div className="data-row product-columns table-head"><span>CUSTOMER</span><span>EMAIL</span><span>CREATED</span><span>ACTION</span></div>{customers.map((customer) => <button className="data-row product-columns clickable-row" key={customer.id ?? customer.email} onClick={() => setSelected(customer)}><span><strong>{text(customer.name, customer.email, "Customer")}</strong><small>{customer.id}</small></span><code className="muted truncate">{customer.email ?? "—"}</code><span>{shortDate(customer.created && Number(customer.created) * 1000)}</span><span className="link">View customer →</span></button>)}</Panel> : <EmptyProduct>No Stripe customers are present.</EmptyProduct>)}
    {view === "payments" && <><Panel title="Create a successful test payment" tools={<code>PaymentIntents API</code>}><form className="action-form" onSubmit={simulatePayment}><label>CUSTOMER<select name="customer_id" required>{customers.map((customer) => <option value={customer.id} key={customer.id}>{customer.name} · {customer.email}</option>)}</select></label><label>AMOUNT<input name="amount" type="number" min="0.50" step="0.01" defaultValue="100.00" required/></label><label>DESCRIPTION<input name="description" defaultValue="WorldFixture test payment" required/></label><input type="hidden" name="currency" value="usd"/><Button kind="primary" disabled={busy || !customers.length}>{busy ? "Processing…" : "Create test payment"}</Button></form></Panel>{payments.length > 0 && <div className="section"><Panel title="Payment intents"><div className="data-row product-columns table-head"><span>PAYMENT</span><span>AMOUNT</span><span>CUSTOMER</span><span>STATUS / ACTION</span></div>{payments.slice().reverse().map((payment) => <div className="data-row product-columns" key={payment.id}><button className="row-link" onClick={() => setSelected(payment)}>{payment.id}</button><strong>{money(payment.amount, payment.currency)}</strong><code className="muted truncate">{text(payment.customer, payment.metadata?.worldfixture_customer_id)}</code><span className="inline-actions"><code className={payment.status === "succeeded" ? "green" : "yellow"}>{payment.status}</code>{!["succeeded", "canceled"].includes(payment.status) && <Button kind="small" disabled={busy} onClick={() => act("/api/actions/stripe-cancel-payment", { payment_intent_id: payment.id })}>Cancel</Button>}</span></div>)}</Panel></div>}</>}
    {view === "invoices" && <><Panel title="Invoices" tools={<Button kind="small" onClick={() => setShowInvoiceForm((open) => !open)}>{showInvoiceForm ? "Close" : "Create invoice"}</Button>}>{showInvoiceForm && <form className="action-form invoice-form" onSubmit={createInvoice}><Notice>This action calls the local Stripe Invoices and Invoice Items APIs. Your application reads the same invoice.</Notice><label>CUSTOMER<select name="customer_id" required>{customers.map((customer) => <option value={customer.id} key={customer.id}>{customer.name} · {customer.email}</option>)}</select></label><label>AMOUNT<input name="amount" type="number" min="0.50" step="0.01" defaultValue="100.00" required/></label><label>DUE DATE<input name="due_on" type="date" defaultValue={new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)} required/></label><label>DESCRIPTION<input name="description" defaultValue="Service invoice" required/></label><input type="hidden" name="currency" value="usd"/><Button kind="primary" disabled={busy || !customers.length}>{busy ? "Creating…" : "Create invoice"}</Button></form>}<div className="data-row product-columns table-head"><span>INVOICE</span><span>AMOUNT</span><span>DUE</span><span>STATUS / ACTION</span></div>{invoices.slice().reverse().map((invoice) => <div className="data-row product-columns" key={invoice.id}><button className="row-link" onClick={() => setSelected(invoice)}><strong>{invoice.description}</strong><small>#{invoice.number}</small></button><strong>{money(invoice.amount_cents, invoice.currency)}</strong><span>{invoice.due_on}</span><span className="inline-actions"><code className={invoice.status === "paid" ? "green" : "yellow"}>{invoice.status}</code>{invoice.status === "open" && <Button kind="small" disabled={busy} onClick={() => payInvoice(invoice)}>Pay</Button>}</span></div>)}</Panel></>}
    {view === "subscriptions" && <Panel title="Subscriptions from the Stripe API"><div className="data-row product-columns table-head"><span>SUBSCRIPTION</span><span>PLAN</span><span>MONTHLY</span><span>STATUS / ACTION</span></div>{subscriptions.map((subscription) => <div className="data-row product-columns" key={subscription.id}><button className="row-link" onClick={() => setSelected(subscription)}><strong>{subscription.customer}</strong><small>{subscription.id}</small></button><span>{subscription.product}</span><strong>{money(subscription.amount_cents, subscription.currency)}</strong><span className="inline-actions"><code className={subscription.status === "active" ? "green" : "muted"}>{subscription.status}</code>{subscription.status === "active" && <Button kind="small" disabled={busy} onClick={() => window.confirm(`Cancel ${subscription.customer}'s subscription through the local Stripe API?`) && act("/api/actions/stripe-cancel-subscription", { subscription_id: subscription.id })}>Cancel</Button>}</span></div>)}</Panel>}
    {view === "products" && <Panel title="Product catalog"><div className="data-row product-columns table-head"><span>PRODUCT</span><span>PRICE</span><span>INTERVAL</span><span>STATE</span></div>{products.map((product) => { const price = prices.find((entry) => entry.product === product.id || entry.product?.id === product.id || entry.product_name === product.name); return <div className="data-row product-columns" key={product.id ?? product.name}><span><strong>{product.name}</strong><small>{product.description}</small></span><code>{price ? money(price.unit_amount, price.currency) : "—"}</code><span>{priceInterval(price)}</span><code className={product.active === false ? "yellow" : "green"}>{product.active === false ? "archived" : "active"}</code></div>; })}</Panel>}
    <RecordDrawer title="Stripe record" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Linear({ data }) {
  const linear = data.providers.linear ?? {};
  const issues = list(linear.issues);
  const states = issues.reduce((counts, issue) => ({ ...counts, [issue.state ?? "Unknown"]: (counts[issue.state ?? "Unknown"] ?? 0) + 1 }), {});
  const active = issues.filter((issue) => !["Done", "Canceled", "Cancelled"].includes(issue.state));
  const [status, setStatus] = useState("active");
  const [selected, setSelected] = useState(null);
  const visible = status === "all" ? issues : status === "active" ? active : issues.filter((issue) => issue.state === status);
  return <><PageHead title="Linear" subtitle="Issues and project work for this world." command={linear.organization?.name ?? "Linear API"}/>
    <ProviderError data={data} name="Linear"/>
    <Metrics items={[["Issues", issues.length], ["In progress", states["In Progress"] ?? 0], ["Backlog", states.Backlog ?? 0], ["Teams", list(linear.teams).length]]}/>
    {issues.length ? <div className="section"><Panel title={`Issues · ${visible.length}`} tools={<select className="compact-select" value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Active</option><option value="all">All issues</option>{Object.keys(states).map((state) => <option key={state} value={state}>{state}</option>)}</select>}><div className="data-row linear-columns table-head"><span>ISSUE</span><span>STATUS</span><span>ASSIGNEE</span><span>LABELS</span></div>{visible.slice(0, 100).map((issue, index) => <button className="data-row linear-columns clickable-row" key={issue.id ?? issue.worldfixture_task_id ?? index} onClick={() => setSelected(issue)}><span><strong>{issue.title}</strong><small>{text(issue.identifier, issue.worldfixture_task_id)}</small></span><span className="state-pill">{issue.state ?? "Unknown"}</span><code className="muted truncate">{issue.assignee ?? "Unassigned"}</code><span className="tag-list">{list(issue.labels).slice(0, 3).map((label) => <code key={label}>{label}</code>)}</span></button>)}</Panel></div> : <EmptyProduct>No Linear issues are present.</EmptyProduct>}
    <RecordDrawer title="Linear issue" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Okta({ data }) {
  const okta = data.providers.okta ?? {};
  const users = list(okta.users);
  const groups = list(okta.groups);
  const applications = list(okta.applications);
  const [view, setView] = useState("people");
  const [selected, setSelected] = useState(null);
  return <><PageHead title="Okta" subtitle="Directory people, groups, and applications." command="Okta Management API"/><ProviderError data={data} name="Okta"/>
    <Metrics items={[["People", users.length], ["Active", users.filter((user) => !user.status || user.status === "ACTIVE").length], ["Groups", groups.length], ["Applications", applications.length]]}/>
    <nav className="product-tabs section">{[["people", "People"], ["groups", "Groups"], ["applications", "Applications"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}</nav>
    {view === "people" && (users.length ? <Panel title="People"><div className="data-row identity-columns table-head"><span>PERSON</span><span>LOGIN</span><span>STATUS</span></div>{users.slice(0, 100).map((user) => <button className="data-row identity-columns clickable-row" key={user.id ?? user.profile?.login} onClick={() => setSelected(user)}><span><strong>{text(user.profile?.displayName, [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" "), user.profile?.login)}</strong><small>{user.id}</small></span><code className="muted truncate">{text(user.profile?.login, user.profile?.email)}</code><code className={user.status === "SUSPENDED" ? "yellow" : "green"}>{user.status ?? "ACTIVE"}</code></button>)}</Panel> : <EmptyProduct>No Okta users are present.</EmptyProduct>)}
    {view === "groups" && <Panel title="Groups"><div className="card-grid">{groups.map((group) => <button className="product-card" key={group.id ?? group.profile?.name} onClick={() => setSelected(group)}><strong>{text(group.profile?.name, group.name)}</strong><p>{text(group.profile?.description, group.description, "No description")}</p><code>{group.id ?? group.okta_id}</code></button>)}</div></Panel>}
    {view === "applications" && <Panel title="Applications"><div className="card-grid">{applications.map((application) => <button className="product-card" key={application.id} onClick={() => setSelected(application)}><strong>{text(application.label, application.name)}</strong><p>{application.signOnMode ?? "Application"}</p><code>{application.status ?? "ACTIVE"}</code></button>)}</div></Panel>}
    <RecordDrawer title="Okta record" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Clerk({ data }) {
  const clerk = data.providers.clerk ?? {};
  const users = list(clerk.users);
  const organizations = list(clerk.organizations);
  const sessions = list(clerk.sessions);
  const [view, setView] = useState("users");
  const [selected, setSelected] = useState(null);
  const nameOf = (user) => text([user.first_name, user.last_name].filter(Boolean).join(" "), user.username, user.id);
  const emailOf = (user) => text(user.email_addresses?.[0]?.email_address, user.primary_email_address?.email_address);
  return <><PageHead title="Clerk" subtitle="Application users, organizations, and sessions." command="Clerk Backend API"/><ProviderError data={data} name="Clerk"/>
    <Metrics items={[["Users", users.length], ["Organizations", organizations.length], ["Sessions", sessions.length], ["Locked", users.filter((user) => user.locked).length]]}/>
    <nav className="product-tabs section">{[["users", "Users"], ["organizations", "Organizations"], ["sessions", "Sessions"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}</nav>
    {view === "organizations" && <Panel title="Organizations"><div className="card-grid">{organizations.map((organization) => <button className="product-card" key={organization.id} onClick={() => setSelected(organization)}><strong>{organization.name}</strong><p>{organization.members_count ?? organization.membersCount ?? 0} members</p><code>{organization.slug ?? organization.id}</code></button>)}</div></Panel>}
    {view === "users" && (users.length ? <Panel title="Users"><div className="data-row identity-columns table-head"><span>USER</span><span>EMAIL</span><span>STATUS</span></div>{users.slice(0, 100).map((user) => <button className="data-row identity-columns clickable-row" key={user.id} onClick={() => setSelected(user)}><span><strong>{nameOf(user)}</strong><small>{user.id}</small></span><code className="muted truncate">{emailOf(user)}</code><code className={user.banned || user.locked ? "yellow" : "green"}>{user.banned ? "banned" : user.locked ? "locked" : "active"}</code></button>)}</Panel> : <EmptyProduct>No Clerk users are present.</EmptyProduct>)}
    {view === "sessions" && <Panel title="Sessions"><div className="data-row identity-columns table-head"><span>SESSION</span><span>USER</span><span>STATUS</span></div>{sessions.map((session) => <button className="data-row identity-columns clickable-row" key={session.id} onClick={() => setSelected(session)}><code>{session.id}</code><code className="muted">{session.user_id}</code><code className={session.status === "active" ? "green" : "muted"}>{session.status}</code></button>)}</Panel>}
    <RecordDrawer title="Clerk record" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Twilio({ data }) {
  const twilio = data.providers.twilio ?? {};
  const numbers = list(twilio.phone_numbers);
  const messaging = list(twilio.messaging_services);
  const verify = list(twilio.verify_services);
  const [selected, setSelected] = useState(null);
  return <><PageHead title="Twilio" subtitle="Phone numbers, messaging, and verification services." command={twilio.account?.friendly_name ?? "Twilio API"}/>
    <ProviderError data={data} name="Twilio"/>
    <Metrics items={[["Phone numbers", numbers.length], ["Messaging services", messaging.length], ["Verify services", verify.length], ["Account", twilio.account?.sid?.slice(-6) ?? "—"]]}/>
    <div className="section"><Panel title="Communications"><div className="card-grid">{numbers.map((number) => <button className="product-card" key={number.phone_number} onClick={() => setSelected(number)}><span className="eyebrow">PHONE NUMBER</span><strong>{number.phone_number}</strong><p>{number.friendly_name}</p></button>)}{messaging.map((service) => <button className="product-card" key={service.sid ?? service.friendly_name} onClick={() => setSelected(service)}><span className="eyebrow">MESSAGING</span><strong>{service.friendly_name}</strong><p>{list(service.phone_numbers).join(", ")}</p></button>)}{verify.map((service) => <button className="product-card" key={service.sid ?? service.friendly_name} onClick={() => setSelected(service)}><span className="eyebrow">VERIFY</span><strong>{service.friendly_name}</strong><p>Default channel: {service.default_channel}</p></button>)}</div></Panel></div>
    <RecordDrawer title="Twilio resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Resend({ data }) {
  const resend = data.providers.resend ?? {};
  const emails = list(resend.emails);
  const domains = list(resend.domains);
  const audiences = list(resend.audiences);
  const contacts = list(resend.contactGroups).reduce((sum, group) => sum + list(group.contacts).length, 0);
  const [view, setView] = useState(emails.length ? "emails" : "domains");
  const [selected, setSelected] = useState(null);
  return <><PageHead title="Resend" subtitle="Email delivery, sending domains, and audiences." command="Resend API"/><ProviderError data={data} name="Resend"/>
    <Metrics items={[["Emails", emails.length], ["Delivered", emails.filter((email) => email.status === "delivered").length], ["Domains", domains.length], ["Contacts", contacts]]}/>
    <nav className="product-tabs section">{[["emails", "Email activity"], ["domains", "Domains"], ["audiences", "Audiences"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}</nav>
    {view === "emails" && emails.length > 0 && <Panel title="Email activity"><div className="data-row product-columns table-head"><span>SUBJECT</span><span>TO</span><span>DATE</span><span>STATUS</span></div>{emails.slice(-50).reverse().map((email) => <button className="data-row product-columns clickable-row" key={email.id} onClick={() => setSelected(email)}><span><strong>{email.subject ?? "No subject"}</strong><small>{email.from}</small></span><code className="muted truncate">{list(email.to).join(", ") || email.to}</code><span>{shortDate(email.created_at)}</span><code className={email.status === "failed" ? "yellow" : "green"}>{email.status ?? "sent"}</code></button>)}</Panel>}
    {view === "domains" && <Panel title="Domains"><div className="card-grid">{domains.map((domain) => <button className="product-card" key={domain.id ?? domain.name} onClick={() => setSelected(domain)}><strong>{domain.name}</strong><p>{domain.region ?? "automatic region"}</p><code className={domain.status === "failed" ? "yellow" : "green"}>{domain.status ?? "verified"}</code></button>)}</div></Panel>}
    {view === "audiences" && <Panel title="Audiences"><div className="card-grid">{list(resend.contactGroups).map((group) => <button className="product-card" key={group.audience.id} onClick={() => setSelected(group)}><strong>{group.audience.name}</strong><p>{group.contacts.length} contacts</p><code>{group.audience.id}</code></button>)}</div></Panel>}
    {!emails.length && !domains.length && !audiences.length && <EmptyProduct>No Resend content is present.</EmptyProduct>}
    <RecordDrawer title="Resend resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Vercel({ data }) {
  const vercel = data.providers.vercel ?? {};
  const projects = list(vercel.projects);
  const deployments = list(vercel.deployments);
  const [selected, setSelected] = useState(null);
  return <><PageHead title="Vercel" subtitle="Projects and deployment state for this world." command="Vercel REST API"/><ProviderError data={data} name="Vercel"/>
    <Metrics items={[["Projects", projects.length], ["Deployments", deployments.length], ["Ready", deployments.filter((item) => item.readyState === "READY" || item.state === "READY").length], ["Teams", list(vercel.teams).length]]}/>
    {projects.length ? <div className="section"><Panel title="Projects"><div className="card-grid">{projects.map((project) => { const latest = deployments.find((item) => item.projectId === project.id || item.name === project.name); return <button className="product-card" key={project.id ?? project.name} onClick={() => setSelected({ project, latestDeployment: latest })}><span className="eyebrow">{project.framework ?? "project"}</span><strong>{project.name}</strong><p>{latest ? text(latest.url, latest.name) : "No deployment yet"}</p><code className={latest && (latest.readyState === "ERROR" || latest.state === "ERROR") ? "yellow" : "green"}>{latest ? text(latest.readyState, latest.state) : "configured"}</code></button>; })}</div></Panel></div> : <EmptyProduct>No Vercel projects are present.</EmptyProduct>}
    <RecordDrawer title="Vercel project" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

// IDLE IS ATLAS' HEALTHY STATE, NOT A WARNING. The badge was
// `stateName === "IDLE" ? "yellow" : "green"`, which is the comparison the
// wrong way round: IDLE means the cluster is up and doing no maintenance, and
// the live emulator reports it for every cluster it serves. So a healthy
// cluster wore a warning badge forever, and CREATING or UPDATING -- the states
// that are actually worth a second look -- wore the healthy one.
const CLUSTER_HEALTHY = ["IDLE", "AVAILABLE"];

function clusterHealthy(cluster) {
  return CLUSTER_HEALTHY.includes(cluster.stateName ?? "AVAILABLE");
}

// A collection arrives from Atlas as `{collectionName, databaseName}`, and
// `mongoAtlasOverview` normalises it to a plain name. Both shapes are read here
// so a record that reached the browser unnormalised still names itself.
function collectionName(entry) {
  return typeof entry === "string" ? entry : (entry.collectionName ?? entry.name);
}

export function MongoAtlas({ data }) {
  const atlas = data.providers.mongoatlas ?? {};
  const details = list(atlas.projectDetails);
  const clusters = details.flatMap((entry) => list(entry.clusters));
  const databases = details.flatMap((entry) => list(entry.databases));
  const users = details.flatMap((entry) => list(entry.databaseUsers));
  const [selected, setSelected] = useState(null);
  return <><PageHead title="MongoDB Atlas" subtitle="Projects, clusters, data, and database access." command="Atlas Admin API v2"/><ProviderError data={data} name="MongoDB Atlas"/>
    <Metrics items={[["Projects", list(atlas.projects).length], ["Clusters", clusters.length], ["Databases", databases.length], ["Database users", users.length]]}/>
    {clusters.length ? <div className="section"><Panel title="Clusters"><div className="data-row atlas-columns table-head"><span>CLUSTER</span><span>VERSION</span><span>REGION</span><span>SIZE</span><span>STATE</span></div>{clusters.map((cluster) => <button className="data-row atlas-columns clickable-row" key={cluster.id ?? cluster.name} onClick={() => setSelected(cluster)}><span><strong>{cluster.name}</strong><small>{text(cluster.clusterType, cluster.providerSettings?.providerName)}</small></span><code>{text(cluster.mongoDBVersion, cluster.mongoDBMajorVersion, cluster.mongodb_version)}</code><code className="muted">{text(cluster.providerSettings?.regionName, cluster.region)}</code><span>{text(cluster.providerSettings?.instanceSizeName, cluster.instance_size)}</span><code className={clusterHealthy(cluster) ? "green" : "yellow"}>{text(cluster.stateName, "AVAILABLE")}</code></button>)}</Panel></div> : <EmptyProduct>No Atlas clusters are present.</EmptyProduct>}
    {databases.length > 0 && <div className="section"><Panel title="Data explorer"><div className="card-grid">{databases.map((database) => <button className="product-card" key={`${database.cluster}-${database.name ?? database.databaseName}`} onClick={() => setSelected(database)}><span className="eyebrow">{database.cluster}</span><strong>{text(database.name, database.databaseName)}</strong><p>{list(database.collections).map(collectionName).filter(Boolean).join(" · ") || "No collections"}</p></button>)}</div></Panel></div>}
    <RecordDrawer title="MongoDB Atlas resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}
