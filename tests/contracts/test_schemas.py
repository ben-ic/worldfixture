"""The published `worldfixture.*` schemas agree with what the compiler emits.

The compiler has no third-party dependencies, so these tests do not run a full
JSON Schema implementation unless `jsonschema` happens to be installed. What
they always check is the part that drifts in practice: that the schemas name the
same contracts, keys, and patterns the compiler actually writes.
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler import build_world

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
SOURCE = ROOT / "worlds/business.saas-company.v2/world.json"


def load_schema(name: str) -> dict:
    return json.loads((SCHEMAS / f"{name}.v1.schema.json").read_text())


def build_artifact(output: Path) -> tuple[dict, dict]:
    build_world(SOURCE, output)
    return (
        json.loads((output / "world.json").read_text()),
        json.loads((output / "manifest.json").read_text()),
    )


class SchemaContractTest(unittest.TestCase):
    def test_every_schema_is_self_describing_and_publicly_named(self) -> None:
        for name in (
            "world-definition", "world-artifact", "service-manifest", "environment", "environment-lock",
            "project",
            "connector-discovery", "connector-request", "connector-event", "connector-plan",
            "connector-receipt", "connector-status",
        ):
            with self.subTest(schema=name):
                schema = load_schema(name)
                self.assertEqual("https://json-schema.org/draft/2020-12/schema", schema["$schema"])
                self.assertEqual(f"https://worldfixture.dev/schemas/{name}.v1.schema.json", schema["$id"])
                self.assertTrue(schema["title"].startswith("WorldFixture "))
                self.assertNotIn("droplive", json.dumps(schema).lower())

    def test_the_schemas_publish_the_worldfixture_contract_namespace(self) -> None:
        self.assertEqual(
            "worldfixture.world-source/v1",
            load_schema("world-definition")["properties"]["api_version"]["const"],
        )
        self.assertEqual(
            "worldfixture.world-artifact/v1",
            load_schema("world-artifact")["properties"]["api_version"]["const"],
        )
        self.assertEqual(
            "worldfixture.service/v1",
            load_schema("service-manifest")["properties"]["api_version"]["const"],
        )
        self.assertEqual(
            "worldfixture.environment/v1",
            load_schema("environment")["properties"]["api_version"]["const"],
        )
        self.assertEqual(
            "worldfixture.environment-lock/v1",
            load_schema("environment-lock")["properties"]["api_version"]["const"],
        )
        self.assertEqual(
            "worldfixture.project/v1",
            load_schema("project")["properties"]["api_version"]["const"],
        )
        connector_contracts = {
            "connector-discovery": "worldfixture.connector/v1",
            "connector-request": "worldfixture.connector-request/v1",
            "connector-event": "worldfixture.application-event/v1",
            "connector-plan": "worldfixture.connector-plan/v1",
            "connector-receipt": "worldfixture.connector-receipt/v1",
            "connector-status": "worldfixture.connector-status/v1",
        }
        for name, api_version in connector_contracts.items():
            with self.subTest(schema=name):
                self.assertEqual(api_version, load_schema(name)["properties"]["api_version"]["const"])

    def test_the_compiled_world_satisfies_the_world_definition_schema(self) -> None:
        schema = load_schema("world-definition")
        with tempfile.TemporaryDirectory() as directory:
            world, _manifest = build_artifact(Path(directory))

        for key in schema["required"]:
            self.assertIn(key, world, key)
        self.assertEqual(schema["properties"]["api_version"]["const"], world["api_version"])
        self.assertRegex(world["id"], schema["properties"]["id"]["pattern"])
        self.assertRegex(world["version"], schema["properties"]["version"]["pattern"])
        self.assertIn(world["profile"], schema["properties"]["profile"]["enum"])
        self.assertIn(world["scenario"]["class"], schema["properties"]["scenario"]["properties"]["class"]["enum"])

    def test_the_artifact_manifest_satisfies_the_world_artifact_schema(self) -> None:
        schema = load_schema("world-artifact")
        with tempfile.TemporaryDirectory() as directory:
            _world, manifest = build_artifact(Path(directory))

        for key in schema["required"]:
            self.assertIn(key, manifest, key)
        self.assertEqual(schema["properties"]["api_version"]["const"], manifest["api_version"])
        self.assertIn(manifest["build_mode"], schema["properties"]["build_mode"]["enum"])
        self.assertTrue(manifest["synthetic"])

        sha256 = schema["$defs"]["sha256"]["pattern"]
        self.assertRegex(manifest["artifact_sha256"], sha256)
        self.assertRegex(manifest["source_sha256"], sha256)
        for group in ("files", "source_files"):
            for name, entry in manifest[group].items():
                self.assertRegex(entry["sha256"], sha256, f"{group}.{name}")
                self.assertGreaterEqual(entry["size"], 0, f"{group}.{name}")

    def test_the_world_definition_schema_keeps_the_core_envelope_small(self) -> None:
        # The core envelope must not require one profile's records. Business
        # records are required only under the profile branch.
        schema = load_schema("world-definition")
        for key in ("organizations", "people", "finance", "software", "work", "communication"):
            self.assertNotIn(key, schema["required"], key)

        self.assertNotIn("allOf", schema)
        self.assertNotIn("github_login", schema["properties"]["people"]["items"]["required"])
        self.assertNotIn("slack_id", schema["properties"]["people"]["items"]["required"])

    def test_the_service_manifest_schema_refuses_a_mutable_image_reference(self) -> None:
        schema = load_schema("service-manifest")
        pattern = schema["properties"]["runtime"]["properties"]["image"]["pattern"]

        self.assertRegex("ghcr.io/example/slack@sha256:" + "a" * 64, pattern)
        self.assertNotRegex("ghcr.io/example/slack:latest", pattern)

    def test_the_service_manifest_schema_accepts_the_designed_slack_service(self) -> None:
        # The service the manifest contract was designed against, as data: a
        # multi-profile Slack service on a digest-pinned image.
        manifest = {
            "api_version": "worldfixture.service/v1",
            "name": "slack",
            "version": "1.0.0",
            "runtime": {
                "image": "ghcr.io/example/slack@sha256:" + "b" * 64,
                "readiness": {"port": "api", "path": "/readyz", "protocol": "http"},
            },
            "provides": [
                {"profile": "slack.messaging.v1"},
                {"profile": "slack.oauth.v1"},
                {"profile": "worldfixture.recoverable-changes.v1"},
            ],
            "world": {
                "requires": ["identity.people.v1", "communication.channels.v1"],
                "projection": "projections/slack.json",
            },
            "events": {
                "consumes": ["communication.message.arrives.v1"],
                "produces": ["communication.message.sent.v1"],
            },
            "lifecycle": {
                "seed": True,
                "reset": True,
                "verify": True,
                "recoverable_changes": True,
                "state": {"export": True, "import": True, "format": "emulate-slack/v1"},
            },
            "ui": {"port": "api", "path": "/_worldfixture", "title": "Slack"},
        }
        schema = load_schema("service-manifest")

        for key in schema["required"]:
            self.assertIn(key, manifest, key)
        self.assertRegex(manifest["name"], schema["properties"]["name"]["pattern"])
        self.assertRegex(manifest["version"], schema["properties"]["version"]["pattern"])
        self.assertRegex(manifest["runtime"]["image"], schema["properties"]["runtime"]["properties"]["image"]["pattern"])
        profile_pattern = schema["properties"]["provides"]["items"]["properties"]["profile"]["pattern"]
        for provided in manifest["provides"]:
            self.assertRegex(provided["profile"], profile_pattern)
        self.assertRegex(
            manifest["world"]["projection"],
            schema["properties"]["world"]["properties"]["projection"]["pattern"],
        )

        import jsonschema
        jsonschema.validate(manifest, schema)


class TrackedTreeTest(unittest.TestCase):
    """Nothing that ships cites a document that does not ship with it.

    `.private` is ignored and is never published, so a tracked file that names a
    design note under it as its reason is telling a reader to go and read a file
    they cannot have. The rule is that the reason goes in the comment.

    The bare filenames are just as unreachable as the paths. A comment saying a
    design note "requires" something is worse than one that states the
    requirement, because the reader cannot check it and cannot find it, so the
    four note names are refused wherever they appear and not only after a
    directory prefix.

    Three files are exempt, because for them the ignored path is the subject
    rather than the citation: the two ignore files, whose whole job is to name
    it, and the release checklist, which tells the maintainer what to take out
    of the git history before the first push and cannot do that without saying
    which path.

    The patterns are assembled rather than written out, so that this file does
    not fail its own assertions.
    """

    IGNORE_FILES = {".gitignore", ".dockerignore", "docs/release-checklist.md"}
    # `wrap.privateJwk` and `ghApp.private_key` are attribute access, not paths,
    # so the match is anchored on both separators.
    PRIVATE_PATH = re.compile(r"(?<![A-Za-z0-9_])\." + "private" + "/")
    PRIVATE_NOTES = re.compile("|".join(
        re.escape("-".join(parts) + "." + "md") for parts in (
            ("system", "design"),
            ("product", "experience"),
            ("service", "manifest", "fit"),
            ("extraction", "status"),
        )
    ))

    def tracked_files(self) -> list[str]:
        try:
            listing = subprocess.run(
                ["git", "ls-files", "-z"],
                cwd=ROOT, capture_output=True, check=True, text=True,
            )
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout; nothing to enumerate")
        return [name for name in listing.stdout.split("\0") if name]

    def offenders(self, pattern) -> list[str]:
        found = []
        for name in self.tracked_files():
            if name in self.IGNORE_FILES:
                continue
            path = ROOT / name
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if pattern.search(line):
                    found.append(f"{name}:{number}")
        return found

    def test_no_tracked_file_cites_a_private_path(self) -> None:
        self.assertEqual(
            [], self.offenders(self.PRIVATE_PATH),
            "state the reason inline instead of citing an ignored path",
        )

    def test_no_tracked_file_cites_an_unpublished_design_note(self) -> None:
        self.assertEqual(
            [], self.offenders(self.PRIVATE_NOTES),
            "state the finding inline instead of citing a note that is not published",
        )


if __name__ == "__main__":
    unittest.main()
