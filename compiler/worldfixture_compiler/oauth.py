"""Declared OAuth clients and secret references for normal provider seeding."""
from __future__ import annotations

import base64
import copy
from urllib.parse import urlsplit

CLIENT_COLLECTIONS = {
    "apple": "oauth_clients", "clerk": "oauth_applications", "okta": "oauth_clients",
    "google": "oauth_clients", "microsoft": "oauth_clients", "github": "oauth_apps",
    "slack": "oauth_apps", "linear": "oauth_apps", "vercel": "integrations",
}
GRANTS = {
    "apple": {"authorization_code", "refresh_token"}, "clerk": {"authorization_code"},
    "okta": {"authorization_code", "refresh_token", "client_credentials"},
    "google": {"authorization_code", "refresh_token"},
    "microsoft": {"authorization_code", "refresh_token", "client_credentials"},
    "github": {"authorization_code"}, "slack": {"authorization_code"},
    "linear": {"authorization_code", "refresh_token"}, "vercel": {"authorization_code"},
}
BASIC_PROVIDERS = {"apple", "clerk", "okta", "microsoft", "slack", "linear"}


def _nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and not any(ord(c) < 32 for c in value)


def _apple_public_key(value: object) -> bool:
    """Check a PEM P-256 SPKI, including the encoded public point, without extra dependencies."""
    if not isinstance(value, str):
        return False
    lines = value.strip().splitlines()
    if len(lines) < 3 or lines[0] != "-----BEGIN PUBLIC KEY-----" or lines[-1] != "-----END PUBLIC KEY-----":
        return False
    try:
        der = base64.b64decode("".join(lines[1:-1]), validate=True)
    except ValueError:
        return False
    # id-ecPublicKey + prime256v1 AlgorithmIdentifier, followed by a BIT STRING.
    algorithm = bytes.fromhex("301306072a8648ce3d020106082a8648ce3d030107")
    if len(der) not in {59, 91} or der[:2] != bytes([0x30, len(der) - 2]) or der[2:23] != algorithm:
        return False
    if der[23:26] != bytes([0x03, len(der) - 25, 0]):
        return False
    point = der[26:]
    prime = 2**256 - 2**224 + 2**192 + 2**96 - 1
    coefficient = int("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    x = int.from_bytes(point[1:33], "big")
    if x >= prime:
        return False
    squared_y = (x**3 - 3*x + coefficient) % prime
    if len(point) == 65 and point[0] == 4:
        y = int.from_bytes(point[33:], "big")
        return y < prime and y*y % prime == squared_y
    return len(point) == 33 and point[0] in {2, 3} and pow(squared_y, (prime - 1)//2, prime) == 1


def oauth_projection(world: dict) -> dict:
    policy = world.get("software", {}).get("oauth_clients", {})
    context = f"world {world['id']}:{world['version']} software.oauth_clients"

    def require(condition: bool, message: str) -> None:
        if not condition:
            raise ValueError(f"{context} {message}")

    require(isinstance(policy, dict), "must be an object keyed by provider")
    result, references = {}, set()
    for provider, rows in policy.items():
        require(provider in CLIENT_COLLECTIONS, f"has unsupported provider {provider!r}")
        require(isinstance(rows, list), f"{provider} must be an array")
        clients, ids, native_ids = [], set(), set()
        for source in rows:
            require(isinstance(source, dict), f"{provider} client must be an object")
            client = copy.deepcopy(source)
            identity = client.get("client_id")
            require(_nonempty(identity), f"{provider} client_id must be a nonempty string without control characters")
            label = f"{provider}/{identity}"
            require(identity not in ids, f"{provider} has duplicate client_id {identity!r}")
            ids.add(identity)
            if "id" in client:
                require(_nonempty(client["id"]), f"{label} id must be a nonempty string")
                require(client["id"] not in native_ids, f"{provider} has duplicate native id {client['id']!r}")
                native_ids.add(client["id"])
            require(_nonempty(client.get("name")), f"{label} needs a declared name")
            require("client_secret" not in client, f"{label} must use a generated secret reference, not client_secret")
            require(isinstance(client.get("primary", False), bool), f"{label} primary must be a boolean")
            require(isinstance(client.get("is_public", False), bool), f"{label} is_public must be a boolean")
            require(not client.get("is_public") or provider == "clerk", f"{label} does not support is_public")
            method = client.get("token_endpoint_auth_method")
            public = provider == "clerk" and client.get("is_public") is True or provider == "okta" and method == "none"
            allowed_methods = {"client_secret_post"} | ({"client_secret_basic"} if provider in BASIC_PROVIDERS else set())
            if public:
                allowed_methods = {"none"}
            require(method is None or isinstance(method, str) and method in allowed_methods, f"{label} has an unsupported token_endpoint_auth_method")
            require(not public or not client.get("public_key"), f"{label} public clients cannot use public_key")
            require("public_key_ref" not in client, f"{label} must declare an Apple public_key, not public_key_ref")
            if "public_key" in client:
                require(provider == "apple", f"{label} public_key is supported only for Apple")
                require(_apple_public_key(client["public_key"]), f"{label} public_key must be a valid PEM P-256 public key")
                require(_nonempty(client.get("team_id")) and _nonempty(client.get("key_id")), f"{label} public_key needs team_id and key_id")
            if not public and "public_key" not in client:
                reference = f"oauth-client-secret:{provider}:{identity}"
                require(client.get("client_secret_ref", reference) == reference, f"{label} has an invalid client_secret_ref")
                require(reference not in references, f"{label} has a duplicate client_secret_ref")
                references.add(reference)
                client["client_secret_ref"] = reference
            else:
                require("client_secret_ref" not in client, f"{label} does not use a shared client secret")
            redirects = client.get("redirect_uris")
            require(isinstance(redirects, list) and bool(redirects), f"{label} needs redirect_uris")
            for uri in redirects:
                require(_nonempty(uri) and not any(c.isspace() for c in uri), f"{label} redirect_uris must contain exact URL strings")
                try:
                    parsed = urlsplit(uri)
                    port = parsed.port
                    valid = parsed.scheme in {"http", "https"} and bool(parsed.hostname) and not parsed.fragment and "#" not in uri and "*" not in uri and not parsed.username and not parsed.password and (port is None or port > 0)
                except ValueError:
                    valid = False
                require(valid, f"{label} redirect URI must be an exact HTTP(S) URL without a fragment or user credentials")
            require(len(set(redirects)) == len(redirects), f"{label} has duplicate redirect URIs")
            if "grant_types" in client:
                grants = client["grant_types"]
                allowed = GRANTS[provider] - ({"client_credentials"} if public else set())
                require(isinstance(grants, list) and bool(grants) and all(isinstance(grant, str) and grant in allowed for grant in grants), f"{label} has an unsupported grant type")
                require(len(grants) == len(set(grants)), f"{label} has duplicate grant types")
            if "response_types" in client:
                require(client["response_types"] == ["code"], f"{label} supports only response_types ['code']")
            for field in ["scopes", "user_scopes"]:
                if field in client:
                    values = client[field]
                    require(field != "user_scopes" or provider == "slack", f"{label} user_scopes is supported only for Slack")
                    require(isinstance(values, list) and all(_nonempty(value) and not any(c.isspace() or c == ',' for c in value) for value in values), f"{label} {field} must be an array of scope strings")
                    require(len(values) == len(set(values)), f"{label} has duplicate {field}")
            if provider == "linear":
                require(client.get("actor", "user") == "user" and client.get("assignable", False) is False and client.get("mentionable", False) is False, f"{label} supports only the declared user actor without app users")
            elif any(field in client for field in ["actor", "assignable", "mentionable"]):
                require(False, f"{label} actor options are supported only for Linear")
            if "auth_server_id" in client:
                require(provider == "okta" and _nonempty(client["auth_server_id"]) and not any(c in client["auth_server_id"] for c in '/?#%'), f"{label} needs an exact Okta auth_server_id")
            clients.append(client)
        primary = [client for client in clients if client.get("primary")]
        require(len(primary) <= 1, f"{provider} has more than one primary client")
        selected = primary[0] if primary else clients[0] if len(clients) == 1 else None
        result[provider] = {CLIENT_COLLECTIONS[provider]: clients}
        if selected:
            result[provider]["worldfixture_oauth_client"] = copy.deepcopy(selected)
    return result
