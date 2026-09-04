const auth = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

export async function providerJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${new URL(url).pathname} returned ${response.status}: ${text.slice(0, 180)}`);
  return text ? JSON.parse(text) : {};
}

export async function slackChannels(bindings) {
  const result = await providerJson(`${bindings.SLACK_BASE_URL}/api/conversations.list`, {
    method: "POST", headers: auth(bindings.SLACK_TOKEN, { "content-type": "application/x-www-form-urlencoded" }), body: "limit=20",
  });
  return result.channels ?? [];
}

// The channel these examples read and post to.
//
// Configurable for the same reason the repository list is: a hard-coded name
// belongs to one world, and when the default world changed its release channel
// every call against the old name failed.
export const RELEASE_CHANNEL = process.env.WORLDFIXTURE_SLACK_CHANNEL ?? "release-3-2";

export async function slackHistory(bindings, channelName = RELEASE_CHANNEL) {
  const channels = await slackChannels(bindings);
  const channel = channels.find((entry) => entry.name === channelName) ?? channels[0];
  if (!channel) return [];
  const result = await providerJson(`${bindings.SLACK_BASE_URL}/api/conversations.history`, {
    method: "POST", headers: auth(bindings.SLACK_TOKEN, { "content-type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams({ channel: channel.id, limit: "20" }),
  });
  return result.messages ?? [];
}

export async function postSlack(bindings, text, channelName = RELEASE_CHANNEL) {
  const channels = await slackChannels(bindings);
  const channel = channels.find((entry) => entry.name === channelName);
  if (!channel) throw new Error(`Slack channel ${channelName} is not present`);
  return await providerJson(`${bindings.SLACK_BASE_URL}/api/chat.postMessage`, {
    method: "POST", headers: auth(bindings.SLACK_TOKEN, { "content-type": "application/json" }),
    body: JSON.stringify({ channel: channel.id, text }),
  });
}

// The repositories this application watches.
//
// It has to be told. The emulator serves `/repos/<owner>/<name>` but neither
// `/orgs/<org>/repos` nor `/users/<org>/repos` -- both answer 404 -- and
// `/user/repos` returns nothing because the repositories belong to the
// organization rather than to the signed-in person. A real integration is
// configured with the repositories it cares about too, so this is the honest
// shape rather than a workaround.
//
// EVERY NAME IS FETCHED INDEPENDENTLY. This used to be `Promise.all` over a list
// hard-coded to one world's repositories. When the default world changed its
// repository names, two of the three 404'd, the whole sweep rejected, and the
// application reported ZERO issues for every customer rather than the ones it
// could still see. A name that is not there is skipped; the rest are returned.
const DEFAULT_REPOSITORIES = ["relay-core", "relay-exports", "relay-console", "relay-api", "relay-billing"];

export function watchedRepositories() {
  const configured = process.env.WORLDFIXTURE_REPOSITORIES;
  return configured ? configured.split(",").map((name) => name.trim()).filter(Boolean) : DEFAULT_REPOSITORIES;
}

export async function githubRepositories(bindings) {
  const owner = process.env.WORLDFIXTURE_GITHUB_OWNER ?? "northstar-relay";
  const found = await Promise.allSettled(
    watchedRepositories().map((name) =>
      providerJson(`${bindings.GITHUB_BASE_URL}/repos/${owner}/${name}`, { headers: auth(bindings.GITHUB_TOKEN) })),
  );
  return found.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
}

export async function createGithubIssue(bindings, title, body, repositoryName) {
  const repositories = await githubRepositories(bindings);
  const repository = repositories.find((entry) => entry.full_name === repositoryName || entry.name === repositoryName) ?? repositories[0];
  if (!repository) throw new Error("GitHub returned no repositories");
  const issue = await providerJson(`${bindings.GITHUB_BASE_URL}/repos/${repository.full_name}/issues`, {
    method: "POST", headers: auth(bindings.GITHUB_TOKEN, { "content-type": "application/json" }),
    body: JSON.stringify({ title, body }),
  });
  return { repository, issue };
}

export async function gmailMessages(bindings, maxResults = 100) {
  return await providerJson(`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages?maxResults=${maxResults}`, { headers: auth(bindings.GOOGLE_TOKEN) });
}

export async function gmailMessageDetails(bindings) {
  const list = await gmailMessages(bindings);
  return await Promise.all((list.messages ?? []).map((message) =>
    providerJson(`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/${message.id}?format=metadata`, {
      headers: auth(bindings.GOOGLE_TOKEN),
    })));
}

export async function sendGmail(bindings, { to, subject, text }) {
  const raw = Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`)
    .toString("base64url");
  return await providerJson(`${bindings.GOOGLE_BASE_URL}/gmail/v1/users/me/messages/send`, {
    method: "POST", headers: auth(bindings.GOOGLE_TOKEN, { "content-type": "application/json" }), body: JSON.stringify({ raw }),
  });
}

export async function s3Buckets(bindings) {
  return await Promise.all(["northstar-relay-documents", "northstar-relay-exports"].map(async (name) => {
    const response = await fetch(`${bindings.S3_BASE_URL}/${name}/?list-type=2`);
    const xml = await response.text();
    if (!response.ok) throw new Error(`S3 ListObjectsV2 returned ${response.status}`);
    return `${name} · ${[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].length} objects`;
  }));
}

export async function s3BucketDetails(bindings) {
  return await Promise.all(["northstar-relay-documents", "northstar-relay-exports"].map(async (name) => {
    const response = await fetch(`${bindings.S3_BASE_URL}/${name}/?list-type=2`);
    const xml = await response.text();
    if (!response.ok) throw new Error(`S3 ListObjectsV2 returned ${response.status}`);
    return { name, keys: [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]) };
  }));
}

export async function githubIssues(bindings) {
  const repositories = await githubRepositories(bindings);
  const groups = await Promise.all(repositories.map(async (repository) => ({
    repository,
    issues: await providerJson(`${bindings.GITHUB_BASE_URL}/repos/${repository.full_name}/issues?state=all&per_page=100`, {
      headers: auth(bindings.GITHUB_TOKEN),
    }),
  })));
  return groups.flatMap(({ repository, issues }) => issues.map((issue) => ({ ...issue, repository: repository.full_name })));
}

export async function stripeCustomers(bindings) {
  const result = await providerJson(`${bindings.STRIPE_BASE_URL}/v1/customers?limit=100`, {
    headers: auth(bindings.STRIPE_TOKEN),
  });
  return result.data ?? [];
}

export async function allSlackMessages(bindings) {
  const channels = await slackChannels(bindings);
  const groups = await Promise.all(channels.map(async (channel) => {
    const result = await providerJson(`${bindings.SLACK_BASE_URL}/api/conversations.history`, {
      method: "POST", headers: auth(bindings.SLACK_TOKEN, { "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ channel: channel.id, limit: "100" }),
    });
    return (result.messages ?? []).map((message) => ({ ...message, channel: channel.name, channel_id: channel.id }));
  }));
  return groups.flat();
}

export async function putS3Object(bindings, bucket, key, value) {
  const response = await fetch(`${bindings.S3_BASE_URL}/${bucket}/${key}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value, null, 2),
  });
  if (!response.ok) throw new Error(`S3 PutObject returned ${response.status}: ${(await response.text()).slice(0, 180)}`);
  return { bucket, key, etag: response.headers.get("etag") };
}

export async function websitePreview(bindings) {
  const response = await fetch(`${bindings.SITE_BASE_URL}/`);
  const html = await response.text();
  if (!response.ok) throw new Error(`website returned ${response.status}`);
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
}

export async function overview(bindings) {
  const [slack, gmail, github, s3, website] = await Promise.all([
    slackHistory(bindings), gmailMessages(bindings), githubRepositories(bindings), s3Buckets(bindings), websitePreview(bindings),
  ]);
  const markerPresent = slack.some((message) => String(message.text).includes("WF_EXAMPLE_"));
  return { slack, gmail, github, s3, website, resetProof: markerPresent ? "Example changes are present." : "Accepted start is present; no example marker is in Slack." };
}

export async function connectedWorkflow(bindings, marker = `WF_EXAMPLE_${Date.now()}`) {
  const phases = [{ name: "Submitted", at: new Date().toISOString() }];
  const { repository, issue } = await createGithubIssue(bindings, `Release follow-up ${marker}`, "Created by the WorldFixture regular application example.");
  phases.push({ name: "Accepted by service", detail: `GitHub issue ${issue.number ?? issue.id}` });
  const slack = await postSlack(bindings, `${marker}: ${repository.full_name} issue #${issue.number ?? issue.id} needs review.`);
  const confirmed = await slackHistory(bindings);
  if (!confirmed.some((message) => String(message.text).includes(marker))) {
    throw new Error("Slack accepted the request but the application could not read the message back");
  }
  phases.push({ name: "Confirmed through Slack", detail: `Slack accepted ${slack.ts ?? slack.message?.ts}` });
  const report = await putS3Object(bindings, "northstar-relay-exports", `${marker}.json`, { marker, repository: repository.full_name, issue: issue.number ?? issue.id });
  const gmail = await sendGmail(bindings, { to: "jon@worldfixture.test", subject: `Release follow-up ${marker}`, text: `Review ${repository.full_name} issue #${issue.number ?? issue.id}. Report: s3://${report.bucket}/${report.key}` });
  phases.push({ name: "Consequences settled", detail: `S3 report and Gmail message ${gmail.id ?? "accepted"}` });
  return { marker, issue, slack, report, gmail, phases };
}
