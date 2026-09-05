// Stripe, Resend and Atlas resource routes never read authUser; Linear can
// fall back to an admin. Removing a fixed token alone still permits access.
// Linear OAuth and the outer aggregate readiness endpoint stay outside this
// boundary. This checks credentials, not production provider authorization.
export function withApiKeyAuth(inner, { vendor, tokenMap, isKnownToken }) {
  if (!["stripe", "resend", "mongoatlas", "linear"].includes(vendor)) return inner;
  return (request, ...rest) => {
    // Linear's currentUser otherwise falls back to the first admin. Its OAuth
    // endpoints remain public; API-created and OAuth-issued tokens still pass
    // through upstream's expiry, revocation and scope checks.
    if (vendor === "linear" && !/^\/graphql\/?$/.test(new URL(request.url).pathname)) return inner(request, ...rest);
    const header = request.headers.get("authorization") ?? "";
    let token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (vendor === "linear") token ??= header;
    if (vendor === "stripe" && /^Basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      if (decoded.endsWith(":")) token = decoded.slice(0, -1);
    }
    if (vendor === "mongoatlas") token ??= request.headers.get("api-key");
    if (!token || !(tokenMap.has(token) || isKnownToken?.(token))) {
      if (vendor === "linear") return Response.json({ errors: [{ message: "Authentication required", extensions: { code: "UNAUTHENTICATED" } }] }, { status: 401 });
      const body = vendor === "stripe"
        ? { error: { type: "authentication_error", message: "Invalid API key" } }
        : vendor === "resend"
          ? { statusCode: 401, name: "authentication_error", message: "Invalid API key" }
          : { error: 401, errorCode: "UNAUTHORIZED", reason: "Unauthorized" };
      return Response.json(body, { status: 401 });
    }
    return inner(request, ...rest);
  };
}
