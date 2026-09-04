// Make Google's ID token verifiable.
//
// THE BUG THIS FIXES, measured against 0.8.0 and again against 0.10.0 — unchanged in
// both. `@emulators/google` signs ID tokens HS256 with the hardcoded secret
// "emulate-google-jwt-secret", advertises `id_token_signing_alg_values_supported:
// ["HS256"]`, and serves `{"keys":[]}` from the `jwks_uri` its own discovery document
// points at. Neither verification path a compliant client can take succeeds: RS256
// finds no key, and HS256-with-client-secret uses a key the emulator does not have.
//
// So only a client that SKIPS ID-token verification appears to work — and a demo that
// "works" that way teaches a visitor the app's Google login is fine when nothing was
// checked at all. That is the one failure mode this whole product exists to not have.
//
// WHY A RESPONSE WRAPPER RATHER THAN A ROUTE.
//
// Replacing `POST /oauth2/token` outright would mean re-implementing the authorization
// code exchange — pending codes, PKCE, client authentication, refresh tokens — and
// every subtle divergence would surface as a login that fails at demo time. Their Hono
// gives middleware no way to read a downstream response (`next()` returns void and
// there is no `c.res`), but we own the `serve({fetch})` call, so the whole app's fetch
// can be wrapped from outside. The vendor keeps minting the token; we re-sign it.
//
// The key is generated for the session. The accepted private JWK is stored in the
// supervisor-owned snapshot, so reset returns the same JWKS during that session.
// A new session removes the snapshot and gets a new key.

import { SignJWT, jwtVerify, generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint } from "jose";

// Their secret, so we can verify what we are about to re-sign rather than trusting it.
const UPSTREAM_SECRET = new TextEncoder().encode("emulate-google-jwt-secret");

const JWKS_PATH = "/oauth2/v3/certs";
const DISCOVERY_PATH = "/.well-known/openid-configuration";
const TOKEN_PATH = "/oauth2/token";

export async function createGoogleSigningOverride({ privateJwk } = {}) {
  let privateKey;
  let savedPrivateJwk;
  let publicJwk;

  if (privateJwk) {
    privateKey = await importJWK(privateJwk, "RS256");
    savedPrivateJwk = privateJwk;
    publicJwk = { kty: privateJwk.kty, n: privateJwk.n, e: privateJwk.e };
  } else {
    const pair = await generateKeyPair("RS256", { extractable: true });
    privateKey = pair.privateKey;
    savedPrivateJwk = await exportJWK(pair.privateKey);
    publicJwk = await exportJWK(pair.publicKey);
  }
  const kid = await calculateJwkThumbprint(publicJwk);
  const jwks = { keys: [{ ...publicJwk, kid, use: "sig", alg: "RS256" }] };

  async function resign(token) {
    // `jwtVerify` without an audience or issuer check: we are re-signing what this
    // very process minted a millisecond ago, and the claims are copied verbatim.
    const { payload } = await jwtVerify(token, UPSTREAM_SECRET);
    const { iss, aud, exp, iat, ...claims } = payload;

    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(privateKey);
  }

  function wrapFetch(inner) {
    return async function fetchWithVerifiableSigning(request, ...rest) {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === JWKS_PATH) {
        return Response.json(jwks);
      }

      const response = await inner(request, ...rest);

      if (request.method === "GET" && url.pathname === DISCOVERY_PATH && response.ok) {
        const doc = await response.json();
        doc.id_token_signing_alg_values_supported = ["RS256"];
        return Response.json(doc);
      }

      // Only the token endpoint mints an ID token: Google's discovery advertises
      // `response_types_supported: ["code"]`, so there is no implicit flow to catch.
      if (request.method === "POST" && url.pathname === TOKEN_PATH && response.ok) {
        const body = await response.json();
        if (typeof body.id_token === "string") {
          body.id_token = await resign(body.id_token);
        }
        // Keep the access token that the provider issued. Current emulator.dev
        // versions add this token to `createServer`'s authentication map. If we
        // replace it with a seeded token, interactive OAuth silently becomes
        // pre-authorized access and reset cannot revoke the OAuth grant.
        return Response.json(body);
      }

      return response;
    };
  }

  // The private fixture key is part of the accepted session snapshot. Keeping
  // it makes a reset restore the same JWKS instead of changing identity while
  // the container is still the same instance.
  wrapFetch.privateJwk = savedPrivateJwk;
  return wrapFetch;
}
