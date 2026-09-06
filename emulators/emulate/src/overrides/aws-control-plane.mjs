// SeaweedFS owns S3. Register only the pinned AWS plugin's IAM, SQS and STS
// Query routes; its bucket routes and sample seed never enter this service.
const ENDPOINTS = new Map([["/iam/", "iam"], ["/sqs/", "sqs"], ["/sts/", "sts"]]);
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all", "on"]);

// The pinned provider fixes its internal account and new-queue region. Keep
// those implementation values behind a reversible protocol adapter. Only ARN,
// account and QueueUrl fields are translated; authored policies/message bodies
// remain untouched. The normal seed config restores this mapping on each boot.
const UPSTREAM_ACCOUNT = "123456789012";
const identities = new WeakMap();
function configuredIdentity(store, handler) {
  return async (context, next) => {
    const identity = identities.get(store);
    if (!identity) throw new Error("AWS world identity was not seeded");
    const body = new URLSearchParams(await context.req.raw.clone().text());
    const queueUrl = body.get("QueueUrl");
    const publicPrefix = `${identity.baseUrl}/sqs/${identity.accountId}/`;
    const internalPrefix = `${identity.baseUrl}/sqs/${UPSTREAM_ACCOUNT}/`;
    if (queueUrl) {
      if (!queueUrl.startsWith(publicPrefix)) return context.text(
        '<ErrorResponse><Error><Code>InvalidAddress</Code><Message>QueueUrl does not belong to this world.</Message></Error></ErrorResponse>',
        400, { "Content-Type": "application/xml" });
      body.set("QueueUrl", internalPrefix + queueUrl.slice(publicPrefix.length));
      context.req.raw = new Request(context.req.raw, { body: body.toString() });
    }
    const response = await handler(context, next);
    const xml = await response.text();
    const translated = xml
      .replace(/<Account>123456789012<\/Account>/g, `<Account>${identity.accountId}</Account>`)
      .replace(/<(Arn|Value)>(arn:aws:(?:iam|sqs|sts):)([^:]*):123456789012:([^<]*)<\/\1>/g,
        (_match, tag, prefix, region, resource) => `<${tag}>${prefix}${prefix.includes(":sqs:") ? identity.region : region}:${identity.accountId}:${resource}</${tag}>`)
      .replace(/<QueueUrl>([^<]*)<\/QueueUrl>/g, (match, value) => value.startsWith(internalPrefix)
        ? `<QueueUrl>${publicPrefix}${value.slice(internalPrefix.length)}</QueueUrl>` : match);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(translated, { status: response.status, headers });
  };
}

function authenticate(domain, tokens) {
  return async (context, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(context.req.header("Authorization") ?? "")?.[1];
    const subject = token ? tokens?.get(token) : null;
    const scopes = subject?.scopes ?? [];
    if (!subject || !scopes.some(scope => scope === `${domain}:*` || scope === "*")) {
      return context.text('<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>A current WorldFixture AWS token is required.</Message></Error></ErrorResponse>',
        403, { "Content-Type": "application/xml" });
    }
    return next();
  };
}

export function awsControlPlanePlugin(upstream) {
  return {
    ...upstream,
    seed: undefined,
    register(app, store, webhooks, baseUrl, tokens) {
      const installed = new Set();
      const registration = new Proxy(app, {
        get(_target, method) {
          if (!METHODS.has(method)) throw new Error(`Unsupported AWS route registration: ${String(method)}`);
          return (...args) => {
            const methods = method === "on" ? [args.shift()].flat().map(value => String(value).toLowerCase()) : [method];
            const [path, ...handlers] = args;
            const domain = ENDPOINTS.get(path);
            if (domain && methods.includes("post")) {
              if (installed.has(path)) throw new Error(`Duplicate AWS Query route: ${path}`);
              if (handlers.length !== 1) throw new Error(`Unsupported AWS Query handler chain: ${path}`);
              app.post(path, authenticate(domain, tokens), configuredIdentity(store, handlers[0]));
              installed.add(path);
            }
            return registration;
          };
        },
      });
      upstream.register(registration, store, webhooks, baseUrl, tokens);
      if (installed.size !== ENDPOINTS.size) throw new Error("The AWS plugin does not expose all required Query routes");
    },
  };
}

export function seedAwsControlPlane(seedFromConfig, store, baseUrl, config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("AWS config must be an object");
  const accountId = config.account_id;
  if (!/^\d{12}$/.test(accountId)) throw new Error("AWS account_id must contain exactly 12 digits");
  const region = config.region;
  if (typeof region !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) throw new Error("AWS region is invalid");
  for (const section of ["iam", "sqs"]) if (Object.hasOwn(config, section) && (!config[section] || typeof config[section] !== "object" || Array.isArray(config[section]))) throw new Error(`AWS ${section} must be an object when declared`);
  identities.set(store, { accountId, region, baseUrl: baseUrl.replace(/\/$/, "") });
  seedFromConfig(store, baseUrl, {
    region,
    ...(Object.hasOwn(config, "iam") ? { iam: config.iam } : {}),
    ...(Object.hasOwn(config, "sqs") ? { sqs: config.sqs } : {}),
  });
}
