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
    if (!Array.isArray(declared.issues) || declared.issues.length === 0) continue;

    const full = `${declared.owner}/${declared.name}`;
    const repo = gs.repos.all().find((item) => item.full_name === full || item.name === declared.name);
    if (!repo) continue;

    for (const issue of declared.issues) {
      const author = userIdByLogin.get(issue.author);
      // An issue from someone the world does not have would be attributed to
      // whoever happened to be first. Drop it instead.
      if (!author) continue;

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
        assignee_ids: (issue.assignees ?? []).map((login) => userIdByLogin.get(login)).filter((id) => id !== undefined),
        label_ids: [],
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
