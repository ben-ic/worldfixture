"""Parity between the extracted compiler and the reviewed reference artifact.

The reference artifact is not committed. Its per-file digests are, which is
enough to prove two things without shipping the reference bytes:

1. Every file the extraction did not migrate is still byte-identical.
2. The two files it did migrate differ by exactly the declared migration. The
   test reverses the migration and reproduces the reference digest, so no world
   fact can drift behind the namespace rename.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from worldfixture_compiler import build_world, bundle_world
from worldfixture_compiler.compiler import canonical_json, sha256

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "worlds/business.saas-company.v2/world.json"
BASELINE = json.loads((Path(__file__).parent / "business.saas-company.v2.baseline.json").read_text())


def revert_namespace(node):
    """Undo the `droplive` -> `worldfixture` rename of the public contract.

    THIS IS A DECLARED MIGRATION, not a drift. The originating product's name
    appeared in data every consumer reads: 602 organization domains and person
    addresses under `.droplive.test`, ~190 `droplive_*` field names carried in
    provider API responses, the agent projection's contract string, and the
    composer's scheduled-arrivals seed key. Renaming them is a breaking contract
    change and costs least before anyone depends on it.

    IT REVERSES ON THE PARSED JSON, NOT ON THE BYTES, and that distinction is the
    whole reason this function exists rather than a string replacement. Every
    projection is canonical JSON with sorted keys, so `droplive_person_id` sorted
    before `email` and `worldfixture_person_id` sorts after `name`. The rename
    therefore moves keys as well as renaming them, and a byte-level revert
    reproduces the right characters in the wrong order. Re-serializing through
    `canonical_json` puts the reference's ordering back.

    Reversing this rename reproduces all 23 unmigrated reference files exactly,
    which is what proves no world fact moved behind the rename.
    """
    if isinstance(node, dict):
        reverted = {}
        for key, value in node.items():
            if key.startswith("worldfixture_"):
                key = "droplive_" + key[len("worldfixture_") :]
            elif key == "worldfixture":
                key = "droplive"
            reverted[key] = revert_namespace(value)
        return reverted
    if isinstance(node, list):
        return [revert_namespace(item) for item in node]
    if isinstance(node, str):
        if node.startswith("worldfixture_"):
            return "droplive_" + node[len("worldfixture_") :]
        return node.replace(".worldfixture.test", ".droplive.test").replace(
            "worldfixture.agent-world/v1", "droplive.agent-world/v1"
        )
    return node


def reference_bytes(data: bytes) -> bytes:
    """The reference form of one built file: this rename reversed, canonically."""
    return canonical_json(revert_namespace(json.loads(data)))


def build() -> dict[str, bytes]:
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory)
        build_world(SOURCE, output)
        return {path.relative_to(output).as_posix(): path.read_bytes() for path in output.rglob("*") if path.is_file()}


class ReferenceParityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.files = build()

    def test_the_build_matches_the_recorded_worldfixture_baseline(self) -> None:
        expected = BASELINE["worldfixture"]["files"]

        self.assertEqual(sorted(expected), sorted(self.files))
        for name, data in sorted(self.files.items()):
            self.assertEqual(expected[name]["size"], len(data), name)
            self.assertEqual(expected[name]["sha256"], hashlib.sha256(data).hexdigest(), name)

    def test_the_transport_bundle_matches_the_recorded_worldfixture_baseline(self) -> None:
        expected = BASELINE["worldfixture"]
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "world.tar"
            result = bundle_world(SOURCE, archive)

        self.assertEqual(expected["bundle_sha256"], result["artifact_sha256"])
        self.assertEqual(expected["bundle_size"], result["artifact_size"])
        self.assertEqual(expected["content_sha256"], result["content_sha256"])

    def test_unmigrated_files_differ_only_by_the_namespace_rename(self) -> None:
        """These files carry no migration of their own.

        They were byte-identical to the reference until the originating
        product's name was renamed out of the public contract. Reversing that one
        mechanical rename has to reproduce every one of them exactly; anything
        else would mean a world fact moved while the name did.
        """
        reference = BASELINE["reference"]["files"]
        unchanged = BASELINE["unchanged_files"]

        self.assertEqual(21, len(unchanged))
        for name in unchanged:
            self.assertEqual(
                reference[name]["sha256"],
                hashlib.sha256(reference_bytes(self.files[name])).hexdigest(),
                name,
            )

    def test_every_difference_from_the_reference_is_a_declared_migration(self) -> None:
        """Once the namespace rename is reversed, only the five declared
        per-file migrations may remain. The rename itself is declared separately
        under `namespace_migration` because it is not a property of one file."""
        reference = BASELINE["reference"]["files"]
        declared = set(BASELINE["migration"])
        self.assertIn("namespace_migration", BASELINE)

        added = {name for name, migration in BASELINE["migration"].items() if migration.get("added_file")}
        differing = added | {
            name
            for name, data in self.files.items()
            if name not in added
            if reference[name]["sha256"] != hashlib.sha256(reference_bytes(data)).hexdigest()
        }
        self.assertEqual(declared, differing)

    def test_reversing_the_world_migration_reproduces_the_reference_world(self) -> None:
        migration = BASELINE["migration"]["world.json"]
        world = json.loads(self.files["world.json"])

        self.assertEqual(migration["api_version"]["to"], world["api_version"])
        for key, value in migration["added_keys"].items():
            self.assertEqual(value, world[key])

        reverted = {key: value for key, value in world.items() if key not in migration["added_keys"]}
        reverted["api_version"] = migration["api_version"]["from"]

        self.assertEqual(
            BASELINE["reference"]["files"]["world.json"]["sha256"],
            sha256(canonical_json(revert_namespace(reverted))),
        )

    def test_reversing_the_finance_migration_reproduces_the_reference_pack(self) -> None:
        """The finance pack gained the accounts its documents already named.

        Every invoice carries a `customer_id` and every bill a `supplier_id`, and
        the records those keys name were in the world source but were never
        projected into the pack. A connector reading the pack got an opaque key:
        no name, no billing terms, and no way to reach the organization in
        `identity`. Exporting `customers` and `suppliers` closes that chain.

        Reversing the migration -- dropping exactly those two collections --
        has to reproduce the reference digest, which is what proves no existing
        finance record moved when they were added.
        """
        name = "packs/finance.json"
        migration = BASELINE["migration"][name]
        finance = json.loads(self.files[name])

        for key in migration["added_keys"]:
            self.assertIn(key, finance)

        reverted = {key: value for key, value in finance.items() if key not in migration["added_keys"]}

        self.assertEqual(
            BASELINE["reference"]["files"][name]["sha256"],
            sha256(canonical_json(revert_namespace(reverted))),
        )

    def test_reversing_the_slack_token_migration_reproduces_the_reference_overlay(self) -> None:
        name = "projections/emulator-overlay.json"
        migration = BASELINE["migration"][name]
        overlay = json.loads(self.files[name])
        change = migration["changed_keys"]["tokens.slack_token.login"]

        self.assertEqual(change["to"], overlay["tokens"]["slack_token"]["login"])

        reverted = json.loads(self.files[name])
        reverted["tokens"] = {
            token: value
            for token, value in reverted["tokens"].items()
            if not token.startswith(migration["added_key_prefix"].removeprefix("tokens."))
        }
        reverted["tokens"]["slack_token"]["login"] = change["from"]
        for channel in reverted["slack"]["channels"]:
            for key in migration["channel_keys_added"]:
                channel.pop(key, None)
        for repo in reverted["github"]["repos"]:
            for key in migration["github_repo_keys_added"]:
                repo.pop(key, None)
        for key in migration.get("provider_keys_added", []):
            reverted.pop(key, None)
        for key in migration.get("token_keys_added", []):
            reverted["tokens"].pop(key, None)
        for prefix in migration.get("token_key_prefixes_added", []):
            reverted["tokens"] = {
                key: value for key, value in reverted["tokens"].items() if not key.startswith(prefix)
            }
        # Stripe gained deterministic object ids, the `recurring` interval a
        # subscription price must have, and the `subscriptions` and `invoices` a
        # subscription business obviously has. The overlay carries the same
        # additions, so the same reversal applies here.
        # The overlay also began carrying `worldfixture_customer_id`, which the
        # standalone projection always had and the emulator seed did not.
        stripe_migration = BASELINE["migration"]["projections/stripe.json"]
        dropped = set(stripe_migration["added_fields"]) | {"worldfixture_customer_id"}
        reverted["stripe"] = {
            key: [{k: v for k, v in item.items() if k not in dropped} for item in value]
            for key, value in reverted["stripe"].items()
            if key not in stripe_migration["added_keys"]
        }

        # The AWS vendor's S3 block was removed, so put the reference shape back.
        reference_aws = json.loads(self.files["projections/aws.json"])["s3"]
        reverted["aws"]["s3"] = {
            "buckets": [
                {k: v for k, v in bucket.items() if not k.startswith("droplive_")}
                for bucket in reference_aws["buckets"]
            ]
        }

        self.assertEqual(
            BASELINE["reference"]["files"][name]["sha256"],
            sha256(canonical_json(revert_namespace(reverted))),
        )

    def test_reversing_the_http_targets_migration_reproduces_the_reference_projection(self) -> None:
        name = "projections/http-targets.json"
        migration = BASELINE["migration"][name]
        projection = json.loads(self.files[name])

        self.assertEqual(migration["api_version"]["to"], projection["api_version"])

        # The contract string is the whole migration. Putting the legacy one back has
        # to reproduce the reference bytes exactly, which is what proves no HTTP
        # target, route, probe sequence or API response moved behind the rename.
        reverted = json.loads(self.files[name])
        reverted["api_version"] = migration["api_version"]["from"]

        self.assertEqual(
            BASELINE["reference"]["files"][name]["sha256"],
            sha256(canonical_json(revert_namespace(reverted))),
        )

    def test_reversing_the_s3_migration_reproduces_the_reference_projection(self) -> None:
        name = "projections/aws.json"
        migration = BASELINE["migration"][name]
        projection = json.loads(self.files[name])

        self.assertTrue(projection["s3"]["objects"], "the documents bucket should not be empty")
        # The exports bucket stays empty on purpose: no world record declares an
        # object in it, and the compiler must not invent one from a task's prose.
        buckets = {bucket["name"] for bucket in projection["s3"]["buckets"]}
        seeded = {obj["bucket"] for obj in projection["s3"]["objects"]}
        self.assertIn("northstar-relay-exports", buckets - seeded)

        reverted = json.loads(self.files[name])
        for key in migration["s3_keys_added"]:
            reverted["s3"].pop(key, None)

        self.assertEqual(
            BASELINE["reference"]["files"][name]["sha256"],
            sha256(canonical_json(revert_namespace(reverted))),
        )

    def test_the_manifest_only_migrates_its_contract_and_derived_provenance(self) -> None:
        migration = BASELINE["migration"]["manifest.json"]
        manifest = json.loads(self.files["manifest.json"])

        self.assertEqual(migration["api_version"]["to"], manifest["api_version"])
        self.assertEqual("business.operations/v1", manifest["profile"])

        # Everything the manifest states about itself is still true of the bytes.
        for name, expected in manifest["files"].items():
            self.assertEqual(expected["size"], len(self.files[name]), name)
            self.assertEqual(expected["sha256"], hashlib.sha256(self.files[name]).hexdigest(), name)
        self.assertEqual(
            manifest["artifact_sha256"],
            sha256(canonical_json({name: manifest["files"][name] for name in sorted(manifest["files"])})),
        )

        # `derived_keys` used to be prose that nothing read, and it silently fell
        # out of date. Hold it to the manifest entries that actually differ.
        reference_manifest_files = {
            name: entry
            for name, entry in BASELINE["reference"]["files"].items()
            if name != "manifest.json"
        }
        differing = {
            f"files.{name}.{field}"
            for name, entry in reference_manifest_files.items()
            for field in ("sha256", "size")
            if manifest["files"][name][field] != entry[field]
        }
        for name in set(manifest["files"]) - set(reference_manifest_files):
            differing.update({f"files.{name}.sha256", f"files.{name}.size"})
        declared = {key for key in migration["derived_keys"] if key.startswith("files.")}
        self.assertEqual(declared, differing)

        # The scenario and pack shape the reference published are unchanged.
        reference_scenario = {"id": "normal-operations", "class": "normal"}
        self.assertEqual(reference_scenario["id"], manifest["scenario"]["id"])
        self.assertEqual(reference_scenario["class"], manifest["scenario"]["class"])
        self.assertEqual(
            ["communication", "finance", "identity", "software", "support", "work"],
            manifest["packs"],
        )


if __name__ == "__main__":
    unittest.main()
