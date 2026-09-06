import { selectCompatibleCapabilities } from './capability-world.mjs';

// The environment `worldfixture up` starts when nobody asked for anything.
//
// The first run takes no configuration: no selector, no account, no key, no
// seed work. So the default environment is built here rather than asked for,
// and written into the instance directory so it can be read, copied and edited
// afterwards.
//
// The product image asks for every capability it can prove. A source checkout
// keeps a smaller development default. A capability whose service has no
// measured readiness check is refused by the resolver, on purpose, so neither
// list can claim a surface it did not start.

const PROVIDER_CAPABILITIES = [
  "slack.messaging.v1",
  "github.repositories.v1",
  "aws.iam.v1",
  "aws.sqs.v1",
  "aws.sts.v1",
  "apple.oauth.v1",
  "clerk.users.v1",
  "clerk.organizations.v1",
  "github.issues.v1",
  "github.apps.v1",
  "github.oauth.v1",
  "google.oauth.v1",
  "google.gmail.v1",
  "google.calendar.v1",
  "google.drive.v1",
  "linear.issues.v1",
  "linear.teams.v1",
  "microsoft.graph-users.v1",
  "microsoft.oauth.v1",
  "mongoatlas.projects.v1",
  "mongoatlas.clusters.v1",
  "notion.users.v1",
  "notion.oauth.v1",
  "notion.webhooks.v1",
  "notion.admin.v1",
  "notion.pages-read.v1",
  "notion.pages-write.v1",
  "notion.blocks-read.v1",
  "notion.blocks-write.v1",
  "notion.meeting-notes.v1",
  "notion.agents.v1",
  "notion.sessions.v1",
  "notion.databases.v1",
  "notion.data-sources.v1",
  "notion.views.v1",
  "notion.custom-emojis.v1",
  "notion.async-tasks.v1",
  "notion.markdown.v1",
  "notion.comments.v1",
  "notion.file-uploads.v1",
  "okta.users.v1",
  "okta.groups.v1",
  "okta.oauth.v1",
  "resend.email.v1",
  "resend.contacts.v1",
  "resend.domains.v1",
  "slack.oauth.v1",
  "stripe.customers.v1",
  "stripe.catalog.v1",
  "twilio.messaging.v1",
  "twilio.verify.v1",
  "vercel.projects.v1",
  "vercel.teams.v1",
  "domain.collections.v1",
];

const PROVIDER_BINDINGS = {
  SLACK_BASE_URL: "slack.messaging.v1/base_url", SLACK_TOKEN: "slack.messaging.v1/token",
  GITHUB_BASE_URL: "github.repositories.v1/base_url", GITHUB_TOKEN: "github.repositories.v1/token",
  DOMAIN_BASE_URL: "domain.collections.v1/base_url",
  DOMAIN_TOKEN: "domain.collections.v1/token",
  AWS_BASE_URL: "aws.iam.v1/base_url",
  AWS_TOKEN: "aws.iam.v1/token",
  APPLE_BASE_URL: "apple.oauth.v1/base_url",
  APPLE_TOKEN: "apple.oauth.v1/token",
  CLERK_BASE_URL: "clerk.users.v1/base_url",
  CLERK_TOKEN: "clerk.users.v1/token",
  GOOGLE_BASE_URL: "google.gmail.v1/base_url",
  GOOGLE_TOKEN: "google.gmail.v1/token",
  LINEAR_BASE_URL: "linear.issues.v1/base_url",
  LINEAR_TOKEN: "linear.issues.v1/token",
  MICROSOFT_BASE_URL: "microsoft.graph-users.v1/base_url",
  MICROSOFT_TOKEN: "microsoft.graph-users.v1/token",
  MONGOATLAS_BASE_URL: "mongoatlas.projects.v1/base_url",
  MONGOATLAS_TOKEN: "mongoatlas.projects.v1/token",
  NOTION_BASE_URL: "notion.pages-read.v1/base_url",
  NOTION_TOKEN: "notion.pages-read.v1/token",
  NOTION_ADMIN_BASE_URL: "notion.admin.v1/base_url",
  NOTION_ADMIN_TOKEN: "notion.admin.v1/token",
  OKTA_BASE_URL: "okta.users.v1/base_url",
  OKTA_TOKEN: "okta.users.v1/token",
  RESEND_BASE_URL: "resend.email.v1/base_url",
  RESEND_TOKEN: "resend.email.v1/token",
  STRIPE_BASE_URL: "stripe.customers.v1/base_url",
  STRIPE_TOKEN: "stripe.customers.v1/token",
  TWILIO_BASE_URL: "twilio.messaging.v1/base_url",
  TWILIO_TOKEN: "twilio.messaging.v1/token",
  TWILIO_ACCOUNT_SID: "twilio.messaging.v1/account_sid",
  TWILIO_AUTH_TOKEN: "twilio.messaging.v1/auth_token",
  VERCEL_BASE_URL: "vercel.projects.v1/base_url",
  VERCEL_TOKEN: "vercel.projects.v1/token",
};

// The parts of the world a run can ask for.
//
// WHY THIS EXISTS. An environment is already a list of capabilities, and the
// resolver already turns that list into the set of services to start. What was
// missing was a way to SAY a shorter list. Every run therefore started every
// service and seeded the whole world, and the cost of that is not evenly spread:
// `projections/mail.json` is 1.58 MB of the default world and Cyrus delivers
// every message in it over LMTP one at a time, which is about sixty of the
// ninety-five seconds a full start takes. A run that does not need mail should
// not pay for mail.
//
// The names here are parts of a world, not capability ids, because that is what
// somebody choosing knows they want. Each maps to the capabilities that part
// publishes; `resolve.mjs` maps those to services, and each service manifest
// already declares which world projection it reads.
export const WORLD_PARTS = {
  domain: ["domain.collections.v1"],
  slack: ["slack.messaging.v1"],
  github: ["github.repositories.v1"],
  site: ["http.public-site.v1"],
  mail: ["mail.imap.v1", "mail.smtp-submission.v1"],
  s3: ["aws.s3.objects.v1", "aws.s3.buckets.v1"],
};

export function partsFor(names) {
  const unknown = names.filter((name) => !(name in WORLD_PARTS) && name !== "providers");
  if (unknown.length > 0) {
    throw new Error(
      `unknown world part${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; ` +
        `this world publishes ${[...Object.keys(WORLD_PARTS), "providers"].join(", ")}`,
    );
  }
  return names;
}

export function defaultEnvironment(
  world = "business.saas-company:v3",
  {
    includeS3 = false,
    includeProviders = false,
    includePostgres = false,
    includeMySQL = false,
    only,
    oauthClients = {},
    artifactPath,
    manifests,
    // Whose credentials the bindings carry. Named by the caller, which has read
    // the world, because it is a fact about the world and not about this file.
    //
    // IT USED TO BE THE LITERAL `maya-chen`, and that is the default world's
    // primary person and nobody else's. Every other world resolved no mail
    // account for that id and refused to start with four unresolved bindings --
    // measured on `consumer.retail-brand:v1`, whose primary person is
    // `iris-mendel`, and on any world somebody compiles themselves. The default
    // is absent when the world does not declare a primary person.
    identity,
  } = {},
) {
  // `only` names the parts of the world this run wants. Absent, it wants all of
  // them, which is what the zero-configuration first run has always given.
  const wanted = only ? new Set(partsFor(only)) : null;
  const wants = (part) => wanted === null || wanted.has(part);

  const spec = {
    api_version: "worldfixture.environment/v1",
    world: { use: world },
    requires: [
      ...(wants("slack") ? ["slack.messaging.v1"] : []),
      ...(wants("github") ? ["github.repositories.v1"] : []),
      ...(wants("site") ? ["http.public-site.v1"] : []),
      ...(wants("mail") ? ["mail.imap.v1", "mail.smtp-submission.v1"] : []),
    ],
    bindings: {
      ...(wants("slack") ? {
        SLACK_BASE_URL: "slack.messaging.v1/base_url",
        SLACK_TOKEN: "slack.messaging.v1/token",
      } : {}),
      ...(wants("github") ? {
        GITHUB_BASE_URL: "github.repositories.v1/base_url",
        GITHUB_TOKEN: "github.repositories.v1/token",
      } : {}),
      ...(wants("site") ? { SITE_BASE_URL: "http.public-site.v1/base_url" } : {}),
      ...(wants("mail") ? {
        IMAP_HOST_PORT: "mail.imap.v1/host_port",
        IMAP_USERNAME: "mail.imap.v1/username",
        IMAP_PASSWORD: "mail.imap.v1/password",
        SMTP_HOST_PORT: "mail.smtp-submission.v1/host_port",
        SMTP_HOST: "mail.smtp-submission.v1/host",
        SMTP_PORT: "mail.smtp-submission.v1/port",
        SMTP_USERNAME: "mail.smtp-submission.v1/username",
        SMTP_PASSWORD: "mail.smtp-submission.v1/password",
      } : {}),
    },
    rules: [],
    execution: { mode: only ? "selected-capabilities" : "all" },
    // The world's own primary person. A per-person credential belonging to
    // nobody is refused, and there is no anonymous default.
    target: { kind: "none", ...(identity ? { identity } : {}) },
  };

  // The product image is the complete zero-configuration world. Start every
  // provider listener that has compatible source and projection requirements.
  // A source checkout keeps the smaller development default so its ordinary
  // CLI tests do not start thirteen listeners for each case.
  if (includeProviders && wants("providers")) {
    spec.requires.push(...PROVIDER_CAPABILITIES);
    Object.assign(spec.bindings, PROVIDER_BINDINGS);
  }

  for (const [provider, clients] of Object.entries(oauthClients)) {
    if (!spec.requires.some(profile => profile.startsWith(`${provider}.`))) continue;
    const profile = `${provider}.oauth.v1`;
    if (!spec.requires.includes(profile)) spec.requires.push(profile);
    // OAuth can be selected without the provider's content capability. Its
    // connection URL and user token must still reach the selected listener.
    spec.bindings[`${provider.toUpperCase()}_BASE_URL`] = `${profile}/base_url`;
    if (manifests?.some(manifest => manifest.provides.some(capability => capability.profile === profile && capability.binds?.some(binding => binding.name === 'token')))) {
      spec.bindings[`${provider.toUpperCase()}_TOKEN`] = `${profile}/token`;
    }
    const selected = clients.find(client => client.primary) ?? (clients.length === 1 ? clients[0] : undefined);
    if (!selected) continue;
    spec.bindings[`${provider.toUpperCase()}_CLIENT_ID`] = `${profile}/client_id`;
    const publicClient = (provider === "clerk" && selected.is_public === true)
      || (provider === "okta" && selected.token_endpoint_auth_method === "none");
    if (!publicClient && !selected.public_key) spec.bindings[`${provider.toUpperCase()}_CLIENT_SECRET`] = `${profile}/client_secret`;
  }

  // SeaweedFS is part of the product image. A source checkout still uses its
  // separate service container and keeps the smaller development default; its
  // dedicated supervisor and protocol gates cover that fallback.
  if (includeS3 && wants("s3")) {
    spec.requires.push("aws.s3.objects.v1");
    spec.bindings.S3_BASE_URL = "aws.s3.objects.v1/base_url";
    spec.bindings.S3_ACCESS_KEY_ID = "aws.s3.objects.v1/access_key_id";
    spec.bindings.S3_SECRET_ACCESS_KEY = "aws.s3.objects.v1/secret_access_key";
    spec.bindings.S3_REGION = "aws.s3.objects.v1/region";
    spec.bindings.S3_BUCKET = "aws.s3.objects.v1/bucket";
    spec.bindings.S3_PATH_STYLE = "aws.s3.objects.v1/path_style";
  }

  if (includePostgres) {
    spec.requires.push("postgres.wire.v1");
    spec.bindings.POSTGRES_HOST = "postgres.wire.v1/host";
    spec.bindings.POSTGRES_PORT = "postgres.wire.v1/port";
    spec.bindings.POSTGRES_USERNAME = "postgres.wire.v1/username";
    spec.bindings.POSTGRES_PASSWORD = "postgres.wire.v1/password";
    spec.bindings.POSTGRES_DATABASE = "postgres.wire.v1/database";
    spec.bindings.POSTGRES_URL = "postgres.wire.v1/url";
  }

  if (includeMySQL) {
    spec.requires.push("mysql.wire.v1");
    spec.bindings.MYSQL_HOST = "mysql.wire.v1/host";
    spec.bindings.MYSQL_PORT = "mysql.wire.v1/port";
    spec.bindings.MYSQL_USERNAME = "mysql.wire.v1/username";
    spec.bindings.MYSQL_PASSWORD = "mysql.wire.v1/password";
    spec.bindings.MYSQL_DATABASE = "mysql.wire.v1/database";
    spec.bindings.MYSQL_URL = "mysql.wire.v1/url";
  }

  if (wanted?.has("domain")) {
    spec.requires.push("domain.collections.v1");
    spec.bindings.DOMAIN_BASE_URL = "domain.collections.v1/base_url";
    spec.bindings.DOMAIN_TOKEN = "domain.collections.v1/token";
  }
  spec.requires = [...new Set(spec.requires)];
  if (artifactPath && manifests) return selectCompatibleCapabilities(spec, { artifactPath, manifests,
    explicitProfiles: only?.flatMap(part => WORLD_PARTS[part] ?? []) ?? [] });
  return spec;
}
