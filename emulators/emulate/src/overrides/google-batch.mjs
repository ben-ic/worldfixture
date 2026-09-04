// Gmail's batch endpoint is a transport wrapper around ordinary Gmail API calls.
// Keep the vendor implementation as the one route owner: this adapter only parses
// the bounded multipart envelope, calls the existing handler, and writes the
// multipart response required by Google clients.

const BATCH_PATH = "/batch/gmail/v1";
const MAX_PARTS = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const CONCURRENCY = 10;

function boundaryFrom(contentType) {
  if (typeof contentType !== "string") return null;
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  return boundary && /^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(boundary) ? boundary : null;
}

function parseParts(body, boundary) {
  const records = [];
  for (const raw of body.split(`--${boundary}`).slice(1)) {
    const part = raw.replace(/^\r?\n/, "");
    if (part.startsWith("--")) break;
    if (!part.trim()) continue;

    const separator = part.search(/\r?\n\r?\n/);
    if (separator < 0) throw new Error("batch part has no request");
    const requestBlock = part.slice(separator).replace(/^\r?\n\r?\n/, "");
    const requestLine = requestBlock.split(/\r?\n/, 1)[0];
    const match = requestLine.match(/^GET (\/gmail\/v1\/[^\s]*)(?: HTTP\/1\.[01])?$/);
    if (!match) throw new Error("batch part must be one relative Gmail GET request");
    records.push(match[1]);
    if (records.length > MAX_PARTS) throw new Error("batch has more than 100 requests");
  }
  if (records.length === 0) throw new Error("batch has no requests");
  return records;
}

async function mapBounded(items, operation) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  }));
  return results;
}

function multipartResponse(parts) {
  const boundary = `worldfixture_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  const body = parts.map(({ response, body }, index) => {
    const contentType = response.headers.get("content-type") ?? "application/json; charset=utf-8";
    return [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: response-${index + 1}`,
      "",
      `HTTP/1.1 ${response.status} ${response.statusText || "OK"}`,
      `Content-Type: ${contentType}`,
      "",
      body,
    ].join("\r\n");
  });
  body.push(`--${boundary}--`);
  return new Response(body.join("\r\n"), {
    status: 200,
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
  });
}

export function wrapGoogleBatch(inner) {
  return async function fetchWithGmailBatch(request, ...rest) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== BATCH_PATH) {
      return inner(request, ...rest);
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: "batch body is too large" }, { status: 413 });
    }
    const boundary = boundaryFrom(request.headers.get("content-type"));
    if (!boundary) {
      return Response.json({ error: "batch boundary is missing or invalid" }, { status: 400 });
    }

    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: "batch body is too large" }, { status: 413 });
    }

    let targets;
    try {
      targets = parseParts(body, boundary);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    const parts = await mapBounded(targets, async (target) => {
      const headers = new Headers();
      const authorization = request.headers.get("authorization");
      if (authorization) headers.set("authorization", authorization);
      const response = await inner(new Request(new URL(target, url.origin), { headers }), ...rest);
      return { response, body: await response.text() };
    });
    return multipartResponse(parts);
  };
}
