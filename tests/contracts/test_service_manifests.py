"""The extracted services publish manifests that satisfy the public contract.

`schemas/service-manifest.v1.schema.json` is the contract the resolver, the
environment lock and the supervisor are all defined in terms of. Until this
slice no service had ever been described by it -- each shipped only the legacy
`emulator.json` from the original platform -- so the schema had never been
tested against a real service.

These tests keep the manifests valid and keep the two facts that the
schema cannot express from being quietly re-introduced as if it could:
`emulate` claims no `aws.s3.*` profile, and Cyrus and Gmail stay distinct
capability names. Both are facts about implementations rather than about the
contract, which is why they are asserted here and not in the schema.

The compiler has no third-party dependencies, so this module carries the small
subset of JSON Schema 2020-12 that the published schemas actually use rather
than requiring `jsonschema`.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "schemas/service-manifest.v1.schema.json"
SERVICES = ("emulate", "http-targets", "mail", "s3", "postgres", "mysql")

_JSON_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
}


def resolve(schema: dict, root: dict) -> dict:
    """Follow a local `$ref`. Only `#/$defs/<name>` is used by these schemas."""
    ref = schema.get("$ref")
    if not ref:
        return schema
    assert ref.startswith("#/"), ref
    target = root
    for part in ref[2:].split("/"):
        target = target[part]
    return target


def validate(instance, schema, path: str = "$", root: dict | None = None) -> list[str]:
    """Return every way `instance` fails `schema`. Empty means valid."""
    root = schema if root is None else root
    schema = resolve(schema, root)
    errors: list[str] = []

    if "oneOf" in schema:
        matched = [b for b in schema["oneOf"] if not validate(instance, b, path, root)]
        if len(matched) != 1:
            errors.append(f"{path}: matched {len(matched)} of {len(schema['oneOf'])} oneOf branches, need exactly 1")
        return errors

    declared = schema.get("type")
    if declared:
        if declared in ("integer", "number"):
            ok = isinstance(instance, int) and not isinstance(instance, bool)
        else:
            expected = _JSON_TYPES[declared]
            # `bool` is a subclass of `int`, and only `boolean` should accept one.
            ok = isinstance(instance, expected) and (declared == "boolean" or not isinstance(instance, bool))
        if not ok:
            return [f"{path}: expected {declared}, got {type(instance).__name__}"]

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected {schema['const']!r}, got {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} is not one of {schema['enum']}")
    if "pattern" in schema and isinstance(instance, str) and not re.search(schema["pattern"], instance):
        errors.append(f"{path}: {instance!r} does not match {schema['pattern']}")

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: missing required property {key!r}")
        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                errors.extend(validate(value, properties[key], f"{path}.{key}", root))

    if isinstance(instance, list):
        minimum = schema.get("minItems")
        if minimum is not None and len(instance) < minimum:
            errors.append(f"{path}: needs at least {minimum} items, has {len(instance)}")
        if "items" in schema:
            for index, item in enumerate(instance):
                errors.extend(validate(item, schema["items"], f"{path}[{index}]", root))

    return errors


def load_schema() -> dict:
    return json.loads(SCHEMA.read_text())


def load_manifest(service: str) -> dict:
    return json.loads((ROOT / "emulators" / service / "service.json").read_text())


def profiles(manifest: dict) -> set[str]:
    return {entry["profile"] for entry in manifest["provides"]}


class ServiceManifestTest(unittest.TestCase):
    def test_the_validator_rejects_what_the_schema_forbids(self) -> None:
        """A validator that passes everything would make every test below vacuous."""
        schema = load_schema()
        for name, mutate in (
            ("wrong api_version", lambda m: m.update(api_version="droplive.service/v1")),
            ("v-prefixed version", lambda m: m.update(version="v1.4.4")),
            ("two-part version", lambda m: m.update(version="4.41")),
            ("upper-case name", lambda m: m.update(name="Mail")),
            ("no provides", lambda m: m.update(provides=[])),
            ("unversioned profile", lambda m: m.update(provides=[{"profile": "slack.messaging"}])),
            ("mutable image tag", lambda m: m["runtime"].update(image="ghcr.io/example/mail:latest")),
            ("projection outside projections/", lambda m: m["world"].update(projection="mail.json")),
            ("readiness without a port", lambda m: m["runtime"].update(readiness={"path": "/readyz"})),
        ):
            with self.subTest(rejects=name):
                manifest = load_manifest("mail")
                mutate(manifest)
                self.assertTrue(validate(manifest, schema), f"{name} should not have validated")

    def test_the_revised_schema_still_accepts_the_original_draft_forms(self) -> None:
        """The schema was revised in place rather than forked to a v2, which is
        only defensible while every field it gained is optional. A manifest
        written against the first draft -- one readiness object, one projection
        string, no ports -- must still validate, or this was a breaking change
        wearing a v1 label."""
        original = {
            "api_version": "worldfixture.service/v1",
            "name": "slack",
            "version": "1.0.0",
            "runtime": {
                "image": "ghcr.io/example/slack@sha256:" + "0" * 64,
                "readiness": {"port": "api", "path": "/readyz"},
            },
            "provides": [{"profile": "slack.messaging.v1"}],
            "world": {"requires": ["identity.people.v1"], "projection": "projections/slack.json"},
            "events": {"produces": ["communication.message.sent.v1"]},
            "lifecycle": {"seed": True, "state": {"export": True, "format": "emulate-slack/v1"}},
            "ui": {"port": "api", "path": "/_worldfixture", "title": "Slack"},
        }
        self.assertEqual([], validate(original, load_schema()))

    def test_every_service_manifest_satisfies_the_published_schema(self) -> None:
        schema = load_schema()
        for service in SERVICES:
            with self.subTest(service=service):
                self.assertEqual([], validate(load_manifest(service), schema))

    def test_each_manifest_names_the_service_it_sits_beside(self) -> None:
        for service in SERVICES:
            with self.subTest(service=service):
                self.assertEqual(service, load_manifest(service)["name"])

    def test_each_declared_projection_exists_in_the_reference_artifact(self) -> None:
        """A projection a service names but the compiler does not emit is a
        service that cannot start, and nothing else reports it."""
        for service, entry in self.artifact_projections():
            with self.subTest(service=service, file=entry["file"]):
                self.assertTrue((self.artifact() / entry["file"]).is_file(), entry["file"])

    def test_each_declared_subtree_resolves_in_the_artifact(self) -> None:
        """`subtree` is how two services share one file without sharing state.
        A pointer that resolves to nothing means the split is imaginary."""
        for service, entry in self.artifact_projections():
            pointer = entry.get("subtree")
            if pointer is None:
                continue
            with self.subTest(service=service, file=entry["file"], subtree=pointer):
                document = json.loads((self.artifact() / entry["file"]).read_text())
                for part in pointer.lstrip("/").split("/"):
                    self.assertIsInstance(document, (dict, list), pointer)
                    if isinstance(document, list):
                        document = document[int(part)]
                    else:
                        self.assertIn(part, document, pointer)
                        document = document[part]

    def test_no_two_services_own_the_same_part_of_one_projection(self) -> None:
        """`projections/aws.json` is read by `s3` and carries `iam` and `sqs`
        for the composer's AWS vendor. Sharing a file is allowed; sharing a
        subtree would put one projection behind two owners."""
        owners: dict[str, list[tuple[str, str]]] = {}
        for service in SERVICES:
            for entry in load_manifest(service)["world"].get("projections", []):
                owners.setdefault(entry["file"], []).append((service, entry.get("subtree", "/")))
        for file, claims in owners.items():
            if len(claims) < 2:
                continue
            with self.subTest(file=file):
                for i, (service_a, subtree_a) in enumerate(claims):
                    for service_b, subtree_b in claims[i + 1:]:
                        overlap = subtree_a.startswith(subtree_b) or subtree_b.startswith(subtree_a)
                        self.assertFalse(
                            overlap,
                            f"{file}: {service_a} owns {subtree_a} and {service_b} owns {subtree_b}",
                        )

    def test_every_port_reference_names_a_declared_port(self) -> None:
        """The first draft of this schema let `readiness.port` and `ui.port`
        name a port nothing declared. They now have to resolve."""
        for service in SERVICES:
            manifest = load_manifest(service)
            declared = {port["name"] for port in manifest["runtime"]["ports"]}
            references = [("readiness", check["port"]) for check in manifest["runtime"]["readiness"]]
            references += [(entry["profile"], entry["port"]) for entry in manifest["provides"]]
            references += [(d["profile"], d["port"]) for d in manifest.get("disclaims", []) if "port" in d]
            if "ui" in manifest:
                references.append(("ui", manifest["ui"]["port"]))
            for where, port in references:
                with self.subTest(service=service, where=where, port=port):
                    self.assertIn(port, declared)

    def test_port_names_and_environment_variables_are_unique_per_service(self) -> None:
        """Two ports sharing an environment variable would silently collapse
        into one listener, which is the bug composing was meant to end."""
        for service in SERVICES:
            ports = load_manifest(service)["runtime"]["ports"]
            with self.subTest(service=service):
                names = [port["name"] for port in ports]
                variables = [port["env"] for port in ports]
                self.assertEqual(len(names), len(set(names)))
                self.assertEqual(len(variables), len(set(variables)))

    def test_every_service_declares_where_its_world_comes_from(self) -> None:
        for service in SERVICES:
            with self.subTest(service=service):
                sources = {v["from"] for v in load_manifest(service)["runtime"]["environment"]}
                self.assertIn("world.path", sources)

    # mail's `/readyz` on the health port and s3's `/worldfixture/ready` on the
    # filer port are both written once at startup by a shell entry point and
    # never revisited. Read from `worldfixture-entrypoint.sh` in each service.
    WRITE_ONCE_MARKERS = {
        ("mail", "health", "/readyz"),
        ("s3", "filer", "/worldfixture/ready"),
    }

    def test_a_write_once_marker_is_only_ever_a_seed_gate(self) -> None:
        """A marker reports a past event, so it can answer "did the world
        finish loading" and can never answer "is this answering now". Both
        questions are real; conflating them is how a dead service reports
        ready."""
        for service in SERVICES:
            for check in load_manifest(service)["runtime"]["readiness"]:
                marker = (service, check["port"], check.get("path"))
                with self.subTest(service=service, port=check["port"]):
                    if marker in self.WRITE_ONCE_MARKERS:
                        self.assertEqual("seed_gate", check["kind"])
                    else:
                        self.assertEqual("protocol", check["kind"])

    def test_every_http_protocol_check_compares_a_body_substring(self) -> None:
        """A status alone accepts a route the service never meant to serve.

        Every vendor behind the composer answers 404 with a JSON body, so
        `expect: "200"` on an HTTP protocol check passes against any path that
        happens to exist. That is not hypothetical: the composer's own declared
        check was Google's discovery document, which exists only on Google's
        listener, and it passed while proving nothing. A seed gate is
        different: it reports a past event on a private port and is allowed to
        be a status.

        Every substring here was measured against a running instance on
        2026-09-03, not chosen from a vendor's documentation.
        """
        for service in SERVICES:
            for check in load_manifest(service)["runtime"]["readiness"]:
                if check["kind"] != "protocol" or check["protocol"] not in ("http", "s3"):
                    continue
                with self.subTest(service=service, port=check["port"]):
                    self.assertNotRegex(
                        check["expect"],
                        r"^[1-5][0-9][0-9]$",
                        f"{service}/{check['port']} is proven by a status code alone",
                    )

    def test_the_composer_declares_a_protocol_check_for_every_vendor_it_can_start(self) -> None:
        """`/_worldfixture/ready` reports one line per started vendor and reads
        its checks out of this manifest. A vendor with a port and no check would
        make the endpoint answer "not ready" for a listener that is working, and
        a check for a vendor with no port would probe nothing.

        AWS is the deliberate exception in both directions: it keeps a port
        entry so the resolver can see and close it, and it must never gain a
        readiness check -- `emulators/emulate/src/ready.mjs` refuses to probe it
        and SeaweedFS stays the only S3 owner.
        """
        manifest = load_manifest("emulate")
        ports = {port["name"] for port in manifest["runtime"]["ports"]}
        checked = {check["port"] for check in manifest["runtime"]["readiness"] if check["kind"] == "protocol"}
        self.assertIn("aws", ports)
        self.assertNotIn("aws", checked)
        self.assertEqual(ports - {"aws"}, checked)

    def test_every_service_is_proven_by_at_least_one_live_protocol_check(self) -> None:
        """A service with only a seed gate cannot be aggregated on. This is the
        rule that keeps readiness off log output and off startup markers."""
        for service in SERVICES:
            with self.subTest(service=service):
                live = [c for c in load_manifest(service)["runtime"]["readiness"] if c["kind"] == "protocol"]
                self.assertTrue(live, f"{service} has no check that re-answers")

    def test_mail_is_proven_on_the_protocols_the_connected_flow_uses(self) -> None:
        """Priya reads what Maya sent over IMAP. A service ready by HTTP while
        IMAP is not listening would pass readiness and fail the flow."""
        checks = load_manifest("mail")["runtime"]["readiness"]
        live = {c["protocol"] for c in checks if c["kind"] == "protocol"}
        self.assertEqual({"smtp", "imap"}, live)

    def test_s3_is_proven_on_the_port_an_application_uses(self) -> None:
        """The filer document proves seeding finished; it sits on a port no
        application calls. Only the S3 port proves the surface under test."""
        checks = load_manifest("s3")["runtime"]["readiness"]
        live = {c["port"] for c in checks if c["kind"] == "protocol"}
        self.assertEqual({"s3"}, live)
        published = {p["name"] for p in load_manifest("s3")["runtime"]["ports"] if p.get("published")}
        self.assertEqual({"s3"}, published)

    def test_a_disclaimed_surface_is_never_also_provided(self) -> None:
        """A service cannot both claim and disown the same profile."""
        for service in SERVICES:
            manifest = load_manifest(service)
            disclaimed = {d["profile"] for d in manifest.get("disclaims", [])}
            with self.subTest(service=service):
                self.assertEqual(set(), disclaimed & profiles(manifest))

    def test_the_composer_disclaims_the_s3_surface_it_actually_serves(self) -> None:
        """Measured live: `@emulators/aws` answers PUT bucket, PUT object and
        GET object with 200, and self-seeds three buckets the world never
        declares. `provides` omitting it is not enough -- the resolver cannot
        see a route no manifest mentions, so the composer has to name it."""
        disclaimed = {d["profile"] for d in load_manifest("emulate")["disclaims"]}
        owned = profiles(load_manifest("s3"))
        self.assertTrue(disclaimed, "the composer disclaims nothing")
        self.assertTrue(disclaimed <= owned, f"{disclaimed - owned} is disclaimed but nothing owns it")
        for entry in load_manifest("emulate")["disclaims"]:
            with self.subTest(profile=entry["profile"]):
                self.assertEqual("aws", entry["port"])

    def test_declared_world_requirements_match_what_the_projections_use(self) -> None:
        """`world.requires` is each service saying which part of the world it needs.

        It was declared from the beginning and nothing ever checked it, so it
        drifted: `mail` did not name finance although invoice mail is added to
        the mailbox it seeds, and `http-targets` named neither the communication
        nor the finance nor the support records its own pages are built from.

        This derives the truth instead of trusting the file. It builds the world
        once with every domain, then once per domain with that domain removed,
        and compares the bytes of each projection. A projection whose bytes
        change without a domain draws content from it, and the service that
        reads that projection has to say so.

        The check is what makes `build --for` trustworthy: the pack set is
        computed from these declarations, so an under-declared service would
        quietly receive a world with its records missing.
        """
        import hashlib
        import sys

        sys.path.insert(0, str(ROOT / "compiler"))
        from worldfixture_compiler.compiler import PACK_SOURCES, compile_world, load_world, prune_world

        source_path = ROOT / "worlds/business.saas-company.v3/world.json"
        if not source_path.is_file():
            self.skipTest("no v3 world source")
        source, _provenance = load_world(source_path)
        every = set(PACK_SOURCES)

        def projections(keep):
            compiled = compile_world(prune_world(source, set(keep)))
            return {
                name: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
                for name, value in compiled["projections"].items()
                if value is not None
            }

        full = projections(every)
        used: dict[str, set[str]] = {name: {"identity"} for name in full}
        for pack in sorted(every - {"identity"}):
            without = projections(every - {pack})
            for name in full:
                if without.get(name) != full[name]:
                    used[name].add(pack)

        for service in SERVICES:
            manifest = load_manifest(service)
            declared = {name.split(".")[0] for name in manifest["world"].get("requires", [])}
            files = [entry["file"] for entry in manifest["world"].get("projections", [])]
            needed: set[str] = set()
            for file in files:
                stem = file.removeprefix("projections/").removesuffix(".json")
                needed |= used.get(stem, set())
            if not needed:
                continue
            with self.subTest(service=service):
                self.assertEqual(
                    needed,
                    declared,
                    f"{service} reads {files} which draws from {sorted(needed)}, "
                    f"but its world.requires names {sorted(declared)}",
                )

    def test_every_profile_offers_at_least_one_binding_attribute(self) -> None:
        """An environment binds `<profile>/<attribute>`. A profile exposing no
        attribute cannot be bound to, so naming it buys an application nothing."""
        for service in SERVICES:
            for entry in load_manifest(service)["provides"]:
                with self.subTest(service=service, profile=entry["profile"]):
                    self.assertTrue(entry.get("binds"))

    # -- helpers ---------------------------------------------------------

    def artifact(self) -> Path:
        return ROOT / "dist/business.saas-company.v2"

    def artifact_projections(self):
        if not self.artifact().is_dir():
            # NAME THE WORLD. This said "run `worldfixture_compiler build` first"
            # and the README's documented build command compiles v3, so somebody
            # following the documentation built a world, ran the tests, and these
            # two skipped anyway with a message implying they had not.
            self.skipTest(
                f"no built artifact at {self.artifact().relative_to(ROOT)}; build it with "
                "`PYTHONPATH=compiler python3 -m worldfixture_compiler build "
                "worlds/business.saas-company.v2/world.json --output dist/business.saas-company.v2`"
            )
        for service in SERVICES:
            for entry in load_manifest(service)["world"].get("projections", []):
                yield service, entry

    def test_only_one_service_claims_the_s3_object_capability(self) -> None:
        """One provider's mutable state must not sit behind two route owners.

        The lock can only refuse a second owner if the manifests disagree about
        who owns S3. `@emulators/aws` serves a live, writable `/s3/` regardless
        -- measured against a running composer, not assumed -- so this
        declaration is the whole of the guarantee and must not be widened
        without closing that route.
        """
        owners = [s for s in SERVICES if any(p.startswith("aws.s3.") for p in profiles(load_manifest(s)))]
        self.assertEqual(["s3"], owners)

    def test_cyrus_and_gmail_are_declared_as_different_capabilities(self) -> None:
        """They carry the same person's mail on purpose and are not rivals.

        A resolver keyed on capability names must be able to select both at
        once, so their profile names must not collide.
        """
        cyrus = profiles(load_manifest("mail"))
        gmail = profiles(load_manifest("emulate"))
        self.assertIn("mail.imap.v1", cyrus)
        self.assertIn("google.gmail.v1", gmail)
        self.assertEqual(set(), cyrus & gmail)

    def test_no_two_services_claim_the_same_profile(self) -> None:
        seen: dict[str, str] = {}
        for service in SERVICES:
            for profile in profiles(load_manifest(service)):
                self.assertNotIn(profile, seen, f"{profile} claimed by {seen.get(profile)} and {service}")
                seen[profile] = service

    def test_reset_mechanisms_match_the_interfaces_that_now_exist(self) -> None:
        """Reset is exact by restore for the composer and deterministic restart elsewhere."""
        mechanisms = {}
        preserved = {"postgres", "mysql"}
        for service in SERVICES:
            lifecycle = load_manifest(service)["lifecycle"]
            self.assertEqual(service not in preserved, lifecycle["reset"], service)
            self.assertFalse(lifecycle["recoverable_changes"], service)
            mechanisms[service] = lifecycle["reset_mechanism"]
        self.assertEqual(
            {
                "emulate": "restore",
                "http-targets": "restart",
                "mail": "restart",
                "s3": "restart",
                "postgres": "restart",
                "mysql": "restart",
            },
            mechanisms,
        )

        composer = load_manifest("emulate")["lifecycle"]["state"]
        self.assertTrue(composer["export"])
        self.assertTrue(composer["import"])
        self.assertEqual("worldfixture.emulate-snapshot/v1", composer["format"])
        for service in ("http-targets", "mail", "s3"):
            state = load_manifest(service)["lifecycle"]["state"]
            self.assertFalse(state["export"])
            self.assertFalse(state["import"])
        for service in preserved:
            state = load_manifest(service)["lifecycle"]["state"]
            self.assertEqual([], state["clear_paths"])

    def test_every_published_composer_port_declares_its_bind_variable(self) -> None:
        manifest = load_manifest("emulate")
        for port in manifest["runtime"]["ports"]:
            if port["published"]:
                self.assertEqual(
                    f"WORLDFIXTURE_BIND_{port['name'].upper()}",
                    port.get("bind_env"),
                    port["name"],
                )

    def test_only_the_composer_claims_to_verify_its_projection(self) -> None:
        """`emulate` compares the overlay's sha256 and length against the
        artifact manifest and refuses to start on a mismatch. The other three
        entry points never read `manifest.json`, so they must not claim it."""
        verifying = [s for s in SERVICES if load_manifest(s)["lifecycle"]["verify"]]
        self.assertEqual(["emulate"], verifying)

    def test_no_manifest_carries_the_legacy_product_name(self) -> None:
        for service in SERVICES:
            with self.subTest(service=service):
                self.assertNotIn("droplive", json.dumps(load_manifest(service)).lower())


if __name__ == "__main__":
    unittest.main()
