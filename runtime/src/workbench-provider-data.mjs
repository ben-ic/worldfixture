// Workbench totals require complete public API reads. A failed later page
// retains the observed rows, but never becomes a measured total.
export async function readStripeCollection(read, path) {
  const rows = [], seen = new Set();
  let cursor;
  try {
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { starting_after: cursor } : {}) });
      if (path === "subscriptions") query.set("status", "all");
      const value = await read(`/v1/${path}?${query}`);
      if (!Array.isArray(value.data) || typeof value.has_more !== "boolean") throw new Error(`${path} has incomplete pagination metadata`);
      for (const row of value.data) {
        if (!row.id || seen.has(row.id)) throw new Error(`${path} returned a missing or repeated record ID`);
        seen.add(row.id); rows.push(row);
      }
      if (!value.has_more) return { rows, status: "complete" };
      if (!value.data.length) throw new Error(`${path} returned an empty page with has_more`);
      cursor = value.data.at(-1).id;
    }
    throw new Error(`${path} exceeded the pagination limit`);
  } catch (error) { return { rows, status: "failed", error: error.message }; }
}

export async function readStripeOverview(read) {
  const collections = { customers: "customers", products: "products", prices: "prices", paymentIntents: "payment_intents",
    charges: "charges", subscriptions: "subscriptions", invoices: "invoices", refunds: "refunds", invoicePayments: "invoice_payments" };
  const entries = await Promise.all(Object.entries(collections).map(async ([key, path]) => [key, await readStripeCollection(read, path)]));
  return { ...Object.fromEntries(entries.map(([key, value]) => [key, value.rows])),
    collectionStatus: Object.fromEntries(entries.map(([key, { status, error }]) => [key, { status, ...(error ? { error } : {}) }])) };
}

export async function readLinearConnection(read, name, fields) {
  const rows = [], seen = new Set();
  let cursor;
  try {
    for (let page = 0; page < 1000; page++) {
      const result = await read(`query WorldFixtureWorkbench { ${name}(first: 100${cursor ? `, after: ${JSON.stringify(cursor)}` : ""}) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`);
      if (result.errors?.length) throw new Error(result.errors.map(entry => entry.message).join("; "));
      const value = result.data?.[name];
      if (!Array.isArray(value?.nodes) || typeof value.pageInfo?.hasNextPage !== "boolean") throw new Error(`${name} has incomplete pagination metadata`);
      for (const row of value.nodes) {
        if (!row.id || seen.has(row.id)) throw new Error(`${name} returned a missing or repeated record ID`);
        seen.add(row.id); rows.push(row);
      }
      if (!value.pageInfo.hasNextPage) return { rows, status: "complete" };
      if (!value.nodes.length || !value.pageInfo.endCursor || value.pageInfo.endCursor === cursor) throw new Error(`${name} returned an invalid next cursor`);
      cursor = value.pageInfo.endCursor;
    }
    throw new Error(`${name} exceeded the pagination limit`);
  } catch (error) { return { rows, status: "failed", error: error.message }; }
}

export async function readLinearOverview(read) {
  const fields = { teams: "id name key", states: "id name type team { id }",
    issues: "id identifier title description priority state { id name type } assignee { name email } labels { nodes { name } }" };
  const entries = await Promise.all(Object.entries(fields).map(async ([key, fields]) => [key,
    await readLinearConnection(read, key === "states" ? "workflowStates" : key, fields)]));
  let organization = null, organizationStatus;
  try {
    const response = await read("query WorldFixtureWorkbench { organization { id name } }");
    if (response.errors?.length || !response.data?.organization) throw new Error(response.errors?.map(entry => entry.message).join("; ") || "Organization read returned no record");
    organization = response.data.organization; organizationStatus = { status: "complete" };
  } catch (error) { organizationStatus = { status: "failed", error: error.message }; }
  const result = Object.fromEntries(entries.map(([key, value]) => [key, value.rows]));
  result.issues = result.issues.map(issue => ({ ...issue, assignee: issue.assignee?.email ?? issue.assignee?.name,
    labels: (issue.labels?.nodes ?? []).map(label => label.name) }));
  return { ...result, organization, collectionStatus: { organization: organizationStatus,
    ...Object.fromEntries(entries.map(([key, { status, error }]) => [key, { status, ...(error ? { error } : {}) }])) } };
}
