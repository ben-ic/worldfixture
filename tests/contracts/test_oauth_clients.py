"""OAuth declarations must match the actual provider seed and route contracts."""
from __future__ import annotations

import base64
import copy
import unittest
from pathlib import Path
from unittest.mock import patch

from worldfixture_compiler.compiler import WorldError, canonical_json, compile_world, load_world, validate_world
from worldfixture_compiler.oauth import CLIENT_COLLECTIONS, GRANTS, oauth_projection

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFUYNOpLIIaS9d0MmHHvYP8H9M9of
98mdPrPxU+DeIDWf4/YJjT3731nUSmqTUmcbydo/J1hlz+oo/S+opkz88w==
-----END PUBLIC KEY-----"""


def client(identity="authored-client", **extra):
    return {"client_id": identity, "name": "Authored application", "redirect_uris": ["http://localhost:8123/callback?name=authored"], **extra}


def world(provider="google", rows=None):
    return {"id": "oauth-fixture", "version": "v1", "software": {"oauth_clients": {provider: [client()] if rows is None else rows}}}


class OAuthClientsTest(unittest.TestCase):
    def test_all_native_collections_and_supported_grants(self):
        for provider, key in CLIENT_COLLECTIONS.items():
            with self.subTest(provider=provider):
                source = world(provider, [client(grant_types=sorted(GRANTS[provider]))])
                before = copy.deepcopy(source)
                projection = oauth_projection(source)[provider]
                row = projection[key][0]
                self.assertEqual(f"oauth-client-secret:{provider}:authored-client", row["client_secret_ref"])
                self.assertEqual(source["software"]["oauth_clients"][provider][0]["redirect_uris"], row["redirect_uris"])
                self.assertEqual(row, projection["worldfixture_oauth_client"])
                self.assertNotIn("client_secret", row)
                self.assertEqual(before, source)
                projection[key][0]["redirect_uris"].append("http://changed.test/callback")
                self.assertEqual(before, source)
                self.assertEqual(1, len(projection["worldfixture_oauth_client"]["redirect_uris"]))

    def test_absent_and_explicit_empty_are_authoritative(self):
        self.assertEqual({}, oauth_projection({"id": "none", "version": "v1"}))
        self.assertEqual({}, oauth_projection({"id": "none", "version": "v1", "software": {"oauth_clients": {}}}))
        for provider, key in CLIENT_COLLECTIONS.items():
            self.assertEqual({provider: {key: []}}, oauth_projection(world(provider, [])))

    def test_shipped_worlds_without_declarations_preserve_complete_compiled_bytes(self):
        for name in ["business.saas-company.v2", "consumer.retail-brand.v1"]:
            with self.subTest(world=name):
                source, _ = load_world(ROOT / "worlds" / name / "world.json")
                self.assertNotIn("oauth_clients", source.get("software", {}))
                compiled = canonical_json(compile_world(source))
                with patch("worldfixture_compiler.compiler.oauth_projection", return_value={}):
                    self.assertEqual(compiled, canonical_json(compile_world(source)))

    def test_selection_requires_unique_or_one_explicit_primary(self):
        rows = [client("first"), client("second")]
        self.assertNotIn("worldfixture_oauth_client", oauth_projection(world(rows=rows))["google"])
        rows[1]["primary"] = True
        self.assertEqual("second", oauth_projection(world(rows=rows))["google"]["worldfixture_oauth_client"]["client_id"])
        rows[0]["primary"] = True
        with self.assertRaisesRegex(ValueError, "more than one primary"):
            oauth_projection(world(rows=rows))
        for rows in [[client(), client()], [client("a", id="same"), client("b", id="same")]]:
            with self.assertRaisesRegex(ValueError, "duplicate"):
                oauth_projection(world(rows=rows))

    def test_references_remain_unique_for_punctuation_and_cross_provider_ids(self):
        source = world()
        source["software"]["oauth_clients"] = {provider: [client("client-a"), client("client_a"), client("client:a")] for provider in CLIENT_COLLECTIONS}
        result = oauth_projection(source)
        refs = [row["client_secret_ref"] for provider, projection in result.items() for row in projection[CLIENT_COLLECTIONS[provider]]]
        self.assertEqual(27, len(set(refs)))
        for value in ["oauth-client-secret:google:other", "fixed-shared-secret", "oauth-client-secret:github:authored-client", None]:
            with self.assertRaisesRegex(ValueError, "invalid client_secret_ref"):
                oauth_projection(world(rows=[client(client_secret_ref=value)]))

    def test_plaintext_secrets_are_rejected_even_empty_or_public(self):
        for provider, extra in [("google", {}), ("clerk", {"is_public": True}), ("okta", {"token_endpoint_auth_method": "none"})]:
            for secret in ["a-private-value", "", None]:
                with self.assertRaisesRegex(ValueError, "not client_secret") as failure:
                    oauth_projection(world(provider, [client(client_secret=secret, **extra)]))
                self.assertNotIn("a-private-value", str(failure.exception))

    def test_exact_redirect_validation(self):
        bad = [[], ["http://host.test/*"], ["https://host.test/cb#"], ["https://host.test/cb#data"], ["https://host.test/cb", "https://host.test/cb"], ["javascript:alert(1)"], ["https://"], ["http://[malformed/cb"], ["http://host.test:invalid/cb"], ["http://user:password@host.test/cb"], ["https://host.test/cb\n"], [" https://host.test/cb"], [None], [{}]]
        for redirects in bad:
            with self.subTest(redirects=redirects), self.assertRaisesRegex(ValueError, "oauth-fixture:v1 software.oauth_clients google/authored-client"):
                oauth_projection(world(rows=[client(redirect_uris=redirects)]))

    def test_loopback_redirect_templates_fix_the_host_path_and_query(self):
        for uri in ["http://127.0.0.1/callback", "http://[::1]/callback?provider=google", "http://localhost/oauth/google/callback"]:
            row = client(loopback_redirect_uris=[uri], allow_runtime_redirects=True)
            self.assertEqual([uri], oauth_projection(world(rows=[row]))["google"]["oauth_clients"][0]["loopback_redirect_uris"])
        for uri in ["https://127.0.0.1/callback", "http://127.0.0.1:3000/callback", "http://0.0.0.0/callback", "http://127.0.0.1/callback#fragment", "http://user@127.0.0.1/callback", "http://localhost:3000/callback", "http://127.0.0.1/*"]:
            with self.subTest(uri=uri), self.assertRaisesRegex(ValueError, "loopback_redirect_uris"):
                oauth_projection(world(rows=[client(loopback_redirect_uris=[uri])]))
        for mutation in [{"loopback_redirect_uris": "http://127.0.0.1/callback"}, {"allow_runtime_redirects": "yes"}]:
            with self.assertRaises(ValueError):
                oauth_projection(world(rows=[client(**mutation)]))

    def test_unsupported_grants_and_response_modes_fail_for_every_provider(self):
        for provider in CLIENT_COLLECTIONS:
            for extra in [{"grant_types": ["password"]}, {"grant_types": []}, {"grant_types": ["authorization_code", "authorization_code"]}, {"grant_types": [{}]}, {"grant_types": "authorization_code"}, {"response_types": ["token"]}, {"response_types": ["code", "id_token"]}]:
                with self.subTest(provider=provider, extra=extra), self.assertRaises(ValueError):
                    oauth_projection(world(provider, [client(**extra)]))

    def test_supported_public_clients_have_no_secret_and_cannot_get_app_grants(self):
        for provider, extra in [("clerk", {"is_public": True}), ("okta", {"token_endpoint_auth_method": "none"})]:
            row = oauth_projection(world(provider, [client(**extra)]))[provider][CLIENT_COLLECTIONS[provider]][0]
            self.assertNotIn("client_secret_ref", row)
            for mutation in [{"grant_types": ["client_credentials"]}, {"client_secret_ref": "unused"}, {"public_key": PUBLIC_KEY}]:
                with self.assertRaises(ValueError):
                    oauth_projection(world(provider, [client(**extra, **mutation)]))
        for provider in CLIENT_COLLECTIONS:
            if provider != "clerk":
                with self.subTest(provider=provider), self.assertRaisesRegex(ValueError, "does not support is_public"):
                    oauth_projection(world(provider, [client(is_public=True)]))
            for method in ["private_key_jwt", "client_secret_jwt", {}, []]:
                with self.assertRaisesRegex(ValueError, "unsupported token_endpoint_auth_method"):
                    oauth_projection(world(provider, [client(token_endpoint_auth_method=method)]))

    def test_confidential_native_auth_methods(self):
        for provider in CLIENT_COLLECTIONS:
            oauth_projection(world(provider, [client(token_endpoint_auth_method="client_secret_post")]))
            if provider in {"google", "github", "vercel"}:
                with self.assertRaises(ValueError):
                    oauth_projection(world(provider, [client(token_endpoint_auth_method="client_secret_basic")]))
            else:
                oauth_projection(world(provider, [client(token_endpoint_auth_method="client_secret_basic")]))

    def test_apple_signing_key_is_p256_with_source_metadata(self):
        apple = client(public_key=PUBLIC_KEY, team_id="AUTHOREDTEAM", key_id="AUTHOREDKEY")
        projection = oauth_projection(world("apple", [apple]))["apple"]["oauth_clients"][0]
        self.assertNotIn("client_secret_ref", projection)
        for provider in set(CLIENT_COLLECTIONS) - {"apple"}:
            with self.assertRaisesRegex(ValueError, "public_key is supported only for Apple"):
                oauth_projection(world(provider, [apple]))
        malformed_point = bytearray(base64.b64decode("".join(PUBLIC_KEY.splitlines()[1:-1])))
        malformed_point[-1] ^= 1
        invalid_key = "-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(malformed_point).decode() + "\n-----END PUBLIC KEY-----"
        for mutation in [{"public_key": "not a key"}, {"public_key": invalid_key}, {"public_key": ""}, {"team_id": ""}, {"key_id": None}, {"public_key_ref": "a-key"}, {"client_secret_ref": "a-secret"}]:
            with self.subTest(mutation=list(mutation)), self.assertRaises(ValueError):
                oauth_projection(world("apple", [{**apple, **mutation}]))

    def test_linear_user_actor_and_okta_server_are_exact(self):
        oauth_projection(world("linear", [client(actor="user", assignable=False, mentionable=False)]))
        for extra in [{"actor": "app"}, {"assignable": True}, {"mentionable": True}, {"assignable": "false"}]:
            with self.assertRaisesRegex(ValueError, "without app users"):
                oauth_projection(world("linear", [client(**extra)]))
        for server in ["org", "default", "authored-server"]:
            oauth_projection(world("okta", [client(auth_server_id=server)]))
        for server in ["", None, "a/b", "a%2Fb", "a?query"]:
            with self.assertRaisesRegex(ValueError, "Okta auth_server_id"):
                oauth_projection(world("okta", [client(auth_server_id=server)]))

    def test_malformed_declarations_raise_context_errors_without_type_errors(self):
        for row in [None, [], {}, client(name=None), client(client_id="bad\nID"), client(primary="yes"), client(is_public=1), client(scopes=[{}]), client(scopes=["one two"]), client(scopes=["same", "same"]), client(user_scopes=["users:read"])]:
            with self.subTest(row=row), self.assertRaisesRegex(ValueError, "world oauth-fixture:v1 software.oauth_clients"):
                oauth_projection(world(rows=[row]))
        for policy in [[], None, "clients", {"unknown": []}, {"google": {}}]:
            source = world()
            source["software"]["oauth_clients"] = policy
            with self.assertRaises(ValueError):
                oauth_projection(source)

    def test_real_compile_rejects_bad_clients_and_keeps_good_native_projection(self):
        source, _ = load_world(ROOT / "worlds/business.saas-company.v2/world.json")
        source["software"]["oauth_clients"] = {"linear": [client(actor="app")]}
        with self.assertRaisesRegex(WorldError, "software.oauth_clients linear/authored-client"):
            validate_world(source)
        source["software"]["oauth_clients"] = {"google": [client()], "slack": []}
        result = compile_world(source)["projections"]["emulator-overlay"]
        self.assertEqual("authored-client", result["google"]["worldfixture_oauth_client"]["client_id"])
        self.assertEqual([], result["slack"]["oauth_apps"])
        self.assertNotIn("worldfixture_oauth_client", result["slack"])
        self.assertEqual(canonical_json(compile_world(source)), canonical_json(compile_world(source)))


if __name__ == "__main__":
    unittest.main()
