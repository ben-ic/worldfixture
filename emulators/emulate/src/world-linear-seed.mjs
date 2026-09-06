import { isDeepStrictEqual } from "node:util";

export const LINEAR_SEED_RECEIPT = "worldfixture.linear-seed-receipt/v1";
const sorted = values => [...values].sort();
function equal(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Linear seed verification failed: ${label}`);
}
function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function unique(rows, read, label) {
  const values = rows.map(read);
  values.forEach(value => required(value, label));
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

// IssueCreateInput in the pinned provider does not accept a caller-supplied ID.
// The receipt binds each canonical task ID to the returned ID, independently of
// title or any other mutable text. Persist it with the accepted vendor snapshot.
export async function seedWorldLinear({ world, config, seedFromConfig, fetchImpl = fetch, baseUrl,
  token, actorEmail, receipt, signal, pageSize = 100 }) {
  required(world?.id, "world.id");
  required(world?.version, "world.version");
  if (!/^[a-f0-9]{64}$/.test(world?.digest ?? "")) throw new Error("world.digest must be a SHA-256 digest");
  if (!["users", "teams", "labels", "issues"].every(key => Array.isArray(config?.[key]))) throw new Error("Linear seed needs users, teams, labels and issues arrays");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) throw new Error("Linear pageSize must be between 1 and 250");
  required(token, "Linear credential");
  required(actorEmail, "Linear actor email");
  if (!config.users.some(user => user.email === actorEmail)) throw new Error("Linear actor is not a declared user");
  unique(config.issues, issue => issue.worldfixture_task_id, "Linear source task ID");
  unique(config.users, user => user.email, "Linear user email");
  unique(config.teams, team => team.key, "Linear team key");
  const identity = { id: world.id, version: world.version, digest: world.digest };
  if (receipt) {
    equal(receipt.api_version, LINEAR_SEED_RECEIPT, "saved receipt version");
    equal(receipt.world, identity, "saved receipt world");
    if (!Array.isArray(receipt.issues)) throw new Error("Linear receipt omitted issues");
    unique(receipt.issues, issue => issue.source_task_id, "Linear receipt source ID");
    unique(receipt.issues, issue => issue.provider_issue_id, "Linear receipt provider ID");
    equal(sorted(receipt.issues.map(issue => issue.source_task_id)), sorted(config.issues.map(issue => issue.worldfixture_task_id)), "saved receipt source IDs");
  }
  signal?.throwIfAborted();
  if (!receipt) await seedFromConfig({ ...structuredClone(config), issues: [] });
  const query = async (document, variables = {}) => {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(new URL("/graphql", baseUrl), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: document, variables }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
    } catch { throw new Error("Linear seed API request failed"); }
    if (!response.ok) throw new Error(`Linear seed API returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.errors?.length || !body.data) throw new Error("Linear seed API returned GraphQL errors or no data");
    return body.data;
  };
  const connection = async (field, fields, issueId) => {
    const rows = [], cursors = new Set();
    let cursor = null;
    for (;;) {
      const selection = `${field}(first:$first,after:$after){nodes{${fields}} pageInfo{hasNextPage endCursor}}`;
      const data = await query(`query($first:Int!,$after:String${issueId ? ",$id:String!" : ""}){${issueId ? `issue(id:$id){${selection}}` : selection}}`,
        { first: pageSize, after: cursor, ...(issueId ? { id: issueId } : {}) });
      const page = (issueId ? data.issue : data)?.[field];
      if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") throw new Error(`Linear ${field} response omitted a complete connection`);
      rows.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw new Error(`Linear ${field} pagination cursor did not advance`);
      cursors.add(cursor);
    }
    unique(rows, row => row.id, `Linear ${field} API ID`);
    return rows;
  };
  equal((await query("{viewer{email}}")).viewer?.email, actorEmail, "credential identity");
  const users = await connection("users", "id email");
  const teams = await connection("teams", "id key name");
  const states = await connection("workflowStates", "id name team{id}");
  const labels = await connection("issueLabels", "id name team{id}");
  equal(sorted(users.map(user => user.email)), sorted(config.users.map(user => user.email)), "user inventory");
  equal(sorted(teams.map(team => JSON.stringify([team.key, team.name]))), sorted(config.teams.map(team => JSON.stringify([team.key, team.name]))), "team inventory");
  const labelKey = label => JSON.stringify([label.team ?? null, label.name]);
  equal(sorted(labels.map(label => labelKey({ team: teams.find(team => team.id === label.team?.id)?.key, name: label.name }))),
    sorted(config.labels.map(labelKey)), "label inventory");
  const lookup = (rows, predicate, label) => {
    const matches = rows.filter(predicate);
    if (matches.length !== 1) throw new Error(`Linear seed needs one declared ${label}; found ${matches.length}`);
    return matches[0];
  };
  const inputs = config.issues.map(issue => {
    const team = lookup(teams, row => row.key === issue.team, `team for ${issue.worldfixture_task_id}`);
    const state = lookup(states, row => row.team?.id === team.id && row.name === issue.state, `state for ${issue.worldfixture_task_id}`);
    const assignee = issue.assignee ? lookup(users, row => row.email === issue.assignee, `assignee for ${issue.worldfixture_task_id}`) : null;
    const labelIds = (issue.labels ?? []).map(name => lookup(labels,
      row => row.name === name && (row.team?.id === team.id || !row.team), `label ${name} for ${issue.worldfixture_task_id}`).id);
    return { teamId: team.id, title: required(issue.title, "Linear title"), description: issue.description ?? null,
      stateId: state.id, assigneeId: assignee?.id ?? null, labelIds, priority: issue.priority ?? 0, dueDate: issue.due_date ?? null };
  });
  const mapping = receipt ? structuredClone(receipt.issues) : [];
  if (!receipt) {
    equal((await connection("issues", "id")).length, 0, "fresh issue inventory before creation");
    for (let index = 0; index < inputs.length; index++) {
      const data = await query("mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id}}}", { input: inputs[index] });
      if (data.issueCreate?.success !== true) throw new Error(`Linear did not accept source task ${config.issues[index].worldfixture_task_id}`);
      mapping.push({ source_task_id: config.issues[index].worldfixture_task_id,
        provider_issue_id: required(data.issueCreate.issue?.id, "Linear created issue ID") });
    }
  }
  unique(mapping, row => row.provider_issue_id, "Linear returned issue ID");
  const liveIssues = await connection("issues", "id title description priority dueDate team{id} state{id} assignee{id}");
  equal(sorted(liveIssues.map(issue => issue.id)), sorted(mapping.map(row => row.provider_issue_id)), "complete issue inventory");
  for (let index = 0; index < inputs.length; index++) {
    const source = config.issues[index], input = inputs[index];
    const providerId = mapping.find(row => row.source_task_id === source.worldfixture_task_id).provider_issue_id;
    const live = liveIssues.find(issue => issue.id === providerId);
    const issueLabels = await connection("labels", "id", providerId);
    equal({ title: live.title, description: live.description, priority: live.priority, dueDate: live.dueDate,
      teamId: live.team?.id, stateId: live.state?.id, assigneeId: live.assignee?.id ?? null, labelIds: sorted(issueLabels.map(label => label.id)) },
    { ...input, labelIds: sorted(input.labelIds) }, `source task ${source.worldfixture_task_id}`);
  }
  return { api_version: LINEAR_SEED_RECEIPT, world: identity, issues: mapping };
}
