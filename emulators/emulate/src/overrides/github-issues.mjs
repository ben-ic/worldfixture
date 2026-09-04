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

  return { issues };
}
