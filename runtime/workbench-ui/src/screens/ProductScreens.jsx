import { useState } from "react";
import { post } from "../api.js";
import { Button, Notice, PageHead, Panel } from "../components/Primitives.jsx";
import { collectionComplete, collectionCount, currencyCode, formatMinorUnits, intervalLabel,
  linearStateKey, linearStates, pageRows, parseMinorUnits, paymentSummary, recurringSummary,
  subscriptionAmounts } from "../model/product-metrics.mjs";

const list = (value) => Array.isArray(value) ? value : [];
const text = (...values) => values.find((value) => value !== undefined && value !== null && value !== "") ?? "—";
const shortDate = (value) => value ? new Date(value).toLocaleDateString() : "—";
const money = formatMinorUnits;

function ProviderError({ data, name }) {
  const key = name === "MongoDB Atlas" ? "mongoatlas" : name.toLowerCase();
  const error = data.providers?.errors?.find(entry => entry.provider === name || entry.provider?.toLowerCase() === key);
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

function CollectionNotice({ provider, name }) {
  if (collectionComplete(provider, name)) return null;
  const state = provider.collectionStatus?.[name];
  return <Notice kind="error">{name}: {state?.error ?? (state?.status === "unavailable" ? "This collection is not available." : "The provider read is incomplete.")} Counts and totals are unknown.</Notice>;
}

function PagedRows({ rows, children }) {
  const [page, setPage] = useState(0);
  const current = pageRows(rows, page);
  return <>{children(current.rows)}{current.pages > 1 && <div className="inline-actions section"><Button kind="small" disabled={current.page === 0} onClick={() => setPage(current.page - 1)}>Previous</Button><span>{current.first}–{current.last} of {current.total}</span><Button kind="small" disabled={current.page + 1 === current.pages} onClick={() => setPage(current.page + 1)}>Next</Button></div>}</>;
}

function CollectionRows({ provider, name, rows = list(provider[name]), children }) {
  return <><CollectionNotice provider={provider} name={name}/>{rows.length ? <PagedRows rows={rows}>{children}</PagedRows> : collectionComplete(provider, name) && <EmptyProduct>No records are present.</EmptyProduct>}</>;
}

function CurrencyField({ currencies }) {
  return <label>CURRENCY<input name="currency" placeholder="Three-letter code" pattern="[A-Za-z]{3}" maxLength={3} defaultValue={currencies.length === 1 ? currencies[0] : ""} required/>{currencies.length > 0 && <small>Present currencies: {currencies.join(", ")}</small>}</label>;
}

export function Stripe({ data, actor, onChanged, onAction }) {
  const stripe = data.providers.stripe ?? {};
  const customers = list(stripe.customers), products = list(stripe.products), prices = list(stripe.prices);
  const payments = list(stripe.paymentIntents), invoices = list(stripe.invoices);
  const volume = paymentSummary(stripe), recurring = recurringSummary(stripe);
  const currencies = [...new Set([...prices, ...payments, ...invoices, ...list(stripe.charges)].map(row => row.currency?.toUpperCase()).filter(Boolean))].sort();
  const count = (name, predicate) => collectionCount(stripe, name, predicate) ?? "Unknown";
  const [view, setView] = useState("overview"), [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false), [result, setResult] = useState(null), [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const surface = data.surfaces?.find(row => row.id === "stripe")?.id ?? "stripe";
  async function act(path, input, target) {
    setBusy(true); setResult(null);
    try {
      const value = await post(path, { ...input, person_id: actor?.id });
      setResult(value);
      if (value?.ok === true) onAction?.({ type: "write", surface, target, success: true, ...(value.event?.id ? { eventId: value.event.id } : {}) });
      await onChanged(); return value;
    } catch (error) { setResult({ error: error.message }); }
    finally { setBusy(false); }
  }
  async function submitAmount(event, invoice) {
    event.preventDefault();
    try {
      const form = Object.fromEntries(new FormData(event.currentTarget));
      const value = await act(invoice ? "/api/actions/stripe-create-invoice" : "/api/actions/stripe-payment", {
        ...form, currency: currencyCode(form.currency).toLowerCase(), amount_cents: parseMinorUnits(form.amount, form.currency),
      }, invoice ? "invoices" : "payments");
      if (invoice && value?.ok) setShowInvoiceForm(false);
    } catch (error) { setResult({ error: error.message }); }
  }
  async function refresh() {
    setBusy(true);
    try {
      const fresh = await onChanged();
      const collection = { overview: "charges", payments: "paymentIntents" }[view] ?? view;
      if (collectionComplete(fresh?.providers?.stripe, collection)) onAction?.({ type: "read", surface, target: collection, success: true });
    } finally { setBusy(false); }
  }
  const tabs = [["overview", "Overview"], ["customers", `Customers ${count("customers")}`], ["payments", `Payments ${count("paymentIntents")}`],
    ["invoices", `Invoices ${count("invoices")}`], ["subscriptions", `Subscriptions ${count("subscriptions")}`], ["products", `Products ${count("products")}`], ["refunds", `Refunds ${count("refunds")}`]];
  const customerName = id => typeof id === "object" ? text(id.name, id.email, id.id) : text(customers.find(row => row.id === id)?.name, id);
  return <><PageHead title="Stripe" subtitle="Customers, recurring billing, invoices, and payments." command="Stripe API"/>
    <ProviderError data={data} name="Stripe"/>
    <nav className="product-tabs">{tabs.map(([id, label]) => <button className={view === id ? "active" : ""} key={id} onClick={() => { setView(id); setSelected(null); }}>{label}</button>)}<Button kind="small" disabled={busy} onClick={refresh}>Refresh</Button></nav>
    {result && <div className="section"><Notice kind={result.error ? "error" : ""}>{result.error ?? result.message ?? "The provider accepted the action."}</Notice></div>}
    {view === "overview" && <>
      <Metrics items={[["Customers", count("customers")], ["Active subscriptions", count("subscriptions", row => row.status === "active")], ["Open invoices", count("invoices", row => row.status === "open")], ["Payment intents", count("paymentIntents")]]}/>
      <div className="section"><Panel title="Successful payments and refunds" tools={<span>Gross less refunds · before fees</span>}>
        <CollectionNotice provider={stripe} name="charges"/><CollectionNotice provider={stripe} name="refunds"/>
        {(!volume.gross.known || !volume.refunds.known) && <Notice>Unknown totals: {volume.gross.error ?? volume.refunds.error}</Notice>}
        {volume.rows.length > 0 && <><div className="data-row product-columns table-head"><span>CURRENCY</span><span>GROSS PAYMENTS</span><span>REFUNDS</span><span>NET PAYMENTS</span></div>{volume.rows.map(row => <div className="data-row product-columns" key={row.currency}><strong>{row.currency}</strong><span>{money(row.gross, row.currency)}</span><span>{money(row.refunds, row.currency)}</span><strong>{money(row.net, row.currency)}</strong></div>)}</>}
        {volume.gross.known && volume.refunds.known && !volume.rows.length && <EmptyProduct>No successful payments or refunds are present.</EmptyProduct>}
      </Panel></div>
      <div className="section"><Panel title="Active recurring amounts" tools={<span>Fixed prices × quantity per billing interval</span>}>
        {!recurring.known ? <Notice>Recurring amounts are unknown: {recurring.error}</Notice> : recurring.rows.length ? <><div className="data-row product-columns table-head"><span>CURRENCY</span><span>BILLING INTERVAL</span><span>AMOUNT</span><span>SUBSCRIPTIONS</span></div>{recurring.rows.map(row => <div className="data-row product-columns" key={`${row.currency}/${row.interval}/${row.interval_count}`}><strong>{row.currency}</strong><span>{intervalLabel(row)}</span><strong>{money(row.amount, row.currency)}</strong><span>{row.subscriptions}</span></div>)}</> : <EmptyProduct>No active recurring amounts are present.</EmptyProduct>}
      </Panel></div>
    </>}
    {view === "customers" && <Panel title="Customers"><div className="data-row product-columns table-head"><span>CUSTOMER</span><span>EMAIL</span><span>CREATED</span><span>ACTION</span></div><CollectionRows provider={stripe} name="customers">{rows => rows.map(customer => <button className="data-row product-columns clickable-row" key={customer.id} onClick={() => setSelected(customer)}><span><strong>{text(customer.name, customer.email, "Customer")}</strong><small>{customer.id}</small></span><code className="muted truncate">{customer.email ?? "—"}</code><span>{shortDate(customer.created && Number(customer.created) * 1000)}</span><span className="link">View customer →</span></button>)}</CollectionRows></Panel>}
    {view === "payments" && <>
      <Panel title="Create a successful test payment"><form className="action-form" onSubmit={event => submitAmount(event, false)}><label>CUSTOMER<select name="customer_id" required><option value="">Select customer</option>{customers.map(customer => <option value={customer.id} key={customer.id}>{text(customer.name, customer.email, customer.id)}</option>)}</select></label><label>AMOUNT<input name="amount" inputMode="decimal" placeholder="Amount in selected currency" required/></label><CurrencyField currencies={currencies}/><label>DESCRIPTION<input name="description" required/></label><Button kind="primary" disabled={busy || !actor || !collectionComplete(stripe, "customers") || !customers.length}>{busy ? "Processing…" : "Create test payment"}</Button></form></Panel>
      <div className="section"><Panel title="Payment intents"><div className="data-row product-columns table-head"><span>PAYMENT</span><span>AMOUNT</span><span>CUSTOMER</span><span>STATUS / ACTION</span></div><CollectionRows provider={stripe} name="paymentIntents" rows={[...payments].reverse()}>{rows => rows.map(payment => <div className="data-row product-columns" key={payment.id}><button className="row-link" onClick={() => setSelected(payment)}>{payment.id}</button><strong>{money(payment.amount, payment.currency)}</strong><span>{customerName(payment.customer)}</span><span className="inline-actions"><code>{payment.status ?? "Unknown"}</code>{payment.status && !["succeeded", "canceled"].includes(payment.status) && <Button kind="small" disabled={busy || !actor} onClick={() => act("/api/actions/stripe-cancel-payment", { payment_intent_id: payment.id }, "payments")}>Cancel</Button>}</span></div>)}</CollectionRows></Panel></div>
    </>}
    {view === "invoices" && <Panel title="Invoices" tools={<Button kind="small" onClick={() => setShowInvoiceForm(open => !open)}>{showInvoiceForm ? "Close" : "Create invoice"}</Button>}>
      {showInvoiceForm && <form className="action-form invoice-form" onSubmit={event => submitAmount(event, true)}><label>CUSTOMER<select name="customer_id" required><option value="">Select customer</option>{customers.map(customer => <option value={customer.id} key={customer.id}>{text(customer.name, customer.email, customer.id)}</option>)}</select></label><label>AMOUNT<input name="amount" inputMode="decimal" required/></label><CurrencyField currencies={currencies}/><label>DUE DATE<input name="due_on" type="date" required/></label><label>DESCRIPTION<input name="description" required/></label><Button kind="primary" disabled={busy || !actor || !collectionComplete(stripe, "customers")}>{busy ? "Creating…" : "Create invoice"}</Button></form>}
      <div className="data-row product-columns table-head"><span>INVOICE</span><span>AMOUNT DUE</span><span>DUE</span><span>STATUS / ACTION</span></div><CollectionRows provider={stripe} name="invoices" rows={[...invoices].reverse()}>{rows => rows.map(invoice => <div className="data-row product-columns" key={invoice.id}><button className="row-link" onClick={() => setSelected(invoice)}><strong>{text(invoice.description, invoice.id)}</strong><small>#{text(invoice.number)}</small></button><strong>{money(invoice.amount_due, invoice.currency)}</strong><span>{shortDate(invoice.due_date && Number(invoice.due_date) * 1000)}</span><span className="inline-actions"><code>{invoice.status ?? "Unknown"}</code>{invoice.status === "open" && <Button kind="small" disabled={busy || !actor} onClick={() => act("/api/actions/stripe-pay-invoice", { invoice_id: invoice.id }, "invoices")}>Pay</Button>}</span></div>)}</CollectionRows>
    </Panel>}
    {view === "subscriptions" && <Panel title="Subscriptions"><div className="data-row product-columns table-head"><span>SUBSCRIPTION</span><span>CUSTOMER</span><span>AMOUNT / BILLING INTERVAL</span><span>STATUS / ACTION</span></div><CollectionRows provider={stripe} name="subscriptions">{rows => rows.map(subscription => {
      let amounts; try { amounts = subscriptionAmounts(subscription, stripe).map(row => `${money(row.amount, row.currency)} / ${intervalLabel(row)}`).join(" · ") || "No price items"; } catch { amounts = "Unknown"; }
      return <div className="data-row product-columns" key={subscription.id}><button className="row-link" onClick={() => setSelected(subscription)}>{subscription.id}</button><span>{customerName(subscription.customer)}</span><strong>{amounts}</strong><span className="inline-actions"><code>{subscription.status ?? "Unknown"}</code>{subscription.status === "active" && <Button kind="small" disabled={busy || !actor} onClick={() => window.confirm("Cancel this subscription through the Stripe API?") && act("/api/actions/stripe-cancel-subscription", { subscription_id: subscription.id }, "subscriptions")}>Cancel</Button>}</span></div>;
    })}</CollectionRows></Panel>}
    {view === "products" && <><Panel title="Products"><CollectionRows provider={stripe} name="products">{rows => rows.map(product => <button className="data-row clickable-row" key={product.id} onClick={() => setSelected(product)}><strong>{product.name}</strong><code>{product.id}</code><span>{product.active === true ? "Active" : product.active === false ? "Archived" : "Unknown"}</span></button>)}</CollectionRows></Panel><div className="section"><Panel title="Prices"><div className="data-row product-columns table-head"><span>PRODUCT / PRICE</span><span>AMOUNT</span><span>BILLING INTERVAL</span><span>STATE</span></div><CollectionRows provider={stripe} name="prices">{rows => rows.map(price => <button className="data-row product-columns clickable-row" key={price.id} onClick={() => setSelected(price)}><span>{text(products.find(product => product.id === (price.product?.id ?? price.product))?.name, price.product?.name, price.product?.id, price.product)}<small>{price.id}</small></span><strong>{money(price.unit_amount, price.currency)}</strong><span>{price.type === "one_time" ? "One time" : intervalLabel(price.recurring)}</span><span>{price.active === true ? "Active" : price.active === false ? "Archived" : "Unknown"}</span></button>)}</CollectionRows></Panel></div></>}
    {view === "refunds" && <Panel title="Refunds"><div className="data-row product-columns table-head"><span>REFUND</span><span>AMOUNT</span><span>PAYMENT / CHARGE</span><span>STATUS</span></div><CollectionRows provider={stripe} name="refunds">{rows => rows.map(refund => <button className="data-row product-columns clickable-row" key={refund.id} onClick={() => setSelected(refund)}><code>{refund.id}</code><strong>{money(refund.amount, refund.currency)}</strong><span>{text(refund.payment_intent, refund.charge)}</span><span>{refund.status ?? "Unknown"}</span></button>)}</CollectionRows></Panel>}
    <RecordDrawer title="Stripe record" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Linear({ data, onChanged, onAction }) {
  const linear = data.providers.linear ?? {}, issues = list(linear.issues), states = linearStates(linear);
  const [status, setStatus] = useState("all"), [selected, setSelected] = useState(null), [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const filtered = issues.filter(issue => (status === "all" || linearStateKey(issue.state) === status) && `${issue.title} ${issue.identifier ?? ""} ${issue.id}`.toLowerCase().includes(search.toLowerCase()));
  async function refresh() {
    setBusy(true);
    try { const fresh = await onChanged(); if (collectionComplete(fresh?.providers?.linear, "issues")) onAction?.({ type: "read", surface: "linear", target: "issues", success: true }); }
    finally { setBusy(false); }
  }
  return <><PageHead title="Linear" subtitle="Issues and provider workflow states for this world." command={linear.organization?.name ?? "Linear API"}/><ProviderError data={data} name="Linear"/>
    <Metrics items={[["Issues", collectionCount(linear, "issues") ?? "Unknown"], ["Teams", collectionCount(linear, "teams") ?? "Unknown"]]}/>
    <div className="section"><Panel title={collectionComplete(linear, "issues") ? `Issues · ${filtered.length}` : "Issues · total unknown"} tools={<div className="inline-actions"><input aria-label="Search issues" placeholder="Search issues" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="Filter provider state" className="compact-select" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All issues</option>{states.map(state => <option key={state.key} value={state.key}>{state.name}{state.type ? ` · ${state.type}` : ""} · {state.count ?? "Unknown"}</option>)}</select><Button kind="small" disabled={busy} onClick={refresh}>Refresh</Button></div>}>
      <CollectionNotice provider={linear} name="issues"/>
      <div className="data-row linear-columns table-head"><span>ISSUE</span><span>STATUS</span><span>ASSIGNEE</span><span>LABELS</span></div>
      {filtered.length ? <PagedRows key={`${status}/${search}`} rows={filtered}>{rows => rows.map(issue => <button className="data-row linear-columns clickable-row" key={issue.id} onClick={() => setSelected(issue)}><span><strong>{issue.title}</strong><small>{text(issue.identifier, issue.id)}</small></span><span className="state-pill">{issue.state?.name ?? "Unknown"}<small>{issue.state?.type}</small></span><code className="muted truncate">{text(issue.assignee?.email, issue.assignee?.name, typeof issue.assignee === "string" ? issue.assignee : undefined, "Unassigned")}</code><span className="tag-list">{list(issue.labels).map(label => <code key={label.id ?? label.name ?? label}>{label.name ?? label}</code>)}</span></button>)}</PagedRows> : collectionComplete(linear, "issues") && <EmptyProduct>{issues.length ? "No issues match the filter." : "No Linear issues are present."}</EmptyProduct>}
    </Panel></div><RecordDrawer title="Linear issue" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

function ProviderRefresh({ provider, target, data, onChanged, onAction }) {
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setBusy(true);
    try {
      const fresh = await onChanged();
      if (collectionComplete(fresh?.providers?.[provider], target)) onAction?.({ type: "read", surface: data.surfaces?.find(row => row.id === provider)?.id ?? provider, target, success: true });
    } finally { setBusy(false); }
  }
  return <Button kind="small" disabled={busy || !onChanged} onClick={refresh}>Refresh</Button>;
}
const knownCount = (provider, name, predicate) => collectionCount(provider, name, predicate) ?? "Unknown";

export function Okta({ data, onChanged, onAction }) {
  const okta = data.providers.okta ?? {};
  const [view, setView] = useState("users"), [selected, setSelected] = useState(null);
  return <><PageHead title="Okta" subtitle="Directory people, groups, and applications." command="Okta Management API"/><ProviderError data={data} name="Okta"/>
    <Metrics items={[["People", knownCount(okta, "users")], ["Active", knownCount(okta, "users", user => user.status === "ACTIVE")], ["Groups", knownCount(okta, "groups")], ["Applications", knownCount(okta, "applications")]]}/>
    <nav className="product-tabs section">{[["users", "People"], ["groups", "Groups"], ["applications", "Applications"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}<ProviderRefresh provider="okta" target={view} {...{ data, onChanged, onAction }}/></nav>
    {view === "users" && <Panel title="People"><div className="data-row identity-columns table-head"><span>PERSON</span><span>LOGIN</span><span>STATUS</span></div><CollectionRows provider={okta} name="users">{rows => rows.map(user => <button className="data-row identity-columns clickable-row" key={user.id} onClick={() => setSelected(user)}><span><strong>{text(user.profile?.displayName, [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(" "), user.profile?.login)}</strong><small>{user.id}</small></span><code className="muted truncate">{text(user.profile?.login, user.profile?.email)}</code><code className={user.status === "ACTIVE" ? "green" : "muted"}>{user.status ?? "Unknown"}</code></button>)}</CollectionRows></Panel>}
    {view === "groups" && <Panel title="Groups"><CollectionRows provider={okta} name="groups">{rows => <div className="card-grid">{rows.map(group => <button className="product-card" key={group.id} onClick={() => setSelected(group)}><strong>{text(group.profile?.name, group.name)}</strong><p>{text(group.profile?.description, group.description, "No description")}</p><code>{group.id}</code></button>)}</div>}</CollectionRows></Panel>}
    {view === "applications" && <Panel title="Applications"><CollectionRows provider={okta} name="applications">{rows => <div className="card-grid">{rows.map(application => <button className="product-card" key={application.id} onClick={() => setSelected(application)}><strong>{text(application.label, application.name)}</strong><p>{application.signOnMode ?? "Unknown sign-on mode"}</p><code>{application.status ?? "Unknown"}</code></button>)}</div>}</CollectionRows></Panel>}
    <RecordDrawer title="Okta record" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Clerk({ data, onChanged, onAction }) {
  const clerk = data.providers.clerk ?? {};
  const [view, setView] = useState("users"), [selected, setSelected] = useState(null);
  const nameOf = user => text([user.first_name, user.last_name].filter(Boolean).join(" "), user.username, user.id);
  const emailOf = user => text(user.email_addresses?.find(email => email.id === user.primary_email_address_id)?.email_address, user.primary_email_address?.email_address, user.email_addresses?.[0]?.email_address);
  return <><PageHead title="Clerk" subtitle="Application users, organizations, and sessions." command="Clerk Backend API"/><ProviderError data={data} name="Clerk"/>
    <Metrics items={[["Users", knownCount(clerk, "users")], ["Organizations", knownCount(clerk, "organizations")], ["Sessions", knownCount(clerk, "sessions")], ["Locked", knownCount(clerk, "users", user => user.locked === true)]]}/>
    <nav className="product-tabs section">{[["users", "Users"], ["organizations", "Organizations"], ["sessions", "Sessions"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}<ProviderRefresh provider="clerk" target={view} {...{ data, onChanged, onAction }}/></nav>
    {view === "organizations" && <Panel title="Organizations"><CollectionRows provider={clerk} name="organizations">{rows => <div className="card-grid">{rows.map(organization => <button className="product-card" key={organization.id} onClick={() => setSelected(organization)}><strong>{organization.name}</strong><p>{organization.members_count ?? organization.membersCount ?? "Unknown"} members</p><code>{organization.slug ?? organization.id}</code></button>)}</div>}</CollectionRows></Panel>}
    {view === "users" && <Panel title="Users"><div className="data-row identity-columns table-head"><span>USER</span><span>EMAIL</span><span>STATUS</span></div><CollectionRows provider={clerk} name="users">{rows => rows.map(user => <button className="data-row identity-columns clickable-row" key={user.id} onClick={() => setSelected(user)}><span><strong>{nameOf(user)}</strong><small>{user.id}</small></span><code className="muted truncate">{emailOf(user)}</code><code>{user.banned ? "banned" : user.locked ? "locked" : user.banned === false && user.locked === false ? "active" : "Unknown"}</code></button>)}</CollectionRows></Panel>}
    {view === "sessions" && <Panel title="Sessions"><div className="data-row identity-columns table-head"><span>SESSION</span><span>USER</span><span>STATUS</span></div><CollectionRows provider={clerk} name="sessions">{rows => rows.map(session => <button className="data-row identity-columns clickable-row" key={session.id} onClick={() => setSelected(session)}><code>{session.id}</code><code className="muted">{session.user_id}</code><code className={session.status === "active" ? "green" : "muted"}>{session.status ?? "Unknown"}</code></button>)}</CollectionRows></Panel>}
    <RecordDrawer title="Clerk record" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Twilio({ data, onChanged, onAction }) {
  const twilio = data.providers.twilio ?? {};
  const [selected, setSelected] = useState(null);
  return <><PageHead title="Twilio" subtitle="Phone numbers, messaging, and verification services." command={twilio.account?.friendly_name ?? "Twilio API"}/><ProviderError data={data} name="Twilio"/>
    <Metrics items={[["Phone numbers", knownCount(twilio, "phone_numbers")], ["Messaging services", knownCount(twilio, "messaging_services")], ["Verify services", knownCount(twilio, "verify_services")], ["Account", twilio.collectionStatus?.account?.status === "complete" ? twilio.account?.sid ?? "Unknown" : "Unknown"]]}/>
    <div className="section"><ProviderRefresh provider="twilio" target="phone_numbers" {...{ data, onChanged, onAction }}/></div>
    {[["phone_numbers", "Phone numbers"], ["messaging_services", "Messaging services"], ["verify_services", "Verify services"]].map(([key, label]) => <div className="section" key={key}><Panel title={label}><CollectionRows provider={twilio} name={key}>{rows => <div className="card-grid">{rows.map(row => <button className="product-card" key={row.sid} onClick={() => setSelected(row)}><strong>{text(row.phone_number, row.friendly_name, row.sid)}</strong><p>{key === "phone_numbers" ? row.friendly_name : key === "messaging_services" ? list(row.phone_numbers).join(", ") : `Default channel: ${row.default_channel ?? "Unknown"}`}</p><code>{row.sid}</code></button>)}</div>}</CollectionRows></Panel></div>)}
    <RecordDrawer title="Twilio resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Resend({ data, onChanged, onAction }) {
  const resend = data.providers.resend ?? {};
  const [view, setView] = useState("emails"), [selected, setSelected] = useState(null);
  const contacts = collectionComplete(resend, "contactGroups") ? list(resend.contactGroups).reduce((sum, group) => sum + list(group.contacts).length, 0) : "Unknown";
  return <><PageHead title="Resend" subtitle="Email delivery, sending domains, and audiences." command="Resend API"/><ProviderError data={data} name="Resend"/>
    <Metrics items={[["Emails", knownCount(resend, "emails")], ["Delivered", knownCount(resend, "emails", email => email.status === "delivered")], ["Domains", knownCount(resend, "domains")], ["Contacts", contacts]]}/>
    <nav className="product-tabs section">{[["emails", "Email activity"], ["domains", "Domains"], ["contactGroups", "Audiences"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}<ProviderRefresh provider="resend" target={view} {...{ data, onChanged, onAction }}/></nav>
    {view === "emails" && <Panel title="Email activity"><div className="data-row product-columns table-head"><span>SUBJECT</span><span>TO</span><span>DATE</span><span>STATUS</span></div><CollectionRows provider={resend} name="emails" rows={[...list(resend.emails)].reverse()}>{rows => rows.map(email => <button className="data-row product-columns clickable-row" key={email.id} onClick={() => setSelected(email)}><span><strong>{email.subject ?? "No subject"}</strong><small>{email.from}</small></span><code className="muted truncate">{Array.isArray(email.to) ? email.to.join(", ") : email.to}</code><span>{shortDate(email.created_at)}</span><code>{email.status ?? "Unknown"}</code></button>)}</CollectionRows></Panel>}
    {view === "domains" && <Panel title="Domains"><CollectionRows provider={resend} name="domains">{rows => <div className="card-grid">{rows.map(domain => <button className="product-card" key={domain.id} onClick={() => setSelected(domain)}><strong>{domain.name}</strong><p>{domain.region ?? "Unknown region"}</p><code>{domain.status ?? "Unknown"}</code></button>)}</div>}</CollectionRows></Panel>}
    {view === "contactGroups" && <Panel title="Audiences"><CollectionRows provider={resend} name="contactGroups">{rows => <div className="card-grid">{rows.map(group => <button className="product-card" key={group.audience.id} onClick={() => setSelected(group)}><strong>{group.audience.name}</strong><p>{knownCount(group, "contacts")} contacts</p><code>{group.audience.id}</code></button>)}</div>}</CollectionRows></Panel>}
    <RecordDrawer title="Resend resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

export function Vercel({ data, onChanged, onAction }) {
  const vercel = data.providers.vercel ?? {};
  const [view, setView] = useState("projects"), [selected, setSelected] = useState(null);
  return <><PageHead title="Vercel" subtitle="Projects and deployment state for this world." command="Vercel REST API"/><ProviderError data={data} name="Vercel"/>
    <Metrics items={[["Projects", knownCount(vercel, "projects")], ["Deployments", knownCount(vercel, "deployments")], ["Ready", knownCount(vercel, "deployments", item => item.readyState === "READY" || item.state === "READY")], ["Teams", knownCount(vercel, "teams")]]}/>
    <nav className="product-tabs section">{["projects", "deployments", "teams"].map(id => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{id}</button>)}<ProviderRefresh provider="vercel" target={view} {...{ data, onChanged, onAction }}/></nav>
    <Panel title={view}><CollectionRows key={view} provider={vercel} name={view}>{rows => <div className="card-grid">{rows.map(row => <button className="product-card" key={row.id ?? row.uid} onClick={() => setSelected(row)}><strong>{text(row.name, row.slug, row.id, row.uid)}</strong><p>{text(row.url, row.framework)}</p><code>{view === "deployments" ? text(row.readyState, row.state, "Unknown") : row.id}</code></button>)}</div>}</CollectionRows></Panel>
    <RecordDrawer title="Vercel resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}

const CLUSTER_HEALTHY = ["IDLE", "AVAILABLE"];
export function MongoAtlas({ data, onChanged, onAction }) {
  const atlas = data.providers.mongoatlas ?? {};
  const [view, setView] = useState("clusters"), [selected, setSelected] = useState(null);
  return <><PageHead title="MongoDB Atlas" subtitle="Projects, clusters, data, and database access." command="Atlas Admin API v2"/><ProviderError data={data} name="MongoDB Atlas"/>
    <Metrics items={[["Projects", knownCount(atlas, "projects")], ["Clusters", knownCount(atlas, "clusters")], ["Databases", knownCount(atlas, "databases")], ["Database users", knownCount(atlas, "databaseUsers")]]}/>
    <nav className="product-tabs section">{[["clusters", "Clusters"], ["databases", "Data explorer"], ["projects", "Projects"], ["databaseUsers", "Database users"]].map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>{label}</button>)}<ProviderRefresh provider="mongoatlas" target={view} {...{ data, onChanged, onAction }}/></nav>
    {view === "clusters" && <Panel title="Clusters"><div className="data-row atlas-columns table-head"><span>CLUSTER</span><span>VERSION</span><span>REGION</span><span>SIZE</span><span>STATE</span></div><CollectionRows provider={atlas} name="clusters">{rows => rows.map(cluster => <button className="data-row atlas-columns clickable-row" key={cluster.id} onClick={() => setSelected(cluster)}><span><strong>{cluster.name}</strong><small>{text(cluster.clusterType, cluster.providerSettings?.providerName)}</small></span><code>{text(cluster.mongoDBVersion)}</code><code className="muted">{text(cluster.providerSettings?.regionName)}</code><span>{text(cluster.providerSettings?.instanceSizeName)}</span><code className={CLUSTER_HEALTHY.includes(cluster.stateName) ? "green" : "muted"}>{cluster.stateName ?? "Unknown"}</code></button>)}</CollectionRows></Panel>}
    {view === "databases" && <Panel title="Data explorer"><CollectionRows provider={atlas} name="databases">{rows => <div className="card-grid">{rows.map(database => <button className="product-card" key={`${database.groupId}/${database.cluster}/${database.name}`} onClick={() => setSelected(database)}><span className="eyebrow">{database.cluster}</span><strong>{database.name}</strong><p>{collectionComplete(database, "collections") ? database.collections.join(" · ") || "No collections" : "Collections unknown"}</p></button>)}</div>}</CollectionRows></Panel>}
    {["projects", "databaseUsers"].includes(view) && <Panel title={view}><CollectionRows key={view} provider={atlas} name={view}>{rows => <div className="card-grid">{rows.map(row => <button className="product-card" key={row.id ?? `${row.groupId}/${row.username}`} onClick={() => setSelected(row)}><strong>{text(row.name, row.username)}</strong><code>{text(row.id, row.groupId)}</code></button>)}</div>}</CollectionRows></Panel>}
    <RecordDrawer title="MongoDB Atlas resource" value={selected} onClose={() => setSelected(null)}/>
  </>;
}
