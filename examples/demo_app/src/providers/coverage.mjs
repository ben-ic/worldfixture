// Account Desk application workflow evidence, not a claim of full provider API
// compatibility. A live run is still required for the user's selected world.
const TEST = 'examples/demo_app/tests/';
const sdkTests = [`${TEST}providers-sdk.test.mjs`, `${TEST}providers.test.mjs`];
const secondaryTests = [`${TEST}providers-secondary.test.mjs`];
const advancedTests = [`${TEST}providers-notion.test.mjs`, `${TEST}providers-advanced-live.mjs`];
const live = `${TEST}providers-live.mjs`;

export const COVERAGE_BASELINE = {
  apiVersion: 'account-desk.provider-coverage/v1',
  checkedDate: '2026-09-05',
  advancedCheckedAt: '2026-09-05T19:18:22.863Z',
  world: 'business.saas-company:v3',
  advancedImage: 'worldfixture:account-desk',
  advancedImageId: 'sha256:0cc583df8dec71b84b58b143558b418884a8285dcb75180d9e136c0590a4b080',
  productionVerified: false,
  meaning: 'Tested means a named Account Desk workflow passed locally. It is not full endpoint coverage, production parity, or a result for the current run.',
};

function provider(service, readOperations, actionIds, sdk, tests, gaps, options = {}) {
  return { service, readOperations, actionIds, testedSDKVersion: sdk, tests: [...tests, ...(options.liveTest === false ? [] : [options.liveTest || live])], readStatus: options.readStatus || 'tested', actionStatus: Object.fromEntries(actionIds.map(action => [action, options.actionStatus?.[action] || 'tested'])), gaps, productionVerified: false, ...options };
}

export const PROVIDER_COVERAGE = [
  provider('slack', ['POST /api/users.list', 'POST /api/conversations.list', 'POST /api/conversations.history'], ['slack.send'], { '@slack/web-api': '7.12.0' }, sdkTests,
    ['Latest message is compared across all visible conversations; histories contain at most 30 messages.', 'The current provider ignores history timestamp filters. Write readback follows bounded cursor pages to find the exact saved timestamp and text.', 'No Socket Mode or full Slack API claim.']),
  provider('github', ['GET /user/repos', 'GET /search/repositories?q=size:>=0', 'GET /repos/{owner}/{repo}/issues'], ['github.issue'], { '@octokit/rest': '22.0.1' }, sdkTests,
    ['Issue reads cover at most 30 repositories. Repository and issue IDs are discovered.', 'No production Actions execution.']),
  provider('gmail', ['GET /gmail/v1/users/me/messages', 'GET /gmail/v1/users/me/messages/{id}', 'GET /gmail/v1/users/me/threads/{id}'], ['gmail.send'], { googleapis: '178.0.0' }, sdkTests,
    ['At most 100 message bodies are read. HTML-only mail uses a marked excerpt.', 'Threaded replies require the original Message-ID, References, matching subject and thread ID; local send is not remote mail delivery.']),
  provider('calendar', ['GET /calendar/v3/users/me/calendarList', 'GET /calendar/v3/calendars/{id}/events'], ['calendar.event'], { googleapis: '178.0.0' }, sdkTests,
    ['Calendar seed correction is required; this workflow fails on the older image.', 'Create is confirmed through event list; no meeting-notification parity claim.'], { liveTest: `${TEST}providers-advanced-live.mjs` }),
  provider('drive', ['GET /drive/v3/files', 'GET /drive/v3/files/{id}'], ['drive.file'], { googleapis: '178.0.0' }, sdkTests,
    ['Upload passes rootUrl per call and uses a transport-level local-origin guard.', 'Docs and Sheets APIs are not supported.']),
  provider('notion', ['POST /v1/search', 'GET /v1/pages/{id}', 'GET /v1/blocks/{id}/children'], ['notion.note', 'notion.webhook-capture'], { '@notionhq/client': '5.26.0' }, [...sdkTests, ...advancedTests],
    ['REST version 2026-03-11 only.', 'Webhook subscription controls are Workbench-only local controls; external delivery is disabled.']),
  provider('notion-mcp', ['GET /.well-known/oauth-protected-resource/mcp', 'GET /.well-known/oauth-authorization-server', 'POST /mcp initialize', 'POST /mcp tools/list'], ['notion-mcp.connect', 'notion-mcp.page'], { transport: 'JSON-RPC / OAuth PKCE S256', protocol: '2025-11-25' }, advancedTests,
    ['Consent is explicit. REST tokens cannot be used as MCP tokens.', 'Page creation is read back with the official REST SDK; hosted tool-result parity is not proved.'], { liveTest: `${TEST}providers-advanced-live.mjs` }),
  provider('notion-admin', ['GET /admin/v1/legal_holds'], [], null, advancedTests,
    ['Read-only legal-hold inventory, not all 39 Admin operations.', 'Requires separate organization token and Notion-Version 2026-06-01.'], { liveTest: `${TEST}providers-advanced-live.mjs` }),
  provider('notion-agent', ['POST /v1/agents/query', 'POST /v1/sessions/query', 'GET /v1/agents/{id}', 'GET /v1/sessions/{id}', 'POST /v1/sessions/{id}/events/query'], ['notion-agent.session'], { '@notionhq/client': '5.26.0' }, advancedTests,
    ['Agent responses are deterministic local results. No external AI model runs.', 'An active visible seeded Agent is required.'], { liveTest: `${TEST}providers-advanced-live.mjs` }),
  provider('stripe', ['GET /v1/customers', 'GET /v1/invoices', 'GET /v1/subscriptions'], ['stripe.draft'], { stripe: '22.6.1', apiVersion: '2026-08-26.dahlia' }, sdkTests,
    ['The app creates manual draft invoices only. It does not charge customers.', 'Refunds, taxes, disputes and broad production payment states are not supported.']),
  provider('linear', ['POST /graphql: issues and teams'], ['linear.issue'], { '@linear/sdk': '93.0.1', mode: 'public client.rawRequest with explicit fields' }, secondaryTests,
    ['Generated SDK model queries request unsupported fields such as Team.ledInitiativeCount.', 'Only the named issue/team fields and create/readback mutation are tested.']),
  provider('resend', ['GET /emails', 'GET /emails/{id}'], ['resend.send'], { resend: '6.26.0' }, secondaryTests,
    ['Public SDK resource methods use a guarded local transport.', 'No external delivery, current global Contacts API or outbound webhook claim.']),
  provider('twilio', ['GET /2010-04-01/Accounts/{sid}/Messages.json', 'GET /2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json'], ['twilio.send'], { twilio: '6.1.0' }, secondaryTests,
    ['Named Messaging methods only, at most 1000 messages and numbers.', 'Local SMS records do not mean carrier delivery.']),
  provider('clerk', ['GET /v1/users', 'GET /v1/organizations'], [], null, [`${TEST}providers.test.mjs`],
    ['First provider page only. App writes and official Clerk SDK methods are not tested.', 'No Clerk webhooks.']),
  provider('okta', ['GET /api/v1/users', 'GET /api/v1/groups'], [], null, [`${TEST}providers.test.mjs`],
    ['First provider page only. App writes and official Okta SDK methods are not tested.', 'Production SSWS authentication is not supported.']),
  provider('microsoft', ['GET /v1.0/me'], [], null, [`${TEST}oauth.test.mjs`],
    ['Local sign-in is tested separately. Graph list/write APIs are not supported.', 'No Teams, Outlook, OneDrive or SharePoint workflow.']),
  provider('apple', ['GET /.well-known/openid-configuration', 'GET /auth/keys'], [], null, [`${TEST}oauth.test.mjs`],
    ['Local sign-in is tested separately; client-secret and redirect checks differ from production.', 'No other Apple product APIs.']),
  provider('vercel', ['GET /v10/projects', 'GET /v6/deployments'], [], null, [`${TEST}providers.test.mjs`],
    ['First provider page only. Empty inventories are not deployment-execution proof.', 'No actual hosted build, domain verification, SDK or app-write coverage.']),
  provider('mongoatlas', ['GET /api/atlas/v2/groups', 'GET /api/atlas/v2/groups/{id}/clusters'], [], null, [`${TEST}providers.test.mjs`],
    ['First provider page only. This is Admin metadata, not a MongoDB wire database.', 'Retired Data API is not used. Production authentication and SDK parity are not proved.']),
  provider('s3', ['ListObjectsV2 in generated S3_BUCKET', 'GetObject'], ['s3.put'], { '@aws-sdk/client-s3': '3.1127.0' }, sdkTests,
    ['Path-style endpoint and generated bucket required. Bytes are read back after put.', 'Bucket discovery, multipart, versioning and notifications are not app coverage.']),
  provider('mail', ['IMAP LOGIN, SELECT INBOX, FETCH envelope, SEARCH Message-ID'], ['mail.send'], { imapflow: '1.7.8', nodemailer: '10.0.0' }, [`${TEST}providers.test.mjs`],
    ['Last 100 inbox messages only. Send targets the generated local inbox.', 'No TLS, SMTP AUTH, external relay or mail webhooks.']),
  provider('http', ['GET root and discovered local paths', 'RSS 2.0 parsing and stable GUID readback', 'Repeated stable/failing/flapping probes', 'GET paths from the advertised OpenAPI document'], [], null, [`${TEST}providers-http.test.mjs`],
    ['At most 30 links and 20 OpenAPI paths. Probe sequence values are not exposed; checks prove sampled behavior classes.', 'Delayed RSS arrivals and reset timing require separate lifecycle tests.', 'One hostname/listener, not multiple sites.'], { liveTest: `${TEST}providers-advanced-live.mjs` }),
];

export const UNIMPLEMENTED_WORKFLOWS = [
  { workflow: 'example-mcp.bridge', service: 'application', status: 'untested', supportLabel: 'Supported but partial', scope: 'The standalone examples/mcp-server server is not connected to Account Desk.', tests: ['examples/real-container.test.mjs'], reason: 'Notion MCP coverage does not prove integration with the separate seven-tool application MCP example.' },
  { workflow: 'notion-workers.app-adapter', service: 'notion', status: 'unsupported', supportLabel: 'Supported but partial', scope: 'Provider-local Worker adapter exists, but Account Desk cannot invoke it through the installed public package.', tests: ['emulators/emulate/src/vendors/notion/notion-workers.test.mjs'], reason: 'No public installed-package Worker runtime interface. Do not import private repository code or invent an HTTP route.' },
  { workflow: 'notion.webhook-network-delivery', service: 'notion', status: 'unsupported', supportLabel: 'Not supported', tests: ['emulators/emulate/src/vendors/notion/notion-webhooks.test.mjs'], reason: 'Only signed local capture is implemented. No external callback is sent.' },
  { workflow: 'aws.iam-sqs-sts', service: 'aws', status: 'unsupported', supportLabel: 'Not supported', tests: ['runtime/src/resolve.test.mjs'], reason: 'The resolver rejects the conflicting AWS listener. S3 uses the separate SeaweedFS service.' },
  { workflow: 'http.delayed-rss-arrival', service: 'http', status: 'untested', supportLabel: 'Supported but partial', tests: ['emulators/http-targets/test/feed-clock.test.mjs'], reason: 'Provider clock tests exist. Account Desk has not yet proved timed arrivals through the installed-package workflow.' },
];

export const WORKFLOW_COVERAGE = PROVIDER_COVERAGE.flatMap(entry => [
  { workflow: `${entry.service}.read`, service: entry.service, status: entry.readStatus, operations: entry.readOperations, tests: entry.tests, testedSDKVersion: entry.testedSDKVersion, productionVerified: false },
  ...entry.actionIds.map(action => ({ workflow: action, actionId: action, service: entry.service, status: entry.actionStatus[action], tests: entry.tests, testedSDKVersion: entry.testedSDKVersion, productionVerified: false })),
]).concat(UNIMPLEMENTED_WORKFLOWS);
