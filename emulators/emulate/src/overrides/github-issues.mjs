import { getGitHubStore } from "@emulators/github";

// `GitHubSeedConfig` has no issues field, and upstream `seedFromConfig` never
// writes the issue store, so a seeded repository arrives with none. That breaks
// a reference the world makes on purpose: a Slack message in #release-2-8 says
// "I opened 322", so asking the GitHub API for issue 322 has to answer.
//
// These are inserted through the emulator's own public store before the listener
// starts, which is the seed-time path a world artifact loads through. After
// readiness every write goes through the GitHub API.
export function seedGitHubIssues(store, config) {
  if (!Array.isArray(config?.repos)) return { issues: 0 };

  const gs = getGitHubStore(store);
  const userIdByLogin = new Map(gs.users.all().map((user) => [user.login, user.id]));
  let issues = 0;

  for (const declared of config.repos) {
    const full = `${declared.owner}/${declared.name}`;
    const repo = gs.repos.all().find((item) => item.full_name === full);
    if (!repo) throw new Error(`GitHub did not seed declared repository ${full}`);
    for (const collaborator of declared.collaborators ?? []) {
      const userId = userIdByLogin.get(collaborator.username);
      if (!userId) throw new Error(`GitHub repository ${full} has unknown collaborator ${collaborator.username}`);
      if (!['pull', 'triage', 'push', 'maintain', 'admin'].includes(collaborator.permission)) throw new Error(`GitHub repository ${full} has an invalid collaborator permission`);
      const existing = gs.collaborators.findBy('repo_id', repo.id).find(row => row.user_id === userId);
      if (existing) gs.collaborators.update(existing.id, { permission: collaborator.permission });
      else gs.collaborators.insert({ repo_id: repo.id, user_id: userId, permission: collaborator.permission });
    }

    for (const issue of declared.issues ?? []) {
      const author = userIdByLogin.get(issue.author);
      if (!author) throw new Error(`GitHub issue ${full}#${issue.number} has unknown author ${issue.author}`);
      if (gs.issues.findBy('repo_id', repo.id).some(row => row.number === issue.number)) throw new Error(`GitHub issue ${full}#${issue.number} is declared more than once`);
      const assignees = (issue.assignees ?? []).map(login => {
        const userId = userIdByLogin.get(login);
        if (!userId) throw new Error(`GitHub issue ${full}#${issue.number} has unknown assignee ${login}`);
        return userId;
      });
      const labels = (issue.labels ?? []).map(value => {
        const name = typeof value === 'string' ? value : value?.name;
        if (typeof name !== 'string' || !name) throw new Error(`GitHub issue ${full}#${issue.number} has an invalid label`);
        let label = gs.labels.findBy('repo_id', repo.id).find(row => row.name === name);
        if (!label) {
          label = gs.labels.insert({ node_id: '', repo_id: repo.id, name, description: value?.description ?? null, color: value?.color ?? 'ededed', default: false });
          gs.labels.update(label.id, { node_id: `LA_${repo.id}_${label.id}` });
        }
        return label.id;
      });

      gs.issues.insert({
        node_id: `I_${repo.id}_${issue.number}`,
        number: issue.number,
        repo_id: repo.id,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state === "closed" ? "closed" : "open",
        state_reason: null,
        locked: false,
        active_lock_reason: null,
        user_id: author,
        // `formatIssue` maps both of these without a guard, so they must be
        // arrays even when empty.
        assignee_ids: assignees,
        label_ids: labels,
        milestone_id: null,
        comments: 0,
        closed_at: null,
        closed_by_id: null,
        is_pull_request: false,
      });
      issues += 1;
    }
  }

  // AND THEN RECOUNT, because `open_issues_count` is a stored field, not a
  // derived one. Upstream keeps it by hand: `adjustRepoOpenIssues` adds ±1 as the
  // issue and pull-request ROUTES open and close things. Inserting through the
  // store, which is the only seed-time path there is, walks straight past that.
  //
  // What that produced: `GET /repos/northstar-relay/relay-core` answered
  // `open_issues_count: 0` and `open_issues: 0` while
  // `GET /repos/northstar-relay/relay-core/issues?state=open` answered with eight
  // of them. Measured on a running composer, and it was `0` for every repository
  // in every world -- an app that renders a repo list from the field shows a wall
  // of zeroes beside issues it can fetch and display one click later.
  //
  // Recomputed from the rows rather than incremented, so it is idempotent and
  // cannot drift. Every repository is recounted, not only the seeded ones: a
  // count that disagrees with the rows is wrong whoever wrote it. Pull requests
  // are included because upstream's own accounting includes them -- `pulls.ts`
  // calls the same adjustment -- and so does GitHub's.
  for (const repo of gs.repos.all()) {
    const open = gs.issues.all().filter((issue) => issue.repo_id === repo.id && issue.state === "open").length;
    if (repo.open_issues_count !== open) gs.repos.update(repo.id, { open_issues_count: open });
  }

  return { issues };
}
